import { NextResponse, type NextRequest } from "next/server";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";
import {
  createTheirStackClient,
  mapJobToCompany,
  mapJobToRole,
  TheirStackNotConfiguredError,
  type TheirStackJob,
} from "@/lib/feeds/providers";
import { fetchJobSpyJobs } from "@/lib/jobs/jobspy";
import {
  classifyRoleCategory,
  classifyDomainCategory,
} from "@/lib/feeds/classify";

export const runtime = "nodejs";
// Vercel cron sends GET requests; we also accept POST for manual triggering.
export const dynamic = "force-dynamic";

type MonitoredCompany = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  description: string | null;
};

type RefreshCompanyReport = {
  company_id: string;
  name: string;
  theirstack_jobs: number;
  jobspy_fallback: boolean;
  jobspy_jobs: number;
  merged: number;
  upserted: number;
  deactivated: number;
  errors: string[];
};

type RefreshReport = {
  dryRun: boolean;
  theirstack_configured: boolean;
  jobspy_configured: boolean;
  monitored_companies: number;
  companies: RefreshCompanyReport[];
  total_upserted: number;
  total_deactivated: number;
  errors: string[];
};

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

async function loadMonitoredCompanies(
  supabase: ReturnType<typeof createFeedAdminClient>
): Promise<MonitoredCompany[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("companies")
    .select("id,name,domain,industry,description")
    .eq("monitor", true)
    .limit(500);
  if (error || !data) return [];
  return data as MonitoredCompany[];
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
    jobspy_fallback: false,
    jobspy_jobs: 0,
    merged: 0,
    upserted: 0,
    deactivated: 0,
    errors: [],
  };

  // JobSpy fallback when TheirStack returns <= 1 job for a monitored company.
  let jobspyTitles: Array<{ title: string; description: string }> = [];
  if (theirStackJobs.length <= 1) {
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
  report.merged = deduped.length;

  if (dryRun || !supabase) {
    return report;
  }

  const companyContext = [company.industry, company.description, company.domain]
    .filter(Boolean)
    .join(" ");
  const seenExternalIds: string[] = [];

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
    seenExternalIds.push(job.external_id);
  }

  // Mark roles no longer present in the latest TheirStack pull as inactive,
  // but only for TheirStack-sourced rows so we never clobber manual/other data.
  if (seenExternalIds.length > 0) {
    const { data: stale, error: staleErr } = await supabase
      .from("roles")
      .select("id,external_id")
      .eq("company_id", company.id)
      .eq("source", "theirstack")
      .eq("is_active", true);
    if (!staleErr && stale) {
      const toDeactivate = (stale as Array<{ id: string; external_id: string | null }>)
        .filter((r) => r.external_id && !seenExternalIds.includes(r.external_id))
        .map((r) => r.id);
      for (const id of toDeactivate) {
        const { error: deErr } = await supabase
          .from("roles")
          .update({ is_active: false, last_checked_at: new Date().toISOString() })
          .eq("id", id);
        if (deErr) report.errors.push(`deactivate failed (${id}): ${deErr.message}`);
        else report.deactivated += 1;
      }
    }
  }

  return report;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true";

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
    jobspy_configured: Boolean(process.env.JOBSPY_ENDPOINT),
    monitored_companies: 0,
    companies: [],
    total_upserted: 0,
    total_deactivated: 0,
    errors: [],
  };

  const monitored = await loadMonitoredCompanies(supabase);
  report.monitored_companies = monitored.length;

  if (monitored.length === 0) {
    report.errors.push(
      "no monitored companies found (set companies.monitor = true to enrol)"
    );
    return NextResponse.json(report);
  }

  for (const company of monitored) {
    let theirStackJobs: TheirStackJob[] = [];
    if (client.config.configured) {
      // Prefer the domain filter (most precise). When a monitored/seeded
      // company has no domain, fall back to a case-insensitive company-name
      // match so domain-less seed records still get a TheirStack pull instead
      // of silently returning 0 jobs.
      const searchInput = company.domain
        ? { companyDomainOr: [company.domain], limit: 100 }
        : { companyNameCaseInsensitiveOr: [company.name], limit: 100 };
      try {
        const res = await client.searchJobs(searchInput);
        theirStackJobs = res.jobs;
      } catch (err) {
        if (!(err instanceof TheirStackNotConfiguredError)) {
          report.errors.push(
            `theirstack search failed (${company.name}): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    const companyReport = await refreshCompany(company, theirStackJobs, dryRun, supabase);
    report.companies.push(companyReport);
    report.total_upserted += companyReport.upserted;
    report.total_deactivated += companyReport.deactivated;
  }

  return NextResponse.json(report);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
