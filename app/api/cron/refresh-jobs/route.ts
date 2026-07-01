import { NextResponse, type NextRequest } from "next/server";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";
import {
  createTheirStackClient,
  mapJobToRole,
  fetchCareersPortalJobs,
  hasNamedEmployerAdapter,
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
import {
  normalizeCompanyKey,
  resolveCompanyNameAliases,
} from "@/lib/companies/search-scope";
import { decideCandidateRefresh } from "@/lib/feeds/candidate-refresh";

export const runtime = "nodejs";
// Vercel cron sends GET requests; we also accept POST for manual triggering.
export const dynamic = "force-dynamic";

type MonitoredCompany = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  description: string | null;
  // careers_url is a top-level column in the live schema (not inside metadata).
  careers_url: string | null;
  // metadata is optional — does not exist in current production DB.
  metadata: Record<string, unknown> | null;
};

type RefreshCompanyReport = {
  company_id: string;
  name: string;
  theirstack_jobs: number;
  careers_portal_attempted: boolean;
  careers_portal_jobs: number;
  // Full live inventory the source reports (e.g. Greenhouse meta.total). This is
  // the number the company's live careers site shows; it can exceed
  // careers_portal_jobs because the stored/extracted set is capped.
  careers_portal_total: number;
  // True when the ATS board was inferred from a legacy company's existing role
  // URLs (no stored careers metadata). Surfaces the repair path in the report.
  careers_portal_inferred?: boolean;
  // Resolved source path: "greenhouse" | "lever" | "workday" | "html" | "json".
  careers_portal_source?: string;
  // True when careers_portal_total is the vendor-reported exact live inventory
  // (a public ATS board API). False when it is a best-effort HTML/JSON scrape
  // sample that may undercount — surfaced so a dry-run can distinguish an
  // authoritative count (e.g. Pinterest 176) from a shallow fallback.
  careers_portal_count_exact?: boolean;
  careers_portal_reason?: string;
  // Candidate-source visibility. A validation-pending candidate (metadata
  // fetch_enabled !== true) is exercised for dry-run validation, but a real run
  // never promotes its non-exact sample to a count or active role rows. These
  // fields make the candidate-validation vs. confirmed-source-fetch distinction
  // explicit in the report so a non-exact sample can never be mistaken for a
  // live active count.
  candidate_source: boolean;
  // companies.metadata.source_status (needs_live_http_validation /
  // needs_source_mapping for candidates), echoed verbatim.
  source_status: string | null;
  // True when a real run actually wrote source_openings_total/exact + role rows
  // for this company. False when persistence was withheld (see
  // careers_portal_reason). Always false on a dry-run.
  source_openings_persisted: boolean;
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
  // Validation-pending candidates (metadata fetch_enabled !== true) seen in this
  // batch, and how many of those had an exact source persisted. The difference is
  // the set of candidates whose non-exact sample was correctly withheld — making
  // the candidate-validation vs. confirmed-source-fetch split visible at the top
  // level, not just per-company.
  candidate_companies: number;
  source_openings_persisted_companies: number;
  has_more: boolean;
  next_offset: number | null;
  companies: RefreshCompanyReport[];
  total_theirstack: number;
  total_careers_portal: number;
  // Sum of full live inventory across companies whose careers source was hit.
  // This is what should match the live careers-site counts (e.g. Pinterest 176).
  total_careers_portal_inventory: number;
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

// Upper bound on the number of role rows ingested/stored per company in a single
// run. The full board is fetched in one request for ATS sources, so this only
// bounds how many rows we persist — the company's reported source inventory
// total is always exact, independent of this sample size.
const CAREERS_SAMPLE_MAX = 500;

// Pull the careers/ATS portal URLs + ATS routing hints for a company.
// careers_url is a first-class column in the live DB schema; ATS hints live in
// companies.metadata when present — fall back gracefully when absent.
function careersUrlsFor(company: MonitoredCompany): {
  careersUrl: string | null;
  jobPortalUrl: string | null;
  atsType: string | null;
  atsSlug: string | null;
} {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  // careers_url is a first-class column in the current live schema.
  const careersUrl = str(company.careers_url);
  // Read ATS hints from metadata when present; default to null otherwise.
  const meta = company.metadata ?? {};
  const source =
    meta.company_job_source && typeof meta.company_job_source === "object"
      ? (meta.company_job_source as Record<string, unknown>)
      : {};
  return {
    careersUrl: careersUrl ?? str(meta.careers_url),
    jobPortalUrl: str(meta.job_portal_url),
    atsType: str(meta.ats_type) ?? str(source.ats_type) ?? str(source.type) ?? str(source.provider),
    atsSlug: str(meta.ats_slug) ?? str(source.ats_slug) ?? str(source.slug) ?? str(source.board),
  };
}

// Read the candidate-trust flags for a company. These were previously stored on
// companies.metadata; the current live DB does not have that column, so we read
// from it opportunistically and fall back to safe defaults.
// fetch_enabled=true for manually seeded rows that have a careers_url — they
// are known-good sources, not unvalidated third-party imports.
function candidateFlagsFor(company: MonitoredCompany): {
  fetchEnabled: boolean;
  validationEnabled: boolean;
  sourceStatus: string | null;
} {
  const meta = company.metadata ?? {};
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === "boolean" ? v : fallback;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return {
    // Default fetch_enabled=true for companies with a careers_url but no
    // metadata flags — manually seeded rows, not unvalidated candidates.
    fetchEnabled: bool(meta.fetch_enabled, Boolean(company.careers_url)),
    validationEnabled: bool(meta.validation_enabled, true),
    sourceStatus: str(meta.source_status),
  };
}

// ATS hints inferred from a legacy company's existing role URLs when its
// metadata carries no careers/ATS pointers. The careers-portal provider can
// then resolve a public board (e.g. Greenhouse via gh_jid + name-guess) and
// report the authoritative live total.
type InferredAtsHints = {
  careersUrl: string | null;
  jobPortalUrl: string | null;
  atsType: string | null;
  atsSlug: string | null;
};

// Recognised ATS host fragments and the slug position in their URL path. Used
// to derive an explicit board slug straight from a stored role URL, which is
// more reliable than name-guessing.
function atsHintsFromRoleUrl(url: string): InferredAtsHints | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split("/").filter(Boolean);

  if (host.endsWith("greenhouse.io")) {
    const boardsIdx = parts.indexOf("boards");
    const slug = boardsIdx >= 0 ? parts[boardsIdx + 1] : parts[0];
    if (slug) {
      return { careersUrl: url, jobPortalUrl: url, atsType: "greenhouse", atsSlug: slug };
    }
  }
  if (host.endsWith("lever.co")) {
    const idx = parts.indexOf("postings");
    const slug = idx >= 0 ? parts[idx + 1] : parts.find((p) => p !== "v0");
    if (slug) {
      return { careersUrl: url, jobPortalUrl: url, atsType: "lever", atsSlug: slug };
    }
  }
  // Workday: the candidate URL itself carries the tenant/site the provider needs
  // to derive the CXS endpoint (resolveAtsBoard sniffs it), so hand the URL back
  // verbatim. ats_type is recorded for the report; the slug is encoded in the URL.
  if (host.endsWith("myworkdayjobs.com")) {
    return { careersUrl: url, jobPortalUrl: url, atsType: "workday", atsSlug: null };
  }
  // A company-hosted careers page that embeds Greenhouse leaks a gh_jid marker.
  // We can't read the slug from it, but handing the URL to the provider lets its
  // name-guess + board-verify path resolve the board (e.g. pinterestcareers.com
  // → board "pinterest").
  if (parsed.search.toLowerCase().includes("gh_jid=") || url.toLowerCase().includes("gh_jid=")) {
    return { careersUrl: url, jobPortalUrl: url, atsType: null, atsSlug: null };
  }
  return null;
}

