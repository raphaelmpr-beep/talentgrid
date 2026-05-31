import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";
import { fetchJobSpyJobs } from "@/lib/jobs/jobspy";
import {
  normalizeCompanyKey as normalizeKeyPart,
  resolveSourceTotal,
  resolveDisplayedCounts,
  resolveCompanyNameAliases,
  companyNameMatchStrengthWithAliases,
  type ResolvedSourceTotal,
} from "@/lib/companies/search-scope";
import {
  hasRevenueOverlap,
  resolveIncludeUnknownRevenue,
} from "@/lib/companies/revenue-filter";
import {
  deriveCountDiagnostics,
  toCompanyCountContract,
  type CountDiagnostics,
  type CompanyCountContract,
} from "@/lib/companies/count-diagnostics";

export const runtime = "nodejs";

type RoleRow = {
  id?: string | null;
  company_id: string | null;
  external_id?: string | null;
  source?: string | null;
  title?: string | null;
  description?: string | null;
  location?: string | null;
  remote?: boolean | null;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number | null;
  posted_at?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

type EmbeddedRole = {
  id: string;
  title: string;
  location?: string | null;
  remote?: boolean | null;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number | null;
  posted_at?: string | null;
  role_family?: string | null;
};

type DomainKey = "hr" | "sales" | "finance" | "robotics" | "healthcare" | "ai";

type CompanyRow = {
  id: string;
  name: string;
  domain?: string | null;
  description?: string | null;
  industry?: string | null;
  size?: string | null;
  location?: string | null;
  logo_url?: string | null;
  website?: string | null;
  is_hiring: boolean;
  revenue_band?: string | null;
  domain_tags?: string[] | null;
  role_tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string;
};

type SmartQueryParseResult = {
  detectedDomain?: DomainKey;
  detectedRole?: string;
  remainingQuery?: string;
};

type RevenueCategoryKey = "lt_50m" | "50m_100m" | "100m_600m" | "600m_1b" | "gt_1b";

type GroupedJob = {
  id: string;
  title: string;
  company: string;
  companyId: string;
  roles: string[];
  roleKeys: string[];
  domains: string[];
  domainKeys?: string[];
  skills: string[];
  description: string;
  location?: string | null;
  createdAt: string;
  revenueCategory: string;
  revenue?: number | null;
  source: "primary" | "jobspy";
  remote?: boolean | null;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number | null;
  role_family?: string | null;
  posted_at?: string | null;
};

type GroupedCompanyEntry = {
  id: string;
  company: string;
  location?: string | null;
  domain?: string | null;
  industry?: string | null;
  description?: string | null;
  logo_url?: string | null;
  is_hiring: boolean;
  metadata?: Record<string, unknown> | null;
  created_at: string;
  updated_at?: string;
  revenueCategory: string;
  revenue?: number | null;
  jobCount: number;
  domains: Set<string>;
  rolesMap: Map<string, number>;
  roleFamilies: Map<string, number>;
  jobs: GroupedJob[];
};

type SupabaseClient = NonNullable<Awaited<ReturnType<typeof createClient>>>;

const ROLE_BATCH_SIZE = 1000;
const COMPANY_BATCH_SIZE = 1000;

const DOMAIN_LABELS: Record<DomainKey, string> = {
  hr: "HR",
  sales: "Sales",
  finance: "Finance",
  robotics: "Robotics",
  healthcare: "Healthcare",
  ai: "AI",
};

const ROLE_LABELS: Record<string, string> = {
  engineer: "Software Engineer",
  frontend: "Frontend",
  backend: "Backend",
  fullstack: "Full Stack",
  devops: "DevOps/SRE",
  data: "Data",
  ml: "ML/AI",
};

const DOMAIN_KEYWORDS: Record<DomainKey, string[]> = {
  hr: ["hr", "human resources", "talent", "recruiting"],
  sales: ["sales", "account executive", "account manager", "bdr", "sdr"],
  finance: ["finance", "financial", "fintech", "banking", "payments", "accounting"],
  robotics: ["robotics", "robot", "drone", "autonomous"],
  healthcare: ["healthcare", "health care", "medical", "medtech", "clinical", "pharma"],
  ai: ["ai", "artificial intelligence", "machine learning", "ml", "llm", "nlp"],
};

const QUERY_DOMAIN_KEYWORDS: Record<DomainKey, string[]> = {
  hr: ["hr", "human resources"],
  sales: ["sales"],
  finance: ["finance"],
  robotics: ["drone", "robotics", "robot"],
  healthcare: ["healthcare", "health care"],
  ai: ["ai", "ml", "machine learning"],
};

const QUERY_ROLE_KEYWORDS: Record<string, string[]> = {
  backend: ["backend", "back-end", "back end"],
  frontend: ["frontend", "front-end", "front end"],
  fullstack: ["fullstack", "full-stack", "full stack"],
  devops: ["devops", "dev-ops", "sre"],
  data: ["data"],
  ml: ["ml", "ai"],
  engineer: ["engineer", "developer", "software engineer"],
};

const REVENUE_LABELS: Record<RevenueCategoryKey, string> = {
  lt_50m: "<50M",
  "50m_100m": "50M-100M",
  "100m_600m": "100M-600M",
  "600m_1b": "600M-1B",
  gt_1b: "1B+",
};

const REVENUE_KEY_BY_LABEL: Record<string, RevenueCategoryKey> = {
  "<50m": "lt_50m",
  "50m-100m": "50m_100m",
  "100m-600m": "100m_600m",
  "600m-1b": "600m_1b",
  "1b+": "gt_1b",
};

// Large-cap seed dataset bands stored verbatim in companies.revenue_band by the
// import utility (see lib/feeds/import-companies.ts). These are all >1B, i.e.
// subdivisions of the legacy gt_1b bucket, so a request for the gt_1b category
// must also match any of them. Keyed by a normalised form ("$"/space stripped)
// so "$1B-$10B", "1b-10b", "$1b - $10b" all resolve to the same band.
const SEED_REVENUE_BANDS = [
  "$1B-$10B",
  "$10B-$50B",
  "$50B-$100B",
  "$100B-$250B",
  "$250B-$500B",
  "$500B+",
] as const;

function canonicalBandKey(value: string): string {
  return value.trim().toLowerCase().replace(/[$\s]/g, "");
}

const SEED_BAND_KEYS = new Set(SEED_REVENUE_BANDS.map((band) => canonicalBandKey(band)));

// True when the company's stored revenue_band is one of the large-cap seed bands.
function isSeedRevenueBand(band: string | null | undefined): boolean {
  if (!band) return false;
  return SEED_BAND_KEYS.has(canonicalBandKey(band));
}

// Resolve companies.revenue_band (either a legacy key/label or a seed band) to
// the legacy RevenueCategoryKey used by the category filter. Seed bands are all
// above 1B and collapse onto gt_1b.
function revenueBandToCategoryKey(band: string | null | undefined): RevenueCategoryKey | null {
  if (!band) return null;
  const lower = band.trim().toLowerCase();
  if (lower in REVENUE_LABELS) return lower as RevenueCategoryKey;
  const fromLabel = REVENUE_KEY_BY_LABEL[lower];
  if (fromLabel) return fromLabel;
  if (isSeedRevenueBand(band)) return "gt_1b";
  return null;
}

function asLowerText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

// Extract the Greenhouse job id (gh_jid) from any URL that carries it — either as
// a query param (`?gh_jid=7863290`, used by company-hosted boards that embed
// Greenhouse, e.g. pinterestcareers.com) or as a path segment on a native
// greenhouse.io board (`/jobs/7863290`, `/embed/job_app?for=slug&token=7863290`).
// Returns the bare numeric id so the same opening surfaced via two different URL
// shapes collapses to one canonical identity.
function extractGreenhouseJobId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const queryGhJid =
    parsed.searchParams.get("gh_jid") ?? parsed.searchParams.get("token");
  if (queryGhJid && /^\d+$/.test(queryGhJid)) return queryGhJid;

  if (parsed.hostname.toLowerCase().endsWith("greenhouse.io")) {
    // Last all-numeric path segment is the job id on native Greenhouse boards.
    const numericSegments = parsed.pathname
      .split("/")
      .filter((part) => /^\d+$/.test(part));
    if (numericSegments.length > 0) return numericSegments[numericSegments.length - 1];
  }

  return null;
}

