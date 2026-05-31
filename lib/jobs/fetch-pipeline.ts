// Job ingestion pipeline.
//
// This is the write path that turns a company's validated ATS source into
// active job_openings rows. It is deliberately separate from the scheduled
// cron (app/api/cron/refresh-jobs) so it can be triggered per-company on demand
// (POST /api/jobs/fetch-company) or across the validated universe
// (POST /api/jobs/fetch-all) without the cron's monitor/secret gating.
//
// System of record
// ----------------
// `public.roles` IS the job_openings table (see migration 004's job_openings
// view). A "job opening" is one active row in `roles`. We upsert keyed by
// (company_id, external_id) — the table's unique index — and derive a stable
// external_id from the job URL so the same posting fetched twice collapses to
// one row. last_checked_at is the "last_seen_at" the contract asks for.
//
// Source of fetch targets
// ------------------------
// company_job_sources_candidate is the source-of-sources table. A row is only
// fetched when it has been validated to an exact public board:
// fetch_enabled=true OR validation_status='validated_fetchable'. The fetcher is
// chosen by source_name (greenhouse | lever | ashby | workday) and delegates to
// the careers-portal provider, which already resolves each vendor's public JSON
// board API and reports an exact total.

import {
  fetchCareersPortalJobs,
  type CareersPortalJob,
} from "@/lib/feeds/providers/careers-portal";
import {
  classifyRoleCategory,
  classifyDomainCategory,
} from "@/lib/feeds/classify";

type SupabaseAdmin = NonNullable<
  ReturnType<typeof import("@/lib/feeds/supabase-admin").createFeedAdminClient>
>;

// One source-of-sources row, as loaded from company_job_sources_candidate.
export type CompanyJobSource = {
  id: string;
  company_id: string | null;
  company_name: string;
  source_name: string | null;
  ats_slug: string | null;
  careers_url: string | null;
  api_url: string | null;
  validation_status: string;
  fetch_enabled: boolean;
};

export type FetchCompanyResult = {
  company_id: string;
  company_name: string;
  source_name: string | null;
  // Number of jobs the source reported / we normalised this run.
  fetched_count: number;
  // Number of role rows actually inserted or updated.
  upserted_count: number;
  // Number of previously-active rows deactivated because they were not seen.
  deactivated_count: number;
  // The source's exact live total when the vendor API reported one.
  source_total: number;
  source_count_exact: boolean;
  error: string | null;
};

// Vendors whose source we actively fetch. A careers_url-only source (no vendor)
// is informational and never produces an exact job count — it is skipped here.
const FETCHABLE_VENDORS = new Set(["greenhouse", "lever", "ashby", "workday"]);

// A source is fetchable when it has been validated to an exact board. A bare
// careers_url with no resolved vendor is informational only.
export function isFetchableSource(source: CompanyJobSource): boolean {
  const promoted =
    source.fetch_enabled === true ||
    source.validation_status === "validated_fetchable";
  if (!promoted) return false;
  const vendor = (source.source_name ?? "").trim().toLowerCase();
  return FETCHABLE_VENDORS.has(vendor);
}

// One company plus the context fetchCompanyJobs needs for classification.
export type FetchableCompany = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
};

// Load the bounded universe of companies that have at least one validated
// fetchable source, so fetch-all only attempts companies worth attempting.
// Returns each company joined to its candidate source rows.
export async function loadFetchableCompanies(
  supabase: SupabaseAdmin,
  opts: { limit: number; offset: number } = { limit: 50, offset: 0 }
): Promise<Array<{ company: FetchableCompany; sources: CompanyJobSource[] }>> {
  const cols =
    "id,company_id,company_name,source_name,ats_slug,careers_url,api_url,validation_status,fetch_enabled";
  // Pull candidate rows that are promoted to fetchable. We over-select on the
  // promotion flags here and let isFetchableSource() do the vendor filtering.
  const { data, error } = await supabase
    .from("company_job_sources_candidate")
    .select(cols)
    .or("fetch_enabled.eq.true,validation_status.eq.validated_fetchable");
  if (error || !data) return [];

  const rows = data as CompanyJobSource[];
  const fetchable = rows.filter(isFetchableSource);

  // Group by company_id (candidates carry the linked company_id once validated).
  const byCompany = new Map<string, CompanyJobSource[]>();
  for (const row of fetchable) {
    if (!row.company_id) continue;
    const list = byCompany.get(row.company_id) ?? [];
    list.push(row);
    byCompany.set(row.company_id, list);
  }

  const companyIds = Array.from(byCompany.keys());
  if (companyIds.length === 0) return [];

  const page = companyIds.slice(opts.offset, opts.offset + opts.limit);
  if (page.length === 0) return [];

  const { data: companies, error: cErr } = await supabase
    .from("companies")
    .select("id,name,domain,industry,description,metadata")
    .in("id", page);
  if (cErr || !companies) return [];

  return (companies as FetchableCompany[]).map((company) => ({
    company,
    sources: byCompany.get(company.id) ?? [],
  }));
}

// Load every source-of-sources row for one company. Matches by company_id when
// the candidate is linked, else by case-insensitive company_name.
export async function loadCompanyJobSources(
  supabase: SupabaseAdmin,
  company: { id: string; name: string }
): Promise<CompanyJobSource[]> {
  const cols =
    "id,company_id,company_name,source_name,ats_slug,careers_url,api_url,validation_status,fetch_enabled";
  const { data, error } = await supabase
    .from("company_job_sources_candidate")
    .select(cols)
    .or(`company_id.eq.${company.id},company_name.ilike.${company.name}`);
  if (error || !data) return [];
  return data as CompanyJobSource[];
}