// For a targeted legacy company with no stored careers metadata, look at its
// existing role URLs to infer a public ATS board. Returns null when nothing
// usable is found. Best-effort and non-fatal.
async function inferAtsHintsFromRoles(
  supabase: NonNullable<ReturnType<typeof createFeedAdminClient>>,
  companyId: string
): Promise<InferredAtsHints | null> {
  const { data, error } = await supabase
    .from("roles")
    .select("url")
    .eq("company_id", companyId)
    .not("url", "is", null)
    .limit(50);
  if (error || !data) return null;
  const urls = (data as Array<{ url: string | null }>)
    .map((r) => r.url)
    .filter((u): u is string => typeof u === "string" && u.trim().length > 0);

  // Prefer a URL that yields an explicit board slug; fall back to a gh_jid-only
  // marker URL (provider resolves the slug by name-guess).
  let markerFallback: InferredAtsHints | null = null;
  for (const url of urls) {
    const hints = atsHintsFromRoleUrl(url);
    if (!hints) continue;
    if (hints.atsSlug) return hints;
    if (!markerFallback) markerFallback = hints;
  }
  return markerFallback;
}

// Map a careers-portal job into the same role row shape used for TheirStack,
// so the upsert path is identical. external_id is stable across runs.
// Extract posted_at from the vendor-specific raw job object.
// Priority: first_published (GH) > publishedAt (Ashby) > createdAt > updated_at.
function rawPostedAt(job: CareersPortalJob): string | null {
  const r = job.raw;
  if (!r) return null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return (
    str(r["first_published"]) ??
    str(r["publishedAt"]) ??
    str(r["createdAt"]) ??
    str(r["updated_at"]) ??
    null
  );
}