// Normalise a job URL down to a stable key: drop tracking/query noise and the
// trailing slash so the same posting linked with different query strings maps to
// one identity. When a Greenhouse job id is present it wins outright.
function normalizeJobUrl(url: string): string | null {
  const ghId = extractGreenhouseJobId(url);
  if (ghId) return `gh:${ghId}`;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.toLowerCase()}${path}`.toLowerCase();
  } catch {
    return null;
  }
}

// Derive a canonical identity for a role so duplicate rows for the same real
// opening (a stale legacy row alongside the freshly-refreshed source row, or two
// duplicate company_ids carrying the same posting) collapse to one count.
// Priority: explicit source identity (external_id / metadata source ids) →
// normalised URL (Greenhouse gh_jid aware) → company-scoped title fallback.
function canonicalRoleKey(role: RoleRow, companyKey: string): string {
  const metadata = role.metadata ?? {};
  const metaId =
    asLowerText(metadata["external_id"]) ||
    asLowerText(metadata["source_id"]) ||
    asLowerText(metadata["gh_jid"]);
  if (metaId) return `ext:${metaId}`;

  const externalId = asLowerText(role.external_id);
  if (externalId) return `ext:${externalId}`;

  if (role.url) {
    const normalizedUrl = normalizeJobUrl(role.url);
    if (normalizedUrl) return `url:${normalizedUrl}`;
  }

  return `title:${companyKey}::${asLowerText(role.title)}`;
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function parseSmartQuery(query: string | undefined): SmartQueryParseResult {
  if (!query) return {};
  const lower = query.toLowerCase();

  let detectedDomain: DomainKey | undefined;
  for (const [domain, keys] of Object.entries(QUERY_DOMAIN_KEYWORDS) as Array<
    [DomainKey, string[]]
  >) {
    if (keys.some((key) => lower.includes(key))) {
      detectedDomain = domain;
      break;
    }
  }

  let detectedRole: string | undefined;
  for (const [role, keys] of Object.entries(QUERY_ROLE_KEYWORDS)) {
    if (keys.some((key) => lower.includes(key))) {
      detectedRole = role;
      break;
    }
  }

  let remaining = lower;
  for (const keys of Object.values(QUERY_DOMAIN_KEYWORDS)) {
    for (const key of keys) remaining = remaining.replaceAll(key, " ");
  }
  for (const keys of Object.values(QUERY_ROLE_KEYWORDS)) {
    for (const key of keys) remaining = remaining.replaceAll(key, " ");
  }

  const remainingQuery = remaining.replace(/\s+/g, " ").trim();

  return { detectedDomain, detectedRole, remainingQuery };
}

async function fetchAllActiveRoles(
  supabase: SupabaseClient,
  columns: string,
  companyIds?: string[]
) {
  if (companyIds && companyIds.length === 0) return { data: [] as RoleRow[], error: null };

  const rows: RoleRow[] = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("roles")
      .select(columns)
      .eq("is_active", true)
      .lt("ghost_score", 70)
      .order("id", { ascending: true })
      .range(from, from + ROLE_BATCH_SIZE - 1);

    if (companyIds) query = query.in("company_id", companyIds);

    const { data, error } = await query;
    if (error) return { data: null, error };

    const chunk = ((data ?? []) as unknown[]) as RoleRow[];
    rows.push(...chunk);

    if (chunk.length < ROLE_BATCH_SIZE) break;
    from += ROLE_BATCH_SIZE;
  }

  return { data: rows, error: null };
}

async function fetchAllCompanies(
  supabase: SupabaseClient,
  isHiring?: boolean
): Promise<{ data: CompanyRow[] | null; error: { message: string } | null }> {
  const rows: CompanyRow[] = [];
  let from = 0;

  while (true) {
    let query = supabase
      .from("companies")
      .select("*")
      .order("created_at", { ascending: false })
      .range(from, from + COMPANY_BATCH_SIZE - 1);

    if (isHiring === false) query = query.eq("is_hiring", false);

    const { data, error } = await query;
    if (error) return { data: null, error };

    const chunk = ((data ?? []) as unknown[]) as CompanyRow[];
    rows.push(...chunk);

    if (chunk.length < COMPANY_BATCH_SIZE) break;
    from += COMPANY_BATCH_SIZE;
  }

  return { data: rows, error: null };
}

function detectDomainKeys(text: string): Set<DomainKey> {
  const output = new Set<DomainKey>();
  if (!text) return output;
  const value = text.toLowerCase();

  for (const [domain, keys] of Object.entries(DOMAIN_KEYWORDS) as Array<
    [DomainKey, string[]]
  >) {
    if (keys.some((key) => value.includes(key))) output.add(domain);
  }

  return output;
}

function inferRoleFamilyLabel(roleFamily: string | null): string {
  if (!roleFamily) return "Software Engineer";
  return ROLE_LABELS[roleFamily] ?? "Software Engineer";
}

function inferJobDomains(company: CompanyRow, role: RoleRow): DomainKey[] {
  const companyText = [company.domain, company.industry, company.description]
    .map(asLowerText)
    .filter(Boolean)
    .join(" ");
  const metadataText = JSON.stringify(role.metadata ?? {}).toLowerCase();
  const roleText = [role.title, role.description, metadataText]
    .map(asLowerText)
    .filter(Boolean)
    .join(" ");

  const domains = new Set<DomainKey>();
  for (const d of detectDomainKeys(`${companyText} ${roleText}`)) domains.add(d);

  return Array.from(domains);
}

function normaliseFreeText(query: string | undefined): string {
  if (!query) return "";
  return query.trim().toLowerCase();
}

function roleMatchesFreeText(role: RoleRow, query: string): boolean {
  const haystack = [role.title, role.description, JSON.stringify(role.metadata ?? {})]
    .map(asLowerText)
    .filter(Boolean)
    .join(" ");
  return haystack.includes(query);
}

// The authoritative full live inventory count, persisted onto companies.metadata
// by the cron refresh after hitting the company's ATS board API (e.g. Greenhouse
// meta.total = 176 for Pinterest). Null when never refreshed.
function getSourceOpeningsTotal(
  metadata: Record<string, unknown> | null | undefined
): number | null {
  const raw = metadata?.["source_openings_total"];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

// Whether the persisted source_openings_total is the vendor-reported *exact*
// live inventory (a public ATS board API) rather than a best-effort scrape
// sample. Only an exact total is trusted to cap the matching count; a non-exact
// total is a lower bound and must never shrink a larger deduped role set.
// Defaults to false when the flag is absent (legacy rows refreshed before the
// flag existed are treated as non-exact to avoid wrongly capping).
function isSourceOpeningsExact(
  metadata: Record<string, unknown> | null | undefined
): boolean {
  return metadata?.["source_openings_exact"] === true;
}

// When was the persisted source inventory last refreshed by the cron. Surfaced
// so the card can show staleness for an exact source total.
function getSourceOpeningsCheckedAt(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const raw = metadata?.["source_openings_checked_at"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function getCompanyRevenue(metadata: Record<string, unknown> | null | undefined): number | null {
  const m = metadata ?? {};
  const annual = parseNumericValue(m["annual_revenue"]);
  if (annual !== null && annual > 0) return annual;

  const min = parseNumericValue(m["revenue_min"]);
  const max = parseNumericValue(m["revenue_max"]);
  if (min !== null && max !== null) return (min + max) / 2;
  if (max !== null) return max;
  if (min !== null) return min;

  return null;
}

function getRevenueCategoryKey(revenue: number | null): RevenueCategoryKey | null {
  if (typeof revenue !== "number" || !Number.isFinite(revenue)) return null;
  if (revenue < 50_000_000) return "lt_50m";
  if (revenue < 100_000_000) return "50m_100m";
  if (revenue < 600_000_000) return "100m_600m";
  if (revenue < 1_000_000_000) return "600m_1b";
  return "gt_1b";
}

function getRevenueCategoryLabel(revenue: number | null): string {
  const key = getRevenueCategoryKey(revenue);
  return key ? REVENUE_LABELS[key] : "Unknown";
}

function getRevenueBandLabel(company: CompanyRow): string {
  const raw = company.revenue_band?.trim();
  if (raw) {
    // Seed dataset bands ("$1B-$10B"…"$500B+") are displayed verbatim.
    if (isSeedRevenueBand(raw)) return raw;
    const explicit = raw.toLowerCase();
    if (REVENUE_LABELS[explicit as RevenueCategoryKey]) {
      return REVENUE_LABELS[explicit as RevenueCategoryKey];
    }
  }
  return getRevenueCategoryLabel(getCompanyRevenue(company.metadata));
}

function groupByCompany(
  jobs: GroupedJob[],
  companyById: Map<string, CompanyRow>,
  totalActiveByCompany?: Map<string, { count: number; latestSeenAt: string | null }>,
  sourceTotalByCompany?: Map<string, ResolvedSourceTotal>
) {
  const map = new Map<string, GroupedCompanyEntry>();

  jobs.forEach((job) => {
    const companyKey = normalizeKeyPart(job.company);

    if (!map.has(companyKey)) {
      const company = companyById.get(job.companyId);
      map.set(companyKey, {
        id: job.companyId,
        company: job.company,
        location: company?.location ?? job.location ?? "Unknown",
        domain: company?.domain,
        industry: company?.industry,
        description: company?.description,
        logo_url: company?.logo_url,
        is_hiring: company?.is_hiring ?? true,
        metadata: company?.metadata,
        created_at: company?.created_at ?? job.createdAt,
        updated_at: company?.updated_at,
        revenueCategory: job.revenueCategory,
        revenue: job.revenue,
        jobCount: 0,
        domains: new Set<string>(),
        rolesMap: new Map<string, number>(),
        roleFamilies: new Map<string, number>(),
        jobs: [],
      });
    }

    const entry = map.get(companyKey)!;
    if (!asLowerText(entry.location) && asLowerText(job.location)) {
      entry.location = job.location;
    }
    entry.jobCount += 1;
    entry.jobs.push(job);
    job.domains?.forEach((d) => entry.domains.add(d));

    job.roles?.forEach((role) => {
      entry.rolesMap.set(role, (entry.rolesMap.get(role) ?? 0) + 1);
    });

    job.roleKeys?.forEach((roleKey) => {
      entry.roleFamilies.set(roleKey, (entry.roleFamilies.get(roleKey) ?? 0) + 1);
    });
  });

  return Array.from(map.values())
    .map((entry) => {
      const companyKey = normalizeKeyPart(entry.company);
      // Resolve the authoritative source inventory across *every* duplicate row
      // for this normalised name, not just the displayed row's metadata. Legacy
      // duplicates that survived past refreshes often carry empty/stale metadata,
      // so the exact total (e.g. Pinterest's Greenhouse meta.total = 176) must be
      // found even when the chosen display row lacks it. Falls back to the single
      // display row only when the cross-duplicate map wasn't supplied.
      const resolved: ResolvedSourceTotal =
        sourceTotalByCompany?.get(companyKey) ??
        (() => {
          const t = getSourceOpeningsTotal(entry.metadata);
          return {
            exactTotal: t !== null && isSourceOpeningsExact(entry.metadata) ? t : null,
            nonExactTotal: t !== null && !isSourceOpeningsExact(entry.metadata) ? t : null,
          };
        })();

      // Totals are keyed by canonical company name (duplicate company_ids for the
      // same company are already collapsed upstream into one deduped count).
      const totalActive = totalActiveByCompany?.get(companyKey);
      const dedupedActive = totalActive?.count ?? 0;
      // Centralised cap rule: an exact live inventory caps the matching set and
      // the surfaced jobs, and wins outright as the displayed total. This is what
      // stops residual legacy duplicate role rows from carrying Pinterest to 178
      // when the careers site shows 176.
      const counts = resolveDisplayedCounts(resolved, {
        dedupedActive,
        matchingCount: entry.jobs.length,
      });
      if (entry.jobs.length > counts.jobsCap) {
        entry.jobs = entry.jobs.slice(0, counts.jobsCap);
      }

      const rolesSummary = Array.from(entry.rolesMap.entries())
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => b.count - a.count);

      const roleFamilies = Array.from(entry.roleFamilies.entries()).reduce<Record<string, number>>(
        (acc, [family, count]) => {
          acc[family] = count;
          return acc;
        },
        {}
      );

      const embeddedRoles: EmbeddedRole[] = entry.jobs.map((job) => ({
        id: job.id,
        title: job.title,
        location: job.location,
        remote: job.remote,
        employment_type: job.employment_type,
        seniority: job.seniority,
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        url: job.url,
        ghost_score: job.ghost_score,
        posted_at: job.posted_at,
        role_family: job.role_family,
      }));

      // Matching/total counts come from the centralised cap rule above. The
      // matching set was already sliced to counts.jobsCap, so entry.jobs.length
      // now equals counts.matchingCount and is authoritative for downstream
      // consumers (enforceJobCountIntegrity, dedupeByName).
      const matchingCount = counts.matchingCount;
      const activeOpeningsTotal = counts.activeOpeningsTotal;
      const latestFromJobs = entry.jobs.reduce<string | null>((latest, job) => {
        const ts = job.posted_at ?? job.createdAt;
        if (!ts) return latest;
        if (!latest || Date.parse(ts) > Date.parse(latest)) return ts;
        return latest;
      }, null);
      const latestJobSeenAt = totalActive?.latestSeenAt ?? latestFromJobs;
      const company = companyById.get(entry.id);

      return {
        id: entry.id,
        name: entry.company,
        location: entry.location,
        domain: entry.domain,
        industry: entry.industry,
        description: entry.description,
        logo_url: entry.logo_url,
        is_hiring: entry.is_hiring,
        metadata: entry.metadata,
        created_at: entry.created_at,
        updated_at: entry.updated_at,
        // Server-enforced integrity: card count must always reflect real aggregated jobs.
        jobCount: matchingCount,
        open_roles_count: matchingCount,
        // Architecture aggregations (company-first, intent-driven).
        active_openings_matching_filters: matchingCount,
        active_openings_total: activeOpeningsTotal,
        latest_job_seen_at: latestJobSeenAt,
        top_roles: rolesSummary.slice(0, 5),
        revenue_band: company ? getRevenueBandLabel(company) : entry.revenueCategory,
        domain_tags: extractStringArray(company?.domain_tags),
        domains: Array.from(entry.domains),
        rolesSummary,
        revenueCategory: entry.revenueCategory,
        revenue: entry.revenue,
        companyMeta: {
          company: entry.company,
          revenueCategory: entry.revenueCategory,
          revenue: entry.revenue,
          location: entry.location,
        },
        jobs: entry.jobs,
        roles: embeddedRoles,
        role_families: roleFamilies,
      };
    })
    .sort((a, b) => b.jobCount - a.jobCount);
}

type AggregatedCompany = ReturnType<typeof groupByCompany>[number];
type ValidatedCompany = AggregatedCompany & {
  primaryCount?: number;
  mergedCount?: number;
  discrepancy?: number;
  jobSpyCount?: number;
  enhanced?: boolean;
  source_discrepancy?: boolean;
  indeedEstimate?: number;
  confidence?: "confirmed" | "enhanced" | "low";
  count_diagnostics?: CountDiagnostics;
  count_contract?: CompanyCountContract;
};

function readBoolFlag(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
  fallback: boolean
): boolean {
  const raw = metadata?.[key];
  return typeof raw === "boolean" ? raw : fallback;
}

function readSourceStatus(
  metadata: Record<string, unknown> | null | undefined
): string | null {
  const raw = metadata?.["source_status"];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function isCommonFilterCombination(filters: {
  domain?: DomainKey;
  revenueCategory?: RevenueCategoryKey;
}) {
  const commonDomains = new Set<DomainKey>(["finance", "hr", "sales", "healthcare", "ai"]);
  return (
    filters.revenueCategory === "100m_600m" ||
    (filters.domain ? commonDomains.has(filters.domain) : false)
  );
}

function isMissingCriticalData(company: AggregatedCompany): boolean {
  const missingLocation = !asLowerText(company.location);
  const missingRoles = !company.rolesSummary || company.rolesSummary.length === 0;
  return missingLocation || missingRoles;
}

function buildFallbackQueryTerms(context: {
  query?: string;
  domain?: DomainKey;
  role?: string;
}) {
  return [context.query, context.role, context.domain].filter((value) => Boolean(value)).join(" ");
}

function getQueryTokens(query: string): string[] {
  return query
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 2);
}

function jobMatchesFilters(
  job: GroupedJob,
  filters: {
    domain?: DomainKey;
    role?: string;
    query?: string;
  },
  options?: {
    allowPartialRoleMatch?: boolean;
    allowBroadDomainMatch?: boolean;
    allowPartialQueryMatch?: boolean;
  }
) {
  const query = normaliseFreeText(filters.query);
  const allowPartialRoleMatch = options?.allowPartialRoleMatch ?? false;
  const allowBroadDomainMatch = options?.allowBroadDomainMatch ?? false;
  const allowPartialQueryMatch = options?.allowPartialQueryMatch ?? false;
  const roleFilter = asLowerText(filters.role);
  const title = asLowerText(job.title);
  const description = asLowerText(job.description);
  const company = asLowerText(job.company);
  const roleLabels = (job.roles ?? []).map((role) => asLowerText(role));
  const haystack = [title, description, company, roleLabels.join(" ")].join(" ");

  const domainMatch = !filters.domain
    ? true
    : job.domainKeys?.includes(filters.domain) ||
      (allowBroadDomainMatch && haystack.includes(filters.domain));

  const roleMatch = !roleFilter
    ? true
    : job.roleKeys?.includes(roleFilter) ||
      roleLabels.some((role) => role.includes(roleFilter)) ||
      title.includes(roleFilter) ||
      (allowPartialRoleMatch && haystack.includes(roleFilter));

  const queryTokens = getQueryTokens(query);
  const queryMatch = !query
    ? true
    : queryTokens.length > 0
      ? queryTokens.some((token) => haystack.includes(token)) ||
        (allowPartialQueryMatch && haystack.includes(query))
      : haystack.includes(query);

  return domainMatch && roleMatch && queryMatch;
}

async function fetchIndeedEstimate(searchQuery: string): Promise<number | null> {
  const query = searchQuery.trim();
  if (!query) return null;

  const url = new URL("https://www.indeed.com/jobs");
  url.searchParams.set("q", query);
  url.searchParams.set("l", "");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const html = await response.text();
    const patterns = [
      /Page\s+\d+\s+of\s+([\d,]+)\s+jobs?/i,
      /About\s+([\d,]+)\s+jobs?/i,
      /([\d,]+)\s+jobs?\s+found/i,
      /([\d,]+)\s+openings?/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (!match) continue;

      const estimate = Number(match[1].replaceAll(",", ""));
      if (Number.isFinite(estimate)) return estimate;
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function validateAgainstIndeed(
  companies: ValidatedCompany[],
  context: { query?: string; domain?: DomainKey; role?: string }
): Promise<ValidatedCompany[]> {
  return Promise.all(
    companies.map(async (company) => {
      const shouldValidate = company.jobCount <= 1 || (company.discrepancy ?? 0) > 0;
      if (!shouldValidate) return company;

      const searchQuery = [company.name, buildFallbackQueryTerms(context)]
        .filter((value) => Boolean(value))
        .join(" ")
        .trim();
      const estimate = await fetchIndeedEstimate(searchQuery);
      if (estimate == null) return company;

      const significantlyHigher = estimate >= Math.max(company.jobCount + 2, company.jobCount * 2, 3);
      if (!significantlyHigher) {
        return {
          ...company,
          indeedEstimate: estimate,
        };
      }

      console.warn("Indeed discrepancy detected", {
        company: company.name,
        internalJobCount: company.jobCount,
        indeedEstimate: estimate,
        searchQuery,
      });

      return {
        ...company,
        indeedEstimate: estimate,
        source_discrepancy: true,
        confidence: "low" as const,
      };
    })
  );
}

function buildEmbeddedRoles(jobs: GroupedJob[]): EmbeddedRole[] {
  return jobs.map((job) => ({
    id: job.id,
    title: job.title,
    location: job.location,
    remote: job.remote,
    employment_type: job.employment_type,
    seniority: job.seniority,
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    url: job.url,
    ghost_score: job.ghost_score,
    posted_at: job.posted_at,
    role_family: job.role_family,
  }));
}

function buildCompanySummariesFromJobs(jobs: GroupedJob[]) {
  const rolesMap = new Map<string, number>();
  const roleFamilies = new Map<string, number>();
  const domains = new Set<string>();

  jobs.forEach((job) => {
    job.roles.forEach((role) => {
      rolesMap.set(role, (rolesMap.get(role) ?? 0) + 1);
    });
    job.roleKeys.forEach((roleKey) => {
      roleFamilies.set(roleKey, (roleFamilies.get(roleKey) ?? 0) + 1);
    });
    job.domains.forEach((domain) => {
      domains.add(domain);
    });
  });

  const rolesSummary = Array.from(rolesMap.entries())
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count);

  const role_families = Array.from(roleFamilies.entries()).reduce<Record<string, number>>(
    (acc, [family, count]) => {
      acc[family] = count;
      return acc;
    },
    {}
  );

  return {
    domains: Array.from(domains),
    rolesSummary,
    role_families,
    roles: buildEmbeddedRoles(jobs),
  };
}

async function enforceMinimumJobs(
  companies: ValidatedCompany[],
  query: string,
  filters: {
    domain?: DomainKey;
    role?: string;
    revenueCategory?: RevenueCategoryKey;
  }
): Promise<ValidatedCompany[]> {
  const normalizedQuery = normaliseFreeText(query);

  return Promise.all(
    companies.map(async (company) => {
      const needsMinJobsFallback = company.jobs.length <= 1;
      const needsCriticalDataFallback = isMissingCriticalData(company);
      if (!needsMinJobsFallback && !needsCriticalDataFallback) return company;

      if (needsMinJobsFallback) {
        console.warn("Low job count detected → JobSpy triggered", {
          company: company.name,
          jobCount: company.jobCount,
        });
      }
      if (needsCriticalDataFallback) {
        console.warn("Critical data missing for:", company.name, {
          locationMissing: !asLowerText(company.location),
          rolesMissing: !company.rolesSummary || company.rolesSummary.length === 0,
        });
      }

      const fallbackQuery = [company.name, normalizedQuery, filters.role, filters.domain]
        .filter((value) => Boolean(value))
        .join(" ")
        .trim();
      const fallback = await fetchJobSpyJobs(fallbackQuery || company.name);
      if (fallback.length === 0) return company;

      const fallbackJobs: GroupedJob[] = fallback.map((job) => ({
        id: job.id,
        title: job.title,
        company: company.name,
        companyId: company.id,
        roles: job.roles,
        roleKeys: job.roleKeys,
        domains: job.domains,
        domainKeys: job.domainKeys,
        skills: [],
        description: job.description,
        location: job.location,
        createdAt: new Date().toISOString(),
        revenueCategory: company.revenueCategory,
        revenue: company.revenue,
        source: "jobspy",
      }));

      const mergedJobs = mergeJobs(company.jobs, fallbackJobs);
      const filteredJobs = filterByRevenueCategory(
        filterJobs(
          mergedJobs,
          {
            domain: filters.domain,
            role: filters.role,
            query: normalizedQuery,
          },
          {
            allowPartialRoleMatch: true,
            allowBroadDomainMatch: true,
            allowPartialQueryMatch: true,
          }
        ),
        filters.revenueCategory
      );

      if (filteredJobs.length <= company.jobs.length && !needsCriticalDataFallback) return company;

      console.log("Enhancing company data:", company.name);

      const summaries = buildCompanySummariesFromJobs(filteredJobs);
      const fallbackLocation =
        company.location ??
        filteredJobs.find((job) => asLowerText(job.location))?.location ??
        null;
      const primaryCount = company.primaryCount ?? 0;
      const mergedCount = Math.max(filteredJobs.length, company.jobCount);
      const discrepancy = mergedCount - primaryCount;
      const enhancedJobs = filteredJobs.length > 0 ? filteredJobs : company.jobs;

      return {
        ...company,
        location: fallbackLocation,
        jobs: enhancedJobs,
        jobCount: enhancedJobs.length,
        open_roles_count: enhancedJobs.length,
        domains: summaries.domains.length > 0 ? summaries.domains : company.domains,
        rolesSummary: summaries.rolesSummary.length > 0 ? summaries.rolesSummary : company.rolesSummary,
        roles: summaries.roles.length > 0 ? summaries.roles : company.roles,
        role_families:
          Object.keys(summaries.role_families).length > 0
            ? summaries.role_families
            : company.role_families,
        primaryCount,
        mergedCount,
        discrepancy,
        jobSpyCount: Math.max(0, discrepancy),
        enhanced: true,
        confidence: discrepancy > 0 ? ("enhanced" as const) : ("confirmed" as const),
      };
    })
  );
}

function enforceJobCountIntegrity(companies: ValidatedCompany[]): ValidatedCompany[] {
  return companies.map((company) => {
    const expected = company.jobs.length;
    if (company.jobCount !== expected) {
      console.error("DATA MISMATCH:", company.name, "jobCount=", company.jobCount, "jobs.length=", expected);
    }

    return {
      ...company,
      jobCount: expected,
      open_roles_count: expected,
    };
  });
}

function logValidationSummary(context: {
  totalPrimaryJobs: number;
  totalMergedJobs: number;
  filteredJobs: number;
  companiesReturned: number;
  companies: ValidatedCompany[];
}) {
  console.log("Validation summary:", {
    totalJobsFetched: context.totalPrimaryJobs,
    mergedJobsCount: context.totalMergedJobs,
    filteredJobCount: context.filteredJobs,
    companiesReturned: context.companiesReturned,
    jobsPerCompany: context.companies.map((company) => ({
      company: company.name,
      jobCount: company.jobCount,
      jobsLength: company.jobs.length,
    })),
  });

  context.companies.forEach((company) => {
    console.log("Company job count:", {
      company: company.name,
      jobCount: company.jobCount,
      jobsLength: company.jobs.length,
    });

    if (company.jobCount <= 1) {
      console.warn("Company with only 1 job after validation:", company.name);
    }
    if (!asLowerText(company.location)) {
      console.warn("Missing location after validation:", company.name);
    }
  });
}

function mergeJobs(primaryJobs: GroupedJob[], jobSpyJobs: GroupedJob[]): GroupedJob[] {
  const merged: GroupedJob[] = [];
  const seenPrimaryIds = new Set<string>();
  const seenCompanyTitle = new Set<string>();

  for (const job of primaryJobs) {
    const idKey = (job.id || "").trim();
    if (idKey && seenPrimaryIds.has(idKey)) continue;

    if (idKey) seenPrimaryIds.add(idKey);
    seenCompanyTitle.add(`${normalizeKeyPart(job.company)}::${normalizeKeyPart(job.title)}`);
    merged.push(job);
  }

  for (const job of jobSpyJobs) {
    const key = `${normalizeKeyPart(job.company)}::${normalizeKeyPart(job.title)}`;
    if (seenCompanyTitle.has(key)) continue;
    seenCompanyTitle.add(key);
    merged.push(job);
  }

  return merged;
}

function filterJobs(
  jobs: GroupedJob[],
  filters: {
    domain?: DomainKey;
    role?: string;
    query?: string;
  },
  options?: {
    allowPartialRoleMatch?: boolean;
    allowBroadDomainMatch?: boolean;
    allowPartialQueryMatch?: boolean;
  }
) {
  return jobs.filter((job) => jobMatchesFilters(job, filters, options));
}

function filterByRevenueCategory(jobs: GroupedJob[], category?: RevenueCategoryKey) {
  if (!category) return jobs;

  return jobs.filter((job) => {
    const revenueKeyFromNumber = getRevenueCategoryKey(job.revenue ?? null);
    const revenueKeyFromLabel = REVENUE_KEY_BY_LABEL[asLowerText(job.revenueCategory)];
    return revenueKeyFromNumber === category || revenueKeyFromLabel === category;
  });
}

function companyMatchesRevenueFilters(
  company: CompanyRow,
  options: {
    revenueCategory?: RevenueCategoryKey;
    revenueBand?: string;
    minRevenue?: number;
    maxRevenue?: number;
    includeUnknownRevenue: boolean;
  }
): boolean {
  const revenue = getCompanyRevenue(company.metadata);
  const storedBand = company.revenue_band?.trim() || null;

  // Exact seed-band filter ("$1B-$10B"…"$500B+"): match the denormalised
  // companies.revenue_band column directly so seeded companies without metadata
  // revenue still filter correctly.
  if (options.revenueBand) {
    const wantKey = canonicalBandKey(options.revenueBand);
    if (!storedBand || canonicalBandKey(storedBand) !== wantKey) return false;
  }

  if (options.revenueCategory) {
    // Prefer the stored band (covers seeded companies with no metadata revenue),
    // falling back to the metadata-derived numeric category.
    const bandKey = revenueBandToCategoryKey(storedBand);
    const revenueKey = bandKey ?? getRevenueCategoryKey(revenue);
    if (revenueKey !== options.revenueCategory) return false;
  }

  const shouldFilterRevenueRange =
    typeof options.minRevenue === "number" || typeof options.maxRevenue === "number";

  if (!shouldFilterRevenueRange) return true;

  const effectiveMinRevenue =
    typeof options.minRevenue === "number" ? options.minRevenue : Number.MIN_SAFE_INTEGER;
  const effectiveMaxRevenue =
    typeof options.maxRevenue === "number" ? options.maxRevenue : Number.MAX_SAFE_INTEGER;

  return hasRevenueOverlap(
    company.metadata,
    effectiveMinRevenue,
    effectiveMaxRevenue,
    options.includeUnknownRevenue
  );
}

function validateCompanyCounts(
  primaryGrouped: ReturnType<typeof groupByCompany>,
  mergedGrouped: ReturnType<typeof groupByCompany>
) {
  return mergedGrouped.map((company) => {
    const primary = primaryGrouped.find((c) => c.name === company.name);
    const primaryCount = primary?.jobCount ?? 0;
    const mergedCount = company.jobCount;
    const discrepancy = mergedCount - primaryCount;

    return {
      ...company,
      primaryCount,
      mergedCount,
      discrepancy,
      jobSpyCount: Math.max(0, discrepancy),
      enhanced: discrepancy > 0,
      confidence: discrepancy > 0 ? ("enhanced" as const) : ("confirmed" as const),
    };
  });
}

function normaliseRoleFamily(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  if (value.includes("full") && (value.includes("stack") || value.includes("full-stack"))) return "fullstack";
  if (value.includes("frontend") || value.includes("front-end") || value.includes("front end")) return "frontend";
  if (value.includes("backend") || value.includes("back-end") || value.includes("back end")) return "backend";
  if (
    value.includes("machine learning") ||
    value.includes("deep learning") ||
    value.includes("nlp") ||
    value.includes("computer vision") ||
    (value.includes("ml") && value.includes("engineer")) ||
    (value.includes("ai") && value.includes("engineer"))
  ) return "ml";
  if (
    (value.includes("data") && (value.includes("engineer") || value.includes("scientist") || value.includes("analyst"))) ||
    value.includes("analytics engineer")
  ) return "data";
  if (
    value.includes("devops") ||
    value.includes("dev-ops") ||
    value.includes("sre") ||
    value.includes("site reliability") ||
    value.includes("infrastructure") ||
    value.includes("platform engineer") ||
    value.includes("cloud engineer")
  ) return "devops";
  if (value.includes("mobile") || value.includes("ios") || value.includes("android")) return "mobile";
  if (value.includes("engineer") || value.includes("developer") || value.includes("software")) return "engineer";

  return null;
}

function inferRoleFamilyFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title.toLowerCase();

  if (/full[\s-]?stack/.test(t)) return "fullstack";
  if (/frontend|front[\s-]end/.test(t)) return "frontend";
  if (/backend|back[\s-]end/.test(t)) return "backend";
  if (/machine\s+learning|deep\s+learning|\bnlp\b|computer\s+vision|ml\s+engineer|ai\s+engineer/.test(t)) return "ml";
  if (/data\s+(engineer|scientist|analyst|science)|analytics\s+engineer/.test(t)) return "data";
  if (/devops|dev[\s-]ops|site\s+reliability|\bsre\b|infrastructure\s+eng|platform\s+eng|cloud\s+eng/.test(t)) return "devops";
  if (/\bmobile\b|\bios\b|\bandroid\b|react\s+native/.test(t)) return "mobile";
  if (/software\s+engineer|software\s+developer|\bengineer\b|\bdeveloper\b/.test(t)) return "engineer";

  return null;
}

function getRoleFamily(role: RoleRow): string | null {
  const metadata = role.metadata ?? {};
  const direct =
    normaliseRoleFamily(metadata["role_family"]) ??
    normaliseRoleFamily(metadata["roleFamily"]) ??
    normaliseRoleFamily(metadata["job_category"]) ??
    normaliseRoleFamily(metadata["jobCategory"]);

  if (direct) return direct;
  return inferRoleFamilyFromTitle(role.title);
}

const DEFAULT_PAGE_SIZE = 20;

// Build a zero-opening card for a monitored/seeded company that currently has
// no active roles. Shapes match the grouped-company output so the UI renders it
// identically to companies that do have openings — just with counts of 0.
function buildZeroOpeningCompany(company: CompanyRow): ValidatedCompany {
  const revenue = getCompanyRevenue(company.metadata);
  const sourceTotal = getSourceOpeningsTotal(company.metadata) ?? 0;
  return {
    id: company.id,
    name: company.name,
    location: company.location ?? "Unknown",
    domain: company.domain,
    industry: company.industry,
    description: company.description,
    logo_url: company.logo_url,
    is_hiring: company.is_hiring ?? false,
    metadata: company.metadata,
    created_at: company.created_at,
    updated_at: company.updated_at,
    jobCount: 0,
    open_roles_count: 0,
    active_openings_matching_filters: 0,
    active_openings_total: sourceTotal,
    latest_job_seen_at: null,
    top_roles: [],
    revenue_band: getRevenueBandLabel(company),
    domain_tags: extractStringArray(company.domain_tags),
    domains: [],
    rolesSummary: [],
    revenueCategory: getRevenueCategoryLabel(revenue),
    revenue,
    companyMeta: {
      company: company.name,
      revenueCategory: getRevenueCategoryLabel(revenue),
      revenue,
      location: company.location ?? "Unknown",
    },
    jobs: [],
    roles: [],
    role_families: {},
    primaryCount: 0,
    mergedCount: 0,
    discrepancy: 0,
    jobSpyCount: 0,
    enhanced: false,
    confidence: "confirmed",
  } as ValidatedCompany;
}

// Count populated metadata keys as a coarse "richness" signal used only as a
// tiebreaker when picking which of several same-named rows to surface.
function metadataRichness(metadata: Record<string, unknown> | null | undefined): number {
  if (!metadata) return 0;
  return Object.values(metadata).filter(
    (v) => v !== null && v !== undefined && v !== ""
  ).length;
}

// Merge company entries that share a normalised name so a stale legacy row can
// never out-rank a source-backed/monitored duplicate. The winner is the row
// with the highest persisted source_openings_total, then the richest metadata,
// then the most matching openings. The merged card keeps the largest
// active_openings_total and the union of matching jobs so no real openings are
// dropped, and zero-opening companies are preserved (a single name yields a
// single card, never hidden).
function dedupeByName(companies: ValidatedCompany[]): ValidatedCompany[] {
  const groups = new Map<string, ValidatedCompany[]>();
  const order: string[] = [];
  for (const company of companies) {
    const key = normalizeKeyPart(company.name);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(company);
  }

  const score = (c: ValidatedCompany): [number, number, number] => [
    getSourceOpeningsTotal(c.metadata) ?? -1,
    metadataRichness(c.metadata),
    c.active_openings_matching_filters ?? c.jobCount ?? 0,
  ];

  const result: ValidatedCompany[] = [];
  for (const key of order) {
    const members = groups.get(key)!;
    if (members.length === 1) {
      // Even a lone row is re-capped against its own resolved source inventory:
      // an exact total persisted on the row must cap its matching/jobs counts so
      // a stale role set on a single (un-duplicated) company can't display past
      // the live careers-site count. groupByCompany already does this upstream;
      // this is the belt-and-suspenders guarantee at the final aggregation step.
      result.push(capCompanyToSourceTotal(members[0]));
      continue;
    }
    const winner = members.reduce((best, current) => {
      const [bs, bm, bj] = score(best);
      const [cs, cm, cj] = score(current);
      if (cs !== bs) return cs > bs ? current : best;
      if (cm !== bm) return cm > bm ? current : best;
      return cj > bj ? current : best;
    });
    // Resolve the authoritative source inventory across all duplicates. An exact
    // total caps both the matching set and the displayed total; a non-exact total
    // is only a lower bound.
    const resolved = resolveSourceTotal(members);
    // Keep the largest known total and the richest matching set across the
    // duplicates so merging never lowers a count or drops openings.
    const mergedMatching = members.reduce(
      (max, c) => Math.max(max, c.active_openings_matching_filters ?? c.jobCount ?? 0),
      0
    );
    const mergedTotal = members.reduce(
      (max, c) => Math.max(max, c.active_openings_total ?? 0),
      0
    );
    let mostJobs = members.reduce(
      (best, c) => (c.jobs.length > best.jobs.length ? c : best),
      winner
    );
    // Centralised cap rule across the merged duplicates: an exact live inventory
    // caps the matching set and the surfaced jobs (so two legacy duplicate rows
    // can't push the count past what the careers site shows) and is used verbatim
    // as the total. A non-exact total only ever raises the count as a lower bound.
    const counts = resolveDisplayedCounts(resolved, {
      dedupedActive: mergedTotal,
      matchingCount: mergedMatching,
    });
    if (mostJobs.jobs.length > counts.jobsCap) {
      mostJobs = { ...mostJobs, jobs: mostJobs.jobs.slice(0, counts.jobsCap) };
    }
    result.push({
      ...winner,
      jobs: mostJobs.jobs,
      roles: mostJobs.roles,
      rolesSummary: mostJobs.rolesSummary,
      top_roles: winner.top_roles ?? mostJobs.top_roles,
      jobCount: mostJobs.jobs.length,
      open_roles_count: mostJobs.jobs.length,
      active_openings_matching_filters: counts.matchingCount,
      active_openings_total: counts.activeOpeningsTotal,
    });
  }
  return result;
}

// Re-cap a single aggregated company against its own resolved source inventory.
// Used for the lone-row dedupe path so an exact total persisted on the row caps
// its matching/jobs counts and is used verbatim as the displayed total, matching
// the multi-duplicate path exactly.
function capCompanyToSourceTotal(company: ValidatedCompany): ValidatedCompany {
  const resolved = resolveSourceTotal([company]);
  if (resolved.exactTotal === null && resolved.nonExactTotal === null) return company;
  const matching = company.active_openings_matching_filters ?? company.jobCount ?? 0;
  const counts = resolveDisplayedCounts(resolved, {
    dedupedActive: company.active_openings_total ?? matching,
    matchingCount: matching,
  });
  const jobs = company.jobs.length > counts.jobsCap ? company.jobs.slice(0, counts.jobsCap) : company.jobs;
  return {
    ...company,
    jobs,
    jobCount: jobs.length,
    open_roles_count: jobs.length,
    active_openings_matching_filters: counts.matchingCount,
    active_openings_total: counts.activeOpeningsTotal,
  };
}

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const debug = req.nextUrl.searchParams.get("debug") === "true";
  const parsed = companyQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const {
    page,
    pageSize,
    family,
    role,
    roleFamily,
    roleCategory,
    domain,
    revenueCategory,
    isHiring,
    q,
    minRevenue,
    maxRevenue,
    includeUnknownRevenue,
    includeZeroOpenings,
    revenueBand,
  } = parsed.data;

  // An explicit USD revenue window must not be polluted by companies that carry
  // no revenue metadata. Those companies are only included in an explicit range
  // when the caller opts in (includeUnknownRevenue=true). For a category/band
  // filter (or no revenue filter) the legacy default of including them stands.
  const hasExplicitRevenueRange =
    typeof minRevenue === "number" || typeof maxRevenue === "number";
  const effectiveIncludeUnknownRevenue = resolveIncludeUnknownRevenue(
    includeUnknownRevenue,
    hasExplicitRevenueRange
  );

  const smartQuery = parseSmartQuery(q);
  // Accept all four role-family param spellings (role/family/roleFamily/
  // roleCategory) so production callers passing roleFamily=… or roleCategory=…
  // are no longer silently ignored. The smart query is the last-resort fallback.
  const effectiveRole =
    role ?? family ?? roleFamily ?? roleCategory ?? smartQuery.detectedRole;
  const effectiveDomain = domain ?? smartQuery.detectedDomain;
  const freeText = normaliseFreeText(smartQuery.remainingQuery || q);

  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();

  const enforceOpenRoles = isHiring !== false;
  console.log("Primary fetch complete", {
    query: q ?? "",
    isHiring,
    page,
    pageSize,
    revenueCategory,
    domain,
    role: effectiveRole,
  });
  const { data: companies, error: companiesErr } = await fetchAllCompanies(supabase, isHiring);
  if (companiesErr) {
    return NextResponse.json({ error: companiesErr.message }, { status: 500 });
  }

  const revenueScopedCompanies = (companies ?? []).filter((company) =>
    companyMatchesRevenueFilters(company, {
      revenueCategory,
      revenueBand,
      minRevenue,
      maxRevenue,
      includeUnknownRevenue: effectiveIncludeUnknownRevenue,
    })
  );

  // Company-name search scope. When the free-text query matches one or more
  // company names, the caller is asking for *that company* (e.g. "Walmart"),
  // not for every company whose job descriptions mention the term. Narrow the
  // whole pipeline (roles, jobs, JobSpy, grouping) to the matched companies and
  // rank by name-match strength. This prevents an unrelated high-count company
  // (e.g. Pinterest's 176) from leaking into a Walmart/Apple/NVIDIA search via
  // the cross-company fallback paths below.
  // Aliases let a short-name query reach the row stored under its legal name:
  // "Google" → Alphabet (or ats_slug "google"), "Meta" → Meta Platforms (or
  // ats_slug "meta").
  const aliasTargets = freeText ? new Set(resolveCompanyNameAliases(freeText)) : new Set<string>();
  const companyNameMatches = freeText
    ? revenueScopedCompanies
        .map((company) => {
          let strength = companyNameMatchStrengthWithAliases(company.name, freeText);
          // ats_slug match: a query whose alias set includes this company's stored
          // ATS slug is an exact targeting hit (e.g. "google" → ats_slug "google"
          // on the Alphabet row).
          const slug =
            typeof company.metadata?.["ats_slug"] === "string"
              ? (company.metadata["ats_slug"] as string).trim().toLowerCase()
              : "";
          if (slug && aliasTargets.has(slug)) strength = Math.max(strength, 3);
          return { company, strength };
        })
        .filter((entry) => entry.strength > 0)
    : [];
  const isCompanyScopedSearch = companyNameMatches.length > 0;
  const companyNameStrengthByKey = new Map<string, number>(
    companyNameMatches.map((entry) => [normalizeKeyPart(entry.company.name), entry.strength])
  );

  // In a company-scoped search the universe of companies considered downstream is
  // exactly the name matches; otherwise it stays the full revenue-scoped set.
  const pipelineCompanies = isCompanyScopedSearch
    ? companyNameMatches.map((entry) => entry.company)
    : revenueScopedCompanies;

  const scopedCompanyIds = pipelineCompanies.map((company) => company.id);
  const { data: roleRows, error: rolesErr } = await fetchAllActiveRoles(
    supabase,
    "id,company_id,external_id,source,title,description,location,remote,employment_type,seniority,salary_min,salary_max,url,ghost_score,posted_at,created_at,metadata",
    scopedCompanyIds
  );

  if (rolesErr) {
    return NextResponse.json({ error: rolesErr.message }, { status: 500 });
  }

  const companyById = new Map(pipelineCompanies.map((company) => [company.id, company]));
  const companyByName = new Map(
    pipelineCompanies.map((company) => [normalizeKeyPart(company.name), company])
  );

  // Resolve the authoritative source inventory per normalised company name across
  // *all* duplicate rows (different company_ids, same name). This is what lets a
  // legacy duplicate carrying source_openings_total=176/exact=true cap the count
  // even when the displayed row's metadata is empty.
  const rowsByName = new Map<string, CompanyRow[]>();
  for (const company of pipelineCompanies) {
    const key = normalizeKeyPart(company.name);
    const bucket = rowsByName.get(key) ?? [];
    bucket.push(company);
    rowsByName.set(key, bucket);
  }
  const sourceTotalByCompany = new Map<string, ResolvedSourceTotal>();
  for (const [key, rows] of rowsByName) {
    sourceTotalByCompany.set(key, resolveSourceTotal(rows));
  }

  // Resolve each role's company name so duplicate company_ids for the same
  // company collapse to one identity. Roles whose company_id isn't in scope (or
  // is missing) are dropped — they can't be attributed to a displayed company.
  const companyNameById = new Map(
    pipelineCompanies.map((company) => [company.id, normalizeKeyPart(company.name)])
  );

  // Dedupe active roles by canonical job identity, scoped to the company *name*
  // (not company_id) so a stale legacy row and the freshly-refreshed source row
  // for the same opening — even under different duplicate company_ids — count
  // once. The first row seen per identity wins; rows are pre-sorted newest-first
  // below per company, but for the dedup pass we keep insertion order and let the
  // canonical key collapse the rest. Totals are then keyed by company name to
  // match how groupByCompany aggregates.
  const rolesByCompany = new Map<string, RoleRow[]>();
  const totalActiveByCompany = new Map<string, { count: number; latestSeenAt: string | null }>();
  const seenCanonicalByName = new Map<string, Set<string>>();
  for (const roleRow of roleRows ?? []) {
    if (!roleRow.company_id) continue;
    const companyKey = companyNameById.get(roleRow.company_id);
    if (!companyKey) continue;

    const canonical = canonicalRoleKey(roleRow, companyKey);
    const seen = seenCanonicalByName.get(companyKey) ?? new Set<string>();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    seenCanonicalByName.set(companyKey, seen);

    const bucket = rolesByCompany.get(roleRow.company_id) ?? [];
    bucket.push(roleRow);
    rolesByCompany.set(roleRow.company_id, bucket);

    const agg = totalActiveByCompany.get(companyKey) ?? { count: 0, latestSeenAt: null };
    agg.count += 1;
    const seenAt = roleRow.posted_at ?? roleRow.created_at ?? null;
    if (seenAt && (!agg.latestSeenAt || Date.parse(seenAt) > Date.parse(agg.latestSeenAt))) {
      agg.latestSeenAt = seenAt;
    }
    totalActiveByCompany.set(companyKey, agg);
  }

  const primaryJobs: GroupedJob[] = [];
  for (const company of pipelineCompanies) {
    const companyRoles = [...(rolesByCompany.get(company.id) ?? [])].sort((a, b) => {
      const aPosted = a.posted_at ? Date.parse(a.posted_at) : 0;
      const bPosted = b.posted_at ? Date.parse(b.posted_at) : 0;
      return bPosted - aPosted;
    });

    const companyText = [company.name, company.description, company.domain, company.industry]
      .map(asLowerText)
      .filter(Boolean)
      .join(" ");
    const revenue = getCompanyRevenue(company.metadata);
    const revenueLabel = getRevenueCategoryLabel(revenue);

    for (const roleRow of companyRoles) {
      const roleFamily = getRoleFamily(roleRow);
      const roleLabel = inferRoleFamilyLabel(roleFamily);
      const roleDomainKeys = inferJobDomains(company, roleRow);
      const roleDomains = roleDomainKeys.map((d) => DOMAIN_LABELS[d]);
      const metadata = roleRow.metadata ?? {};
      const skills = [
        ...extractStringArray(metadata["skills"]),
        ...extractStringArray(metadata["stack"]),
      ];

      const job: GroupedJob = {
        id: roleRow.id ?? "",
        title: roleRow.title ?? "",
        company: company.name,
        companyId: company.id,
        roles: [roleLabel],
        roleKeys: roleFamily ? [roleFamily] : [],
        domains: roleDomains,
        domainKeys: roleDomainKeys,
        skills,
        description: roleRow.description ?? "",
        location: roleRow.location ?? company.location ?? "Unknown",
        createdAt: roleRow.posted_at ?? roleRow.created_at ?? company.created_at,
        revenueCategory: revenueLabel,
        revenue,
        source: "primary",
        remote: roleRow.remote,
        employment_type: roleRow.employment_type,
        seniority: roleRow.seniority,
        salary_min: roleRow.salary_min,
        salary_max: roleRow.salary_max,
        url: roleRow.url,
        ghost_score: roleRow.ghost_score,
        role_family: roleFamily,
        posted_at: roleRow.posted_at,
      };
      primaryJobs.push(job);
    }
  }

  // When the query is a company-name search, the company is already matched —
  // do NOT re-apply the query as a per-job keyword filter, or we'd drop every
  // role whose title doesn't literally contain the company name (e.g. all of
  // Walmart's roles). Domain/role filters still apply within the company.
  const jobFreeText = isCompanyScopedSearch ? "" : freeText;

  const primaryFiltered = filterJobs(primaryJobs, {
    domain: effectiveDomain,
    role: effectiveRole,
    query: jobFreeText,
  });

  // In pure company-universe mode (zero-openings requested, no active search)
  // we are listing the seeded universe, not hunting for openings — so we skip
  // the JobSpy/Indeed enrichment paths and their external calls entirely.
  const universeListing =
    includeZeroOpenings && !freeText && !effectiveDomain && !effectiveRole;

  let jobSpyJobs: GroupedJob[] = [];
  const shouldTriggerJobSpy =
    !universeListing && (Boolean(freeText) || primaryFiltered.length < 5);
  if (shouldTriggerJobSpy) {
    console.warn("Low job count detected → JobSpy triggered", {
      primaryFiltered: primaryFiltered.length,
      query: freeText || q || "",
    });
    const secondary = await fetchJobSpyJobs(freeText || q || buildFallbackQueryTerms({ domain: effectiveDomain, role: effectiveRole }) || "engineer");
    jobSpyJobs = secondary
      .map((job): GroupedJob | null => {
        const company = companyByName.get(normalizeKeyPart(job.company));
        if (!company) return null;

        const revenue = getCompanyRevenue(company.metadata);
        const revenueCategoryLabel = getRevenueCategoryLabel(revenue);

        const normalizedJob: GroupedJob = {
          id: job.id,
          title: job.title,
          company: company.name,
          companyId: company.id,
          roles: job.roles,
          roleKeys: job.roleKeys,
          domains: job.domains,
          domainKeys: job.domainKeys,
          skills: [],
          description: job.description,
          location: job.location ?? company.location ?? "Unknown",
          createdAt: new Date().toISOString(),
          revenueCategory: revenueCategoryLabel,
          revenue,
          source: "jobspy",
        };

        return normalizedJob;
      })
      .filter((job): job is GroupedJob => job !== null);
  }

  const mergedJobs = mergeJobs(primaryJobs, jobSpyJobs);
  console.log("Revenue categories in dataset:", [...new Set(mergedJobs.map((job) => job.revenueCategory))]);
  console.log("Total jobs:", mergedJobs.length);
  let mergedFiltered = filterJobs(mergedJobs, {
    domain: effectiveDomain,
    role: effectiveRole,
    query: jobFreeText,
  });

  // Empty-dataset fallback. We progressively relax the *filter*, but never widen
  // the *company set*: results are only ever drawn from jobs whose company is in
  // scope (companyByName). In a company-scoped search the scope is the matched
  // company; in an open search it is the full revenue-scoped universe. We never
  // assign the entire unfiltered job set as results — doing so previously let an
  // unrelated high-count company (Pinterest, 176) surface as the top result for
  // a Walmart/Apple/NVIDIA query.
  if (mergedFiltered.length === 0 && !universeListing) {
    console.warn("Fallback triggered due to empty dataset", {
      domain: effectiveDomain,
      role: effectiveRole,
      revenueCategory,
      query: jobFreeText || q || "",
    });
    const relaxedFiltered = filterJobs(
      mergedJobs,
      {
        domain: effectiveDomain,
        role: effectiveRole,
        query: jobFreeText,
      },
      {
        allowPartialRoleMatch: true,
        allowBroadDomainMatch: true,
        allowPartialQueryMatch: true,
      }
    );

    if (relaxedFiltered.length > 0) {
      mergedFiltered = relaxedFiltered;
    } else if (isCompanyScopedSearch) {
      // The matched company has no roles passing the domain/role filter. Surface
      // the company's full deduped role set (mergedJobs is already scoped to it)
      // rather than fanning out to unrelated companies.
      mergedFiltered = mergedJobs;
    } else {
      console.warn("Empty results → fallback triggered", {
        domain: effectiveDomain,
        role: effectiveRole,
        revenueCategory,
        query: jobFreeText || q || "",
      });

      const emptyFallbackQuery =
        buildFallbackQueryTerms({ domain: effectiveDomain, role: effectiveRole, query: jobFreeText || q || "" }) ||
        q ||
        "engineer";
      const emptyFallbackRaw = await fetchJobSpyJobs(emptyFallbackQuery);
      const emptyFallbackJobs: GroupedJob[] = emptyFallbackRaw
        .map((job): GroupedJob | null => {
          const company = companyByName.get(normalizeKeyPart(job.company));
          if (!company) return null;

          const revenue = getCompanyRevenue(company.metadata);
          const revenueCategoryLabel = getRevenueCategoryLabel(revenue);

          const normalizedJob: GroupedJob = {
            id: job.id,
            title: job.title,
            company: company.name,
            companyId: company.id,
            roles: job.roles,
            roleKeys: job.roleKeys,
            domains: job.domains,
            domainKeys: job.domainKeys,
            skills: [],
            description: job.description,
            location: job.location ?? company.location ?? "Unknown",
            createdAt: new Date().toISOString(),
            revenueCategory: revenueCategoryLabel,
            revenue,
            source: "jobspy",
          };

          return normalizedJob;
        })
        .filter((job): job is GroupedJob => job !== null);

      const fallbackMergedJobs = mergeJobs(mergedJobs, emptyFallbackJobs);
      // Only the *relaxed-filter* matches are surfaced. If even the relaxed
      // filter matches nothing, we return an empty set rather than dumping every
      // company's jobs — an honest "no matches" beats a wrong top company.
      mergedFiltered = filterJobs(
        fallbackMergedJobs,
        {
          domain: effectiveDomain,
          role: effectiveRole,
          query: jobFreeText,
        },
        {
          allowPartialRoleMatch: true,
          allowBroadDomainMatch: true,
          allowPartialQueryMatch: true,
        }
      );
    }
  }

  console.log("Filtered jobs count:", mergedFiltered.length);
  console.log("After revenue filter:", mergedFiltered.length);

  const primaryGrouped = groupByCompany(primaryFiltered, companyById, totalActiveByCompany, sourceTotalByCompany);
  const mergedGrouped = groupByCompany(mergedFiltered, companyById, totalActiveByCompany, sourceTotalByCompany);
  const validated = validateCompanyCounts(primaryGrouped, mergedGrouped);
  // Skip JobSpy/Indeed enrichment in pure universe-listing mode (no search):
  // we are enumerating the seeded universe, not validating opening counts, so
  // there is no reason to fan out external requests per company.
  const minimumJobsValidated = universeListing
    ? validated
    : await enforceMinimumJobs(validated, jobFreeText || q || "", {
        domain: effectiveDomain,
        role: effectiveRole,
        revenueCategory,
      });
  const withIntegrity = enforceJobCountIntegrity(minimumJobsValidated);
  const withIndeedValidation = universeListing
    ? withIntegrity
    : await validateAgainstIndeed(withIntegrity, {
        query: jobFreeText || q || "",
        domain: effectiveDomain,
        role: effectiveRole,
      });

  // A company-scoped search must always surface the matched company card, even
  // when it currently has 0 active openings (e.g. its careers source reported
  // an inventory but no role rows are ingested yet). Otherwise enforceOpenRoles
  // would hide the very company the user searched for.
  const withOpenings = withIndeedValidation.filter(
    (company) => !enforceOpenRoles || isCompanyScopedSearch || company.jobCount > 0
  );

  // Company-universe mode: append monitored/seeded companies that currently
  // have 0 active openings so the "All" view shows the full universe (hundreds
  // of companies) organised by revenue band. These pass through the same
  // revenue scoping above (revenueScopedCompanies), so band/category filters
  // still apply. A free-text/domain/role query is intentionally *not* widened
  // here — zero-opening companies have no roles to match, so we only surface
  // them when the caller isn't actively searching for specific openings.
  const annotated = (() => {
    const base = (() => {
      // Company-scoped search: always include every matched company as a card,
      // appending zero-opening placeholders for matches that produced no jobs so
      // the searched-for company is never missing.
      if (isCompanyScopedSearch) {
        const present = new Set(withOpenings.map((c) => c.id));
        const zeros = pipelineCompanies
          .filter((company) => !present.has(company.id))
          .map((company) => buildZeroOpeningCompany(company));
        return [...withOpenings, ...zeros];
      }
      if (!includeZeroOpenings) return withOpenings;
      const present = new Set(withOpenings.map((c) => c.id));
      const isSearchScoped = Boolean(freeText || effectiveDomain || effectiveRole);
      if (isSearchScoped) return withOpenings;
      const zeros = revenueScopedCompanies
        .filter((company) => !present.has(company.id))
        .map((company) => buildZeroOpeningCompany(company));
      return [...withOpenings, ...zeros];
    })();
    // Collapse same-named duplicates (e.g. a stale legacy row alongside a
    // source-backed monitored row) so the stale low count can't win or appear
    // as a second card.
    const deduped = dedupeByName(base);
    // In a company-scoped search, rank by name-match strength first (exact >
    // prefix > substring) so the requested company leads, then by opening count.
    if (isCompanyScopedSearch) {
      return deduped.sort((a, b) => {
        const sa = companyNameStrengthByKey.get(normalizeKeyPart(a.name)) ?? 0;
        const sb = companyNameStrengthByKey.get(normalizeKeyPart(b.name)) ?? 0;
        if (sb !== sa) return sb - sa;
        return (b.active_openings_total ?? b.jobCount) - (a.active_openings_total ?? a.jobCount);
      });
    }
    return deduped;
  })();

  // Per-company count diagnostics. The matching count is filtered by active
  // role/domain/search filters; the deduped role-row count and resolved source
  // inventory are the broader totals we compare against to explain *why* a count
  // is what it is (exact source total vs. filtered subset vs. validation pending
  // vs. source blocked). Computed here, after dedupe, so the final displayed
  // counts are the ones diagnosed.
  const appliedRoleFilters = effectiveRole ? [effectiveRole] : [];
  const appliedDomainFilters = effectiveDomain ? [effectiveDomain] : [];
  // Which opening-narrowing filters are active for this request. A revenue
  // filter scopes the company universe but never narrows a matched company's
  // openings, so it is tracked separately and excluded from count_is_filtered.
  const roleFilterApplied = Boolean(effectiveRole);
  const domainFilterApplied = Boolean(effectiveDomain);
  const searchFilterApplied = Boolean(isCompanyScopedSearch ? false : freeText);
  const revenueFilterApplied = Boolean(
    revenueCategory ||
      revenueBand ||
      typeof minRevenue === "number" ||
      typeof maxRevenue === "number"
  );
  const anyFilterApplied =
    roleFilterApplied ||
    domainFilterApplied ||
    searchFilterApplied ||
    revenueFilterApplied;
  const filtersActiveForCounts = Boolean(
    effectiveRole || effectiveDomain || (isCompanyScopedSearch ? false : freeText)
  );
  const diagnosed = annotated.map((company) => {
    const key = normalizeKeyPart(company.name);
    const resolved =
      sourceTotalByCompany.get(key) ?? { exactTotal: null, nonExactTotal: null };
    const dedupedActiveCount = totalActiveByCompany.get(key)?.count ?? company.jobCount;
    const matchingCount = company.active_openings_matching_filters ?? company.jobCount;
    const count_diagnostics = deriveCountDiagnostics({
      resolved,
      matchingCount,
      dedupedActiveCount,
      sourceStatus: readSourceStatus(company.metadata),
      fetchEnabled: readBoolFlag(company.metadata, "fetch_enabled", false),
      validationEnabled: readBoolFlag(company.metadata, "validation_enabled", true),
      filtersActive: filtersActiveForCounts,
      appliedRoleFilters,
      appliedDomainFilters,
    });
    // Project the internal diagnostics + the route's centralised displayed
    // counts onto the contract's top-level field names. The activeOpeningsTotal
    // and matchingCount here are exactly the cap-resolved counts already on the
    // card — this only labels them, it does not recompute a count.
    const activeOpeningsTotal = company.active_openings_total ?? matchingCount;
    const exactPersisted =
      resolved.exactTotal !== null && isSourceOpeningsExact(company.metadata);
    const count_contract = toCompanyCountContract({
      diagnostics: count_diagnostics,
      activeOpeningsTotal,
      matchingCount,
      exactPersisted,
      exactLastSeenAt: getSourceOpeningsCheckedAt(company.metadata),
      filtersActive: anyFilterApplied,
      roleFilterApplied,
      domainFilterApplied,
      revenueFilterApplied,
      searchFilterApplied,
      ignoredFilters: [],
    });
    return {
      ...company,
      count_diagnostics,
      count_contract,
      // Contract-named top-level fields. The frontend reads these directly and
      // never infers a count type or recomputes an active count.
      exact_source_total: count_contract.exact_source_total,
      exact_source_total_persisted: count_contract.exact_source_total_persisted,
      exact_source_total_last_seen_at: count_contract.exact_source_total_last_seen_at,
      display_count: count_contract.display_count,
      display_count_type: count_contract.display_count_type,
      source_inventory_status: count_contract.source_inventory_status,
      source_inventory_reason: count_contract.source_inventory_reason,
      source_count_method: count_contract.source_count_method,
      filter_diagnostics: count_contract.filter_diagnostics,
    };
  });
  console.log("Companies returned:", diagnosed.length);

  logValidationSummary({
    totalPrimaryJobs: primaryJobs.length,
    totalMergedJobs: mergedJobs.length,
    filteredJobs: mergedFiltered.length,
    companiesReturned: diagnosed.length,
    companies: diagnosed,
  });

  const filtersApplied = {
    domain: effectiveDomain,
    role: effectiveRole,
    family,
    // Echo the accepted role-family aliases so a caller can confirm their param
    // was honoured (roleFamily/roleCategory were previously silently ignored).
    roleFamily,
    roleCategory,
    revenueCategory,
    revenueBand,
    minRevenue,
    maxRevenue,
    includeUnknownRevenue: effectiveIncludeUnknownRevenue,
    includeZeroOpenings,
    q,
    smartQuery,
    jobSpyTriggered: shouldTriggerJobSpy,
    // Response-level filter diagnostics: the resolved role/domain filters applied
    // to the whole request and whether they could reduce visible counts. Per-
    // company filtered_out_openings_count lives in each card's count_diagnostics.
    applied_role_filters: appliedRoleFilters,
    applied_domain_filters: appliedDomainFilters,
    filters_affect_counts: filtersActiveForCounts,
    // Response-level filter diagnostics mirroring the per-company
    // filter_diagnostics object, so a caller can read which filter classes were
    // applied for the whole request without scanning every card.
    filter_diagnostics: {
      has_active_filters: anyFilterApplied,
      role_filter_applied: roleFilterApplied,
      domain_filter_applied: domainFilterApplied,
      revenue_filter_applied: revenueFilterApplied,
      search_filter_applied: searchFilterApplied,
    },
  };

  const queryTimeMs = Date.now() - startedAt;

  return NextResponse.json({
    // Results are never artificially capped: `data` is the full matching set
    // grouped by company. The UI paginates client-side at DEFAULT_PAGE_SIZE.
    data: diagnosed,
    page: page ?? 1,
    // Default to 20 per page when the caller doesn't specify; `total` always
    // reflects the full result set so the UI can represent every company.
    pageSize: pageSize ?? DEFAULT_PAGE_SIZE,
    total: diagnosed.length,
    filters: filtersApplied,
    ...(debug
      ? {
          debug: {
            total_jobs: primaryJobs.length,
            filtered_jobs: mergedFiltered.length,
            companies_returned: diagnosed.length,
            filters_applied: filtersApplied,
            fallbacks_triggered: {
              jobspy: shouldTriggerJobSpy,
              empty_dataset: mergedFiltered.length === 0,
            },
            query_time_ms: queryTimeMs,
          },
        }
      : {}),
  });
}
