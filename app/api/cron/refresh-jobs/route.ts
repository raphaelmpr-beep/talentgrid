import { NextResponse, type NextRequest } from "next/server";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";
import {
  createTheirStackClient,
  mapJobToRole,
  fetchCareersPortalJobs,
  TheirStackNotConfiguredError,
  type TheirStackJob,
  type CareersPortalJob,
} from "@/lib/feeds/providers";
import { fetchJobSpyJobs } from "@/lib/jobs/jobspy";
import {
  classifyRoleCategory,
  classifyDomainCategory,
} from "@/lib/feeds/classify";
import {
  refreshJobsQuerySchema,
  type RefreshJobsQuery,
} from "@/lib/validators/feed";

export const runtime = "nodejs";
// Vercel cron sends GET requests; we also accept POST for manual triggering.
export const dynamic = "force-dynamic";

type MonitoredCompany = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
};

type RefreshCompanyReport = {
  company_id: string;
  name: string;
  theirstack_jobs: number;
  careers_portal_attempted: boolean;
  careers_portal_jobs: number;
  careers_portal_reason?: string;
  jobspy_fallback: boolean;
  jobspy_jobs: number;
  merged: number;
  upserted: number;
  deactivated: number;
  // True when the per-company wall-clock budget was hit; the company is counted
  // as errored but the batch continues. Distinct from `errors`, which captures
  // recoverable per-source failures.
  timed_out: boolean;
  errors: string[];
};

type RefreshReport = {
  dryRun: boolean;
  theirstack_configured: boolean;
  // Direct careers-portal source needs no API key — it fetches the company's
  // own careers/ATS URL — so it is always available when a company has one.
  careers_portal_available: boolean;
  jobspy_configured: boolean;
  // Echo of the bounded-batch window the caller requested, plus the total
  // matching universe so the caller can page (offset += limit) until
  // offset >= monitored_total.
  limit: number;
  offset: number;
  monitored_total: number;
  monitored_companies: number;
  processed: number;
  skipped: number;
  errored: number;
  // Counts of companies whose careers/TheirStack source was actually exercised
  // in this batch, so a live test can confirm both providers are wired.
  careers_portal_companies: number;
  theirstack_companies: number;
  has_more: boolean;
  next_offset: number | null;
  companies: RefreshCompanyReport[];
  total_theirstack: number;
  total_careers_portal: number;
  total_jobspy: number;
  total_upserted: number;
  total_deactivated: number;
  errors: string[];
};

// Per-company wall-clock budget. A dead careers portal or hung TheirStack call
// for one company must not consume the whole Vercel invocation; once a company
// exceeds this it is recorded as a warning and the batch moves on. Set a little
// above the provider-level timeouts (8s each) so a normal slow company isn't
// cut off mid-flight.
const COMPANY_BUDGET_MS = 20000;

// Pull the careers/ATS portal URLs the import utility stored in
// companies.metadata. Returns nulls when absent.
function careersUrlsFor(company: MonitoredCompany): {
  careersUrl: string | null;
  jobPortalUrl: string | null;
} {
  const meta = company.metadata ?? {};
  const careersUrl =
    typeof meta.careers_url === "string" && meta.careers_url.trim() ? meta.careers_url : null;
  const jobPortalUrl =
    typeof meta.job_portal_url === "string" && meta.job_portal_url.trim()
      ? meta.job_portal_url
      : null;
  return { careersUrl, jobPortalUrl };
}

// Map a careers-portal job into the same role row shape used for TheirStack,
// so the upsert path is identical. external_id is stable across runs.
function mapCareersPortalJobToRole(job: CareersPortalJob) {
  return {
    external_id: job.external_id,
    title: job.title,
    description: null as string | null,
    location: job.location,
    remote: false,
    employment_type: null as string | null,
    seniority: null as string | null,
    salary_min: null as number | null,
    salary_max: null as number | null,
    url: job.url,
    source: "careers_portal" as const,
    posted_at: null as string | null,
    metadata: { external_id: job.external_id, source_url: job.source_url },
    is_active: true as const,
  };
}