// Extract compensation from the vendor-specific raw job object.
// Greenhouse: no compensation in public board API (metadata array is custom fields).
// Ashby: compensation.summaryComponents[] — find the Salary entry for min/max.
// Lever: compensation rarely in public API, skip.
function rawCompensation(job: CareersPortalJob): {
  comp_min: number | null;
  comp_max: number | null;
  comp_currency: string | null;
  comp_period: string | null;
  comp_text: string | null;
  comp_source: string | null;
  comp_status: "disclosed" | "unavailable";
} {
  const none = {
    comp_min: null, comp_max: null, comp_currency: null,
    comp_period: null, comp_text: null, comp_source: null,
    comp_status: "unavailable" as const,
  };
  const r = job.raw;
  if (!r) return none;

  // Ashby: { compensation: { summaryComponents: [{ compensationType, interval,
  //   currencyCode, minValue, maxValue }] } }
  if (job.ats_vendor === "ashby") {
    const comp = r["compensation"];
    if (!comp || typeof comp !== "object") return none;
    const compObj = comp as Record<string, unknown>;
    // shouldDisplayCompensationOnJobPostings gates disclosure.
    if (r["shouldDisplayCompensationOnJobPostings"] === false) return none;
    const summary = Array.isArray(compObj["summaryComponents"])
      ? (compObj["summaryComponents"] as Array<Record<string, unknown>>)
      : [];
    // Pick the primary Salary component (prefer yearly).
    const salary = summary.find(
      (c) => c["compensationType"] === "Salary" && c["interval"] === "1 YEAR"
    ) ?? summary.find((c) => c["compensationType"] === "Salary");
    if (!salary) return none;
    const min = typeof salary["minValue"] === "number" ? salary["minValue"] : null;
    const max = typeof salary["maxValue"] === "number" ? salary["maxValue"] : null;
    const currency = typeof salary["currencyCode"] === "string" ? salary["currencyCode"] : "USD";
    // Ashby interval is "1 YEAR" or "1 HOUR" etc — normalise to our period.
    const intervalRaw = typeof salary["interval"] === "string" ? salary["interval"] : "";
    const period = intervalRaw.includes("HOUR") ? "hour"
      : intervalRaw.includes("MONTH") ? "month"
      : intervalRaw.includes("WEEK") ? "week"
      : "year";
    const text = typeof compObj["scrapeableCompensationSalarySummary"] === "string"
      ? compObj["scrapeableCompensationSalarySummary"] as string
      : null;
    if (min == null && max == null) return none;
    return {
      comp_min: min, comp_max: max, comp_currency: currency,
      comp_period: period, comp_text: text, comp_source: "ats_api",
      comp_status: "disclosed",
    };
  }

  return none;
}