// Derive a stable external_id from a job URL (preferred) or title, so a posting
// fetched across runs maps to one role row. This is the "keyed by company_id +
// job_url" identity the contract asks for.
function externalIdFromJob(job: CareersPortalJob): string {
  if (job.external_id && job.external_id.trim()) return job.external_id.trim();
  const basis = (job.url ?? job.title).trim().toLowerCase();
  let hash = 5381;
  for (let i = 0; i < basis.length; i++) {
    hash = ((hash << 5) + hash + basis.charCodeAt(i)) >>> 0;
  }
  return `fetch_${hash.toString(36)}`;
}

// Fetch + upsert a single company's jobs from its first fetchable source.
// Best-effort and non-fatal: any provider/db failure is captured in `error`.
export async function fetchCompanyJobs(
  supabase: SupabaseAdmin,
  company: {
    id: string;
    name: string;
    domain?: string | null;
    industry?: string | null;
    description?: string | null;
    metadata?: Record<string, unknown> | null;
  },
  sources: CompanyJobSource[],
  opts: { dryRun?: boolean; maxJobs?: number } = {}
): Promise<FetchCompanyResult> {
  const result: FetchCompanyResult = {
    company_id: company.id,
    company_name: company.name,
    source_name: null,
    fetched_count: 0,
    upserted_count: 0,
    deactivated_count: 0,
    source_total: 0,
    source_count_exact: false,
    error: null,
  };

  const fetchable = sources.filter(isFetchableSource);
  if (fetchable.length === 0) {
    result.error = "no_validated_fetchable_source";
    return result;
  }

  // Prefer the first fetchable source; vendors are equivalent for the count.
  const source = fetchable[0];
  result.source_name = source.source_name;

  let jobs: CareersPortalJob[] = [];
  try {
    const portal = await fetchCareersPortalJobs({
      companyName: company.name,
      companyId: company.id,
      careersUrl: source.careers_url ?? source.api_url ?? "",
      jobPortalUrl: source.api_url ?? source.careers_url ?? null,
      atsType: source.source_name,
      atsSlug: source.ats_slug,
      maxJobs: opts.maxJobs ?? 500,
    });
    jobs = portal.jobs;
    result.fetched_count = portal.totalCount;
    result.source_total = portal.totalCount;
    result.source_count_exact = portal.countExact === true;
    if (portal.jobs.length === 0 && portal.reason) {
      result.error = portal.reason;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  if (opts.dryRun) return result;

  const companyContext = [company.industry, company.description, company.domain]
    .filter(Boolean)
    .join(" ");
  const seenExternalIds: string[] = [];
  const now = new Date().toISOString();

  for (const job of jobs) {
    const externalId = externalIdFromJob(job);
    const roleCategory = classifyRoleCategory(job.title, null);
    const domainCategory = classifyDomainCategory(job.title, null, companyContext);
    const { error } = await supabase.from("roles").upsert(
      {
        external_id: externalId,
        company_id: company.id,
        title: job.title,
        location: job.location,
        url: job.url,
        source: "careers_portal",
        role_category: roleCategory,
        domain_category: domainCategory,
        is_active: true,
        last_checked_at: now,
        metadata: {
          external_id: externalId,
          source_url: job.source_url,
          source_name: source.source_name,
        },
      },
      { onConflict: "company_id,external_id" }
    );
    if (error) {
      result.error = result.error ?? `role_upsert_failed: ${error.message}`;
      continue;
    }
    result.upserted_count += 1;
    seenExternalIds.push(externalId);
  }

  // Deactivate previously-active careers_portal rows for this company that were
  // not seen this run, so a closed posting drops out of the active count. Skips
  // when the pull was empty (a transient failure shouldn't wipe known rows).
  if (seenExternalIds.length > 0) {
    result.deactivated_count = await deactivateUnseen(
      supabase,
      company.id,
      seenExternalIds
    );
  }

  // Persist the exact source inventory onto the company so /api/companies can
  // surface it without re-fetching the board. Only an exact vendor total is
  // promoted; a non-exact sample is left untouched.
  if (result.source_count_exact && result.source_total > 0) {
    const prior = company.metadata ?? {};
    await supabase
      .from("companies")
      .update({
        metadata: {
          ...prior,
          source_openings_total: result.source_total,
          source_openings_exact: true,
          source_openings_source: result.source_name ?? "careers_portal",
          source_openings_checked_at: now,
          fetch_enabled: true,
          source_status: "counted_from_public_api_exact",
        },
        is_hiring: result.source_total > 0,
      })
      .eq("id", company.id);
  }

  return result;
}

async function deactivateUnseen(
  supabase: SupabaseAdmin,
  companyId: string,
  seenExternalIds: string[]
): Promise<number> {
  const { data, error } = await supabase
    .from("roles")
    .select("id,external_id")
    .eq("company_id", companyId)
    .eq("source", "careers_portal")
    .eq("is_active", true);
  if (error || !data) return 0;
  const toDeactivate = (data as Array<{ id: string; external_id: string | null }>)
    .filter((r) => r.external_id && !seenExternalIds.includes(r.external_id))
    .map((r) => r.id);
  let count = 0;
  const now = new Date().toISOString();
  for (const id of toDeactivate) {
    const { error: deErr } = await supabase
      .from("roles")
      .update({ is_active: false, last_checked_at: now })
      .eq("id", id);
    if (!deErr) count += 1;
  }
  return count;
}