// Auth: prefer CRON_SECRET (Vercel cron sends it as a Bearer token via the
// `Authorization` header / `?secret=`); fall back to FEED_ADMIN_SECRET so the
// endpoint reuses the existing admin gate convention. Dry-runs are always safe
// and do not require a secret.
function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  const adminSecret = process.env.FEED_ADMIN_SECRET;
  const expected = cronSecret ?? adminSecret;
  if (!expected) return false;

  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${expected}`) return true;
  if (req.headers.get("x-cron-secret") === expected) return true;
  if (req.headers.get("x-feed-admin-secret") === expected) return true;
  if (req.nextUrl.searchParams.get("secret") === expected) return true;
  return false;
}

// Resolve the single-company targeting filters into the slug we should match,
// if any. slug/atsSlug both map to companies.metadata.ats_slug (jsonb) — there
// is no top-level slug column.
function targetSlug(query: RefreshJobsQuery): string | null {
  return query.atsSlug ?? query.slug ?? null;
}

// Minimal view of the PostgREST filter builder. Decoupling from Supabase's
// fully-recursive generic type here keeps `applyMonitorFilters` from triggering
// "Type instantiation is excessively deep" on the chained count/page queries.
interface MonitorFilterBuilder {
  eq(column: string, value: unknown): MonitorFilterBuilder;
  ilike(column: string, pattern: string): MonitorFilterBuilder;
}

// Apply the monitor + single-company targeting filters shared by the count and
// page queries so both requests stay in sync.
function applyMonitorFilters(
  builder: MonitorFilterBuilder,
  query: RefreshJobsQuery
): MonitorFilterBuilder {
  let b = builder.eq("monitor", true);
  if (query.companyId) b = b.eq("id", query.companyId);
  if (query.companyName) b = b.ilike("name", query.companyName);
  const slug = targetSlug(query);
  if (slug) b = b.eq("metadata->>ats_slug", slug);
  return b;
}

// Load a bounded page of monitored companies, applying any single-company
// targeting filters at the database level so we never pull the whole universe
// into memory. Returns the page plus the total matching count so the caller can
// report has_more / next_offset for paging through the universe.
async function loadMonitoredCompanies(
  supabase: NonNullable<ReturnType<typeof createFeedAdminClient>>,
  query: RefreshJobsQuery
): Promise<{ companies: MonitoredCompany[]; total: number }> {
  const countBuilder = supabase
    .from("companies")
    .select("id", { count: "exact", head: true });
  const { count } = await (applyMonitorFilters(
    countBuilder as unknown as MonitorFilterBuilder,
    query
  ) as unknown as PromiseLike<{ count: number | null }>);

  const pageBuilder = supabase
    .from("companies")
    .select("id,name,domain,industry,description,metadata");
  const filtered = applyMonitorFilters(
    pageBuilder as unknown as MonitorFilterBuilder,
    query
  ) as unknown as {
    order(column: string, opts: { ascending: boolean }): {
      range(from: number, to: number): PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
  const { data, error } = await filtered
    .order("id", { ascending: true })
    .range(query.offset, query.offset + query.limit - 1);

  if (error || !data) return { companies: [], total: count ?? 0 };
  return { companies: data as MonitoredCompany[], total: count ?? 0 };
}

function dedupeJobs(
  theirstack: TheirStackJob[],
  jobspyTitles: Array<{ title: string; description: string }>,
  companyName: string
): { theirstack: TheirStackJob[]; extraTitles: string[] } {
  const seen = new Set<string>();
  const keep: TheirStackJob[] = [];
  for (const job of theirstack) {
    const key = `${job.external_id}`.trim() ||
      `${companyName}::${job.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(job);
  }

  const titleSeen = new Set(keep.map((j) => j.title.toLowerCase().trim()));
  const extraTitles: string[] = [];
  for (const j of jobspyTitles) {
    const t = j.title.toLowerCase().trim();
    if (!t || titleSeen.has(t)) continue;
    titleSeen.add(t);
    extraTitles.push(j.title);
  }
  return { theirstack: keep, extraTitles };
}