function mapCareersPortalJobToRole(job: CareersPortalJob) {
  const comp = rawCompensation(job);
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
    // Use the vendor-specific date field; falls back to null for HTML sources.
    posted_at: rawPostedAt(job),
    // Compensation from ATS API when available (Ashby discloses structured comp).
    compensation_min:      comp.comp_min,
    compensation_max:      comp.comp_max,
    compensation_currency: comp.comp_currency,
    compensation_period:   comp.comp_period,
    compensation_text:     comp.comp_text,
    compensation_source:   comp.comp_source,
    compensation_status:   comp.comp_status,
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

// True when the caller is targeting a single company by id/name/slug. Targeted
// requests are allowed to reach non-monitored legacy rows (for repair/testing);
// an untargeted request stays monitored-only so the scheduled cron only ever
// processes the curated universe.
function isSingleCompanyTargeted(query: RefreshJobsQuery): boolean {
  return Boolean(query.companyId || query.companyName || targetSlug(query));
}

// Minimal view of the PostgREST filter builder. Decoupling from Supabase's
// fully-recursive generic type here keeps `applyMonitorFilters` from triggering
// "Type instantiation is excessively deep" on the chained count/page queries.
interface MonitorFilterBuilder {
  eq(column: string, value: unknown): MonitorFilterBuilder;
  ilike(column: string, pattern: string): MonitorFilterBuilder;
  or(filters: string, opts?: { referencedTable?: string }): MonitorFilterBuilder;
}

// PostgREST escaping for an `or` filter value: commas and parentheses are the
// clause delimiters, so a company name containing them would break the filter.
// We strip them — alias targets are simple names/slugs and never contain these.
function sanitizeOrValue(value: string): string {
  return value.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

// Build the PostgREST `or` clause that matches a companyName query against the
// company's own name *and* any alias legal-names / ats_slug (Google→Alphabet,
// Meta→Meta Platforms). Returns null when there is nothing to expand to.
function companyNameOrFilter(companyName: string): string | null {
  const normalized = normalizeCompanyKey(companyName);
  const aliasNames = resolveCompanyNameAliases(normalized);
  const conds: string[] = [`name.ilike.${sanitizeOrValue(companyName)}`];
  for (const alias of aliasNames) {
    if (!alias || alias === normalized) continue;
    conds.push(`name.ilike.${sanitizeOrValue(alias)}`);
    conds.push(`metadata->>ats_slug.eq.${sanitizeOrValue(alias)}`);
  }
  // Also allow the original query itself to match an ats_slug directly.
  conds.push(`metadata->>ats_slug.eq.${sanitizeOrValue(normalized)}`);
  return conds.length > 0 ? conds.join(",") : null;
}

// Apply the monitor + single-company targeting filters shared by the count and
// page queries so both requests stay in sync. The monitor=true constraint is
// dropped when the caller targets a single company (so legacy non-monitored
// rows can be repaired/tested) — untargeted requests stay monitored-only so the
// scheduled cron never fans out across the whole table.
function applyMonitorFilters(
  builder: MonitorFilterBuilder,
  query: RefreshJobsQuery
): MonitorFilterBuilder {
  const targeted = isSingleCompanyTargeted(query);
  let b = builder;
  if (!targeted) b = b.eq("monitor", true);
  if (query.companyId) b = b.eq("id", query.companyId);
  if (query.companyName) {
    // Expand short-name aliases (Google→Alphabet, Meta→Meta Platforms) and match
    // either the company name or its stored ats_slug, instead of a single exact
    // ilike that would miss the legal-name row.
    const orFilter = companyNameOrFilter(query.companyName);
    b = orFilter ? b.or(orFilter) : b.ilike("name", query.companyName);
  }
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
    // careers_url is a first-class column; metadata does not exist in the
    // current production DB (omitting it avoids a 42703 that returns 0 rows).
    .select("id,name,domain,industry,description,careers_url");
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
  const candidateFlags = candidateFlagsFor(company);
  const report: RefreshCompanyReport = {
    company_id: company.id,
    name: company.name,
    theirstack_jobs: theirStackJobs.length,
    careers_portal_attempted: false,
    careers_portal_jobs: 0,
    careers_portal_total: 0,
    candidate_source: !candidateFlags.fetchEnabled,
    source_status: candidateFlags.sourceStatus,
    source_openings_persisted: false,
    jobspy_fallback: false,
    jobspy_jobs: 0,
    merged: 0,
    upserted: 0,
    deactivated: 0,
    timed_out: false,
    errors: [],
  };

  let { careersUrl, jobPortalUrl, atsType, atsSlug } = careersUrlsFor(company);

  // Legacy rows imported before the curated universe carry an empty metadata
  // object, so they have no careers/ATS pointers. When targeting such a company
  // for repair, infer a public ATS board from its existing role URLs (e.g.
  // Pinterest's gh_jid links) so the careers-portal provider can report the
  // authoritative live total instead of the stale 0-2 legacy rows.
  if (supabase && !atsType && !atsSlug && !careersUrl && !jobPortalUrl) {
    const inferred = await inferAtsHintsFromRoles(supabase, company.id);
    if (inferred) {
      careersUrl = inferred.careersUrl;
      jobPortalUrl = inferred.jobPortalUrl;
      atsType = inferred.atsType;
      atsSlug = inferred.atsSlug;
      report.careers_portal_inferred = true;
    }
  }

  const lowCoverage = theirStackJobs.length <= LOW_COVERAGE_THRESHOLD;
  const hasAtsBoard = Boolean(atsType && atsSlug);
  const hasCareersUrl = Boolean(careersUrl || jobPortalUrl);
  // A named-employer adapter (Amazon/Microsoft/Apple) resolves the source purely
  // from the company name via a public JSON inventory endpoint, so it can report
  // the exact live total even when the company has no stored careers URL or ATS
  // hints — the common case for these large employers.
  const hasNamedAdapter = hasNamedEmployerAdapter(company.name);

  // Direct careers-portal source. Always attempt when a public ATS board is
  // resolvable (it yields the authoritative full-inventory total cheaply via a
  // single JSON request), when a named-employer adapter exists (same, by name),
  // when TheirStack is thin and the company has any careers/ATS URL, or when we
  // inferred hints from a legacy row's role URLs (the whole point of a targeted
  // repair). No API key required.
  const inferredAttempt = report.careers_portal_inferred === true && hasCareersUrl;
  let careersJobs: CareersPortalJob[] = [];
  let resolvedCareersUrl: string | null = null;
  if (
    hasNamedAdapter ||
    ((hasAtsBoard || hasCareersUrl) && (hasAtsBoard || lowCoverage || inferredAttempt))
  ) {
    report.careers_portal_attempted = true;
    try {
      const portal = await fetchCareersPortalJobs({
        companyName: company.name,
        companyId: company.id,
        careersUrl: careersUrl ?? jobPortalUrl ?? "",
        jobPortalUrl,
        atsType,
        atsSlug,
        // Public ATS boards return the whole inventory in one cheap JSON call,
        // so ingest the full set of role rows per company (the per-invocation
        // bound is on the number of companies, not roles within a company). The
        // reported total still reflects the exact board size regardless of this.
        maxJobs: CAREERS_SAMPLE_MAX,
      });
      careersJobs = portal.jobs;
      report.careers_portal_jobs = portal.jobs.length;
      report.careers_portal_total = portal.totalCount;
      report.careers_portal_source = portal.source;
      report.careers_portal_count_exact = portal.countExact ?? false;
      resolvedCareersUrl = portal.fetchedUrl ?? careersUrl ?? jobPortalUrl;
      if (portal.jobs.length === 0 && portal.reason) {
        report.careers_portal_reason = portal.reason;
      }
      // A non-exact (scraped) count is a lower-bound sample, not the live total.
      // Flag it in the report so a dry-run never presents a shallow HTML count as
      // authoritative.
      if (portal.totalCount > 0 && portal.countExact === false) {
        report.careers_portal_reason =
          report.careers_portal_reason ?? "scraped_sample_not_exact";
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

  // Candidate-source safety gate. A validation-pending candidate (metadata
  // fetch_enabled !== true) whose careers source did not resolve to an EXACT
  // live inventory must not have its non-exact sample promoted on a real run:
  // no source_openings_total/exact, and no scraped careers role rows written as
  // active openings. The careers source is still exercised above so a dry-run
  // can report the attempt (the production visibility we want), but the mutating
  // path withholds the count and records an explicit needs_* reason. Exact
  // sources are always persisted — that is what promotes a candidate to a
  // confirmed source. Counts are never capped; we either persist the exact
  // total or persist nothing.
  const refreshDecision = decideCandidateRefresh({
    fetchEnabled: candidateFlags.fetchEnabled,
    validationEnabled: candidateFlags.validationEnabled,
    countExact: report.careers_portal_count_exact ?? false,
    totalCount: report.careers_portal_total,
  });
  if (report.careers_portal_attempted && !refreshDecision.mayPersist) {
    report.careers_portal_reason =
      report.careers_portal_reason ?? refreshDecision.reason ?? undefined;
  }

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

  // Careers-portal rows are only persisted as active openings when the source is
  // trusted to persist (an exact live inventory on a validation-enabled company).
  // A candidate's non-exact scrape sample is withheld so we never fabricate
  // active role rows for a not-yet-validated source.
  if (refreshDecision.mayPersist) {
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

  // Persist the authoritative source inventory total onto the company so the
  // dashboard / companies API can display it without re-fetching the ATS board
  // on every page load. Only written when the careers source was actually
  // exercised this run AND the candidate-safety gate permits persisting it: a
  // validation-pending candidate's non-exact scrape sample is never promoted to
  // a source_openings_total/exact (that would fabricate a live count), only an
  // exact live inventory is. The reason for a withheld persist is already on
  // report.careers_portal_reason.
  if (
    report.careers_portal_attempted &&
    report.careers_portal_total > 0 &&
    refreshDecision.mayPersist
  ) {
    await persistSourceTotal(supabase, company, report, {
      careersUrl: resolvedCareersUrl,
      atsType,
      atsSlug,
    });
    report.source_openings_persisted = report.errors.every(
      (e) => !e.startsWith("source_total_persist_failed")
    );
  }

  return report;
}

// Merge the live source inventory total into companies.metadata. Non-fatal:
// failures are recorded as warnings and never abort the batch. When the ATS
// board was inferred for a legacy row, the resolved careers URL + ATS hints are
// persisted too so subsequent runs skip re-inference.
async function persistSourceTotal(
  supabase: NonNullable<ReturnType<typeof createFeedAdminClient>>,
  company: MonitoredCompany,
  report: RefreshCompanyReport,
  resolved: { careersUrl: string | null; atsType: string | null; atsSlug: string | null }
): Promise<void> {
  // The live DB does not have a metadata column — persist via is_hiring only.
  // Backfill inferred careers_url onto the company row when it resolved from
  // inference and the row didn't have one yet (careers_url is a first-class col).
  const updatePayload: Record<string, unknown> = {
    is_hiring: report.careers_portal_total > 0,
  };
  if (resolved.careersUrl && !company.careers_url) {
    updatePayload.careers_url = resolved.careersUrl;
  }

  const { error } = await supabase
    .from("companies")
    .update(updatePayload)
    .eq("id", company.id);
  if (error) {
    report.errors.push(`source_total_persist_failed: ${error.message}`);
  }
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
        careers_portal_total: 0,
        careers_portal_reason: "company_budget_exceeded",
        candidate_source: !candidateFlagsFor(company).fetchEnabled,
        source_status: candidateFlagsFor(company).sourceStatus,
        source_openings_persisted: false,
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
    candidate_companies: 0,
    source_openings_persisted_companies: 0,
    has_more: false,
    next_offset: null,
    companies: [],
    total_theirstack: 0,
    total_careers_portal: 0,
    total_careers_portal_inventory: 0,
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
    const targeted = isSingleCompanyTargeted(query);
    report.errors.push(
      total === 0
        ? targeted
          ? "no company matches the requested filters (check companyId/companyName/slug)"
          : "no monitored companies match the requested filters (set companies.monitor = true to enrol)"
        : "offset is beyond the matching set; nothing to process in this window"
    );
    return NextResponse.json(report);
  }

  for (const company of monitored) {
    const companyReport = await processCompanyBounded(company, client, dryRun, supabase);
    report.companies.push(companyReport);
    report.total_theirstack += companyReport.theirstack_jobs;
    report.total_careers_portal += companyReport.careers_portal_jobs;
    report.total_careers_portal_inventory += companyReport.careers_portal_total;
    report.total_jobspy += companyReport.jobspy_jobs;
    report.total_upserted += companyReport.upserted;
    report.total_deactivated += companyReport.deactivated;

    report.processed += 1;
    if (companyReport.theirstack_jobs > 0) report.theirstack_companies += 1;
    if (companyReport.careers_portal_attempted) report.careers_portal_companies += 1;
    if (companyReport.candidate_source) report.candidate_companies += 1;
    if (companyReport.source_openings_persisted) {
      report.source_openings_persisted_companies += 1;
    }
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