// When TheirStack returns this many jobs or fewer, treat the company as
// under-covered and reach for the company's own careers portal.
const LOW_COVERAGE_THRESHOLD = 1;

async function refreshCompany(
  company: MonitoredCompany,
  theirStackJobs: TheirStackJob[],
  dryRun: boolean,
  supabase: ReturnType<typeof createFeedAdminClient>
): Promise<RefreshCompanyReport> {
  const report: RefreshCompanyReport = {
    company_id: company.id,
    name: company.name,
    theirstack_jobs: theirStackJobs.length,
    careers_portal_attempted: false,
    careers_portal_jobs: 0,
    jobspy_fallback: false,
    jobspy_jobs: 0,
    merged: 0,
    upserted: 0,
    deactivated: 0,
    timed_out: false,
    errors: [],
  };

  const { careersUrl, jobPortalUrl } = careersUrlsFor(company);
  const lowCoverage = theirStackJobs.length <= LOW_COVERAGE_THRESHOLD;

  // Direct careers-portal source: try first when TheirStack is thin and the
  // company has a careers/ATS URL. No API key required.
  let careersJobs: CareersPortalJob[] = [];
  if (lowCoverage && (careersUrl || jobPortalUrl)) {
    report.careers_portal_attempted = true;
    try {
      const portal = await fetchCareersPortalJobs({
        companyName: company.name,
        companyId: company.id,
        careersUrl: careersUrl ?? jobPortalUrl ?? "",
        jobPortalUrl,
      });
      careersJobs = portal.jobs;
      report.careers_portal_jobs = portal.jobs.length;
      if (portal.jobs.length === 0 && portal.reason) {
        report.careers_portal_reason = portal.reason;
      }
    } catch (err) {
      // Provider is best-effort; never let it abort the run.
      report.careers_portal_reason = "careers_portal_failed";
      report.errors.push(
        `careers_portal_failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // JobSpy fallback when both TheirStack and the careers portal come up thin.
  let jobspyTitles: Array<{ title: string; description: string }> = [];
  if (lowCoverage && careersJobs.length === 0) {
    report.jobspy_fallback = true;
    try {
      const fallback = await fetchJobSpyJobs(company.name);
      jobspyTitles = fallback.map((f) => ({ title: f.title, description: f.description }));
      report.jobspy_jobs = jobspyTitles.length;
    } catch (err) {
      report.errors.push(
        `jobspy_fallback_failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const { theirstack: deduped } = dedupeJobs(theirStackJobs, jobspyTitles, company.name);
  // Merge careers-portal jobs in, skipping titles already covered by TheirStack.
  const theirstackTitles = new Set(deduped.map((j) => j.title.toLowerCase().trim()));
  const careersDeduped = careersJobs.filter(
    (j) => !theirstackTitles.has(j.title.toLowerCase().trim())
  );
  report.merged = deduped.length + careersDeduped.length;

  if (dryRun || !supabase) {
    return report;
  }

  const companyContext = [company.industry, company.description, company.domain]
    .filter(Boolean)
    .join(" ");
  const seenTheirStackIds: string[] = [];
  const seenCareersIds: string[] = [];

  for (const job of deduped) {
    const roleMapped = mapJobToRole(job);
    const roleCategory = classifyRoleCategory(job.title, job.description ?? null);
    const domainCategory = classifyDomainCategory(
      job.title,
      job.description ?? null,
      companyContext
    );
    const { error } = await supabase.from("roles").upsert(
      {
        ...roleMapped,
        company_id: company.id,
        role_category: roleCategory,
        domain_category: domainCategory,
        is_active: true,
        last_checked_at: new Date().toISOString(),
      },
      { onConflict: "company_id,external_id" }
    );
    if (error) {
      report.errors.push(`role upsert failed (${job.external_id}): ${error.message}`);
      continue;
    }
    report.upserted += 1;
    seenTheirStackIds.push(job.external_id);
  }

  for (const job of careersDeduped) {
    const roleMapped = mapCareersPortalJobToRole(job);
    const roleCategory = classifyRoleCategory(job.title, null);
    const domainCategory = classifyDomainCategory(job.title, null, companyContext);
    const { error } = await supabase.from("roles").upsert(
      {
        ...roleMapped,
        company_id: company.id,
        role_category: roleCategory,
        domain_category: domainCategory,
        is_active: true,
        last_checked_at: new Date().toISOString(),
      },
      { onConflict: "company_id,external_id" }
    );
    if (error) {
      report.errors.push(
        `careers role upsert failed (${job.external_id}): ${error.message}`
      );
      continue;
    }
    report.upserted += 1;
    seenCareersIds.push(job.external_id);
  }

  // Deactivate stale rows per-source so a thin pull from one source never
  // clobbers rows owned by the other (or by manual entry).
  report.deactivated += await deactivateStale(
    supabase,
    company.id,
    "theirstack",
    seenTheirStackIds,
    report
  );
  report.deactivated += await deactivateStale(
    supabase,
    company.id,
    "careers_portal",
    seenCareersIds,
    report
  );

  return report;
}

// Mark active rows for one source whose external_id is absent from the latest
// pull as inactive. Skips deactivation entirely when the latest pull is empty
// (a transient fetch failure should not wipe previously-found roles).
async function deactivateStale(
  supabase: NonNullable<ReturnType<typeof createFeedAdminClient>>,
  companyId: string,
  source: string,
  seenExternalIds: string[],
  report: RefreshCompanyReport
): Promise<number> {
  if (seenExternalIds.length === 0) return 0;
  const { data: stale, error: staleErr } = await supabase
    .from("roles")
    .select("id,external_id")
    .eq("company_id", companyId)
    .eq("source", source)
    .eq("is_active", true);
  if (staleErr || !stale) return 0;
  const toDeactivate = (stale as Array<{ id: string; external_id: string | null }>)
    .filter((r) => r.external_id && !seenExternalIds.includes(r.external_id))
    .map((r) => r.id);
  let count = 0;
  for (const id of toDeactivate) {
    const { error: deErr } = await supabase
      .from("roles")
      .update({ is_active: false, last_checked_at: new Date().toISOString() })
      .eq("id", id);
    if (deErr) report.errors.push(`deactivate failed (${id}): ${deErr.message}`);
    else count += 1;
  }
  return count;
}

// Resolve a single company end-to-end: pull TheirStack, then merge/upsert via
// refreshCompany. Both providers are individually time-bounded inside; this is
// the unit we wrap with the per-company wall-clock budget.
async function processCompany(
  company: MonitoredCompany,
  client: ReturnType<typeof createTheirStackClient>,
  dryRun: boolean,
  supabase: ReturnType<typeof createFeedAdminClient>
): Promise<RefreshCompanyReport> {
  let theirStackJobs: TheirStackJob[] = [];
  const preErrors: string[] = [];
  if (client.config.configured) {
    // Prefer the domain filter (most precise). When a monitored/seeded company
    // has no domain, fall back to a case-insensitive company-name match so
    // domain-less seed records still get a TheirStack pull instead of silently
    // returning 0 jobs.
    const searchInput = company.domain
      ? { companyDomainOr: [company.domain], limit: 100 }
      : { companyNameCaseInsensitiveOr: [company.name], limit: 100 };
    try {
      const res = await client.searchJobs(searchInput);
      theirStackJobs = res.jobs;
    } catch (err) {
      if (!(err instanceof TheirStackNotConfiguredError)) {
        preErrors.push(
          `theirstack search failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  const companyReport = await refreshCompany(company, theirStackJobs, dryRun, supabase);
  companyReport.errors.unshift(...preErrors);
  return companyReport;
}

// Race a per-company refresh against a wall-clock budget so one stalled source
// can never block the whole batch. On timeout we return a report marked
// timed_out — the underlying providers already abort their own fetches, so this
// is a backstop, not the primary timeout.
async function processCompanyBounded(
  company: MonitoredCompany,
  client: ReturnType<typeof createTheirStackClient>,
  dryRun: boolean,
  supabase: ReturnType<typeof createFeedAdminClient>
): Promise<RefreshCompanyReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RefreshCompanyReport>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        company_id: company.id,
        name: company.name,
        theirstack_jobs: 0,
        careers_portal_attempted: false,
        careers_portal_jobs: 0,
        careers_portal_reason: "company_budget_exceeded",
        jobspy_fallback: false,
        jobspy_jobs: 0,
        merged: 0,
        upserted: 0,
        deactivated: 0,
        timed_out: true,
        errors: [`company_budget_exceeded after ${COMPANY_BUDGET_MS}ms`],
      });
    }, COMPANY_BUDGET_MS);
  });
  try {
    return await Promise.race([
      processCompany(company, client, dryRun, supabase),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const parsed = refreshJobsQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const query = parsed.data;
  const dryRun = query.dryRun;

  // Real (mutating) runs require a valid secret. Dry-runs are always safe.
  if (!dryRun && !isAuthorized(req)) {
    return NextResponse.json(
      {
        error:
          "unauthorized: set CRON_SECRET (or FEED_ADMIN_SECRET) and provide it via Authorization: Bearer, x-cron-secret, or ?secret=. Append ?dryRun=true for a safe no-write preview.",
      },
      { status: 401 }
    );
  }

  const client = createTheirStackClient();
  const supabase = createFeedAdminClient();
  const report: RefreshReport = {
    dryRun,
    theirstack_configured: client.config.configured,
    careers_portal_available: true,
    jobspy_configured: Boolean(process.env.JOBSPY_ENDPOINT),
    limit: query.limit,
    offset: query.offset,
    monitored_total: 0,
    monitored_companies: 0,
    processed: 0,
    skipped: 0,
    errored: 0,
    careers_portal_companies: 0,
    theirstack_companies: 0,
    has_more: false,
    next_offset: null,
    companies: [],
    total_theirstack: 0,
    total_careers_portal: 0,
    total_jobspy: 0,
    total_upserted: 0,
    total_deactivated: 0,
    errors: [],
  };

  if (!supabase) {
    report.errors.push(
      "supabase admin client not configured (set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)"
    );
    return NextResponse.json(report);
  }

  const { companies: monitored, total } = await loadMonitoredCompanies(supabase, query);
  report.monitored_total = total;
  report.monitored_companies = monitored.length;
  report.has_more = query.offset + monitored.length < total;
  report.next_offset = report.has_more ? query.offset + query.limit : null;

  if (monitored.length === 0) {
    report.errors.push(
      total === 0
        ? "no monitored companies match the requested filters (set companies.monitor = true to enrol)"
        : "offset is beyond the matching set; nothing to process in this window"
    );
    return NextResponse.json(report);
  }

  for (const company of monitored) {
    const companyReport = await processCompanyBounded(company, client, dryRun, supabase);
    report.companies.push(companyReport);
    report.total_theirstack += companyReport.theirstack_jobs;
    report.total_careers_portal += companyReport.careers_portal_jobs;
    report.total_jobspy += companyReport.jobspy_jobs;
    report.total_upserted += companyReport.upserted;
    report.total_deactivated += companyReport.deactivated;

    report.processed += 1;
    if (companyReport.theirstack_jobs > 0) report.theirstack_companies += 1;
    if (companyReport.careers_portal_attempted) report.careers_portal_companies += 1;
    if (companyReport.timed_out || companyReport.errors.length > 0) {
      report.errored += 1;
    }
  }

  // `skipped` reflects monitored companies in the matching set that this bounded
  // window did not touch (the caller pages through them via next_offset).
  report.skipped = Math.max(0, total - (query.offset + report.processed));

  return NextResponse.json(report);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
