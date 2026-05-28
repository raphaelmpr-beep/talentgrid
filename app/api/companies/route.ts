import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";
import { fetchJobSpyJobs } from "@/lib/jobs/jobspy";

export const runtime = "nodejs";

type RoleRow = {
  id?: string | null;
  company_id: string | null;
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

function asLowerText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
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

function hasRevenueOverlap(
  metadata: Record<string, unknown> | null | undefined,
  minRevenue: number,
  maxRevenue: number,
  includeUnknownRevenue: boolean
): boolean {
  const m = metadata ?? {};
  const annual = parseNumericValue(m["annual_revenue"]);
  const min = parseNumericValue(m["revenue_min"]);
  const max = parseNumericValue(m["revenue_max"]);

  if (annual !== null) return annual >= minRevenue && annual <= maxRevenue;
  if (min !== null || max !== null) {
    const effectiveMin = min !== null ? min : Number.MIN_SAFE_INTEGER;
    const effectiveMax = max !== null ? max : Number.MAX_SAFE_INTEGER;
    return effectiveMax >= minRevenue && effectiveMin <= maxRevenue;
  }

  return includeUnknownRevenue;
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

function groupByCompany(
  jobs: GroupedJob[],
  companyById: Map<string, CompanyRow>
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
        jobCount: entry.jobs.length,
        open_roles_count: entry.jobs.length,
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
};

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

function normalizeKeyPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
    minRevenue?: number;
    maxRevenue?: number;
    includeUnknownRevenue: boolean;
  }
): boolean {
  const revenue = getCompanyRevenue(company.metadata);

  if (options.revenueCategory) {
    const revenueKey = getRevenueCategoryKey(revenue);
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

export async function GET(req: NextRequest) {
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
    domain,
    revenueCategory,
    isHiring,
    q,
    minRevenue,
    maxRevenue,
    includeUnknownRevenue,
  } = parsed.data;

  const smartQuery = parseSmartQuery(q);
  const effectiveRole = role ?? family ?? smartQuery.detectedRole;
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
      minRevenue,
      maxRevenue,
      includeUnknownRevenue,
    })
  );

  const scopedCompanyIds = revenueScopedCompanies.map((company) => company.id);
  const { data: roleRows, error: rolesErr } = await fetchAllActiveRoles(
    supabase,
    "id,company_id,title,description,location,remote,employment_type,seniority,salary_min,salary_max,url,ghost_score,posted_at,created_at,metadata",
    scopedCompanyIds
  );

  if (rolesErr) {
    return NextResponse.json({ error: rolesErr.message }, { status: 500 });
  }

  const rolesByCompany = new Map<string, RoleRow[]>();
  for (const roleRow of roleRows ?? []) {
    if (!roleRow.company_id) continue;
    const bucket = rolesByCompany.get(roleRow.company_id) ?? [];
    bucket.push(roleRow);
    rolesByCompany.set(roleRow.company_id, bucket);
  }

  const companyById = new Map(revenueScopedCompanies.map((company) => [company.id, company]));
  const companyByName = new Map(
    revenueScopedCompanies.map((company) => [normalizeKeyPart(company.name), company])
  );

  const primaryJobs: GroupedJob[] = [];
  for (const company of revenueScopedCompanies) {
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

  const primaryFiltered = filterJobs(primaryJobs, {
    domain: effectiveDomain,
    role: effectiveRole,
    query: freeText,
  });

  let jobSpyJobs: GroupedJob[] = [];
  const shouldTriggerJobSpy = Boolean(freeText) || primaryFiltered.length < 5;
  if (shouldTriggerJobSpy) {
    console.warn("Low job count detected → JobSpy triggered", {
      primaryFiltered: primaryFiltered.length,
      query: freeText || q || "",
    });
    const secondary = await fetchJobSpyJobs(freeText || q || buildFallbackQueryTerms({ domain: effectiveDomain, role: effectiveRole }) || "engineer");
    jobSpyJobs = secondary
      .map((job) => {
        const company = companyByName.get(normalizeKeyPart(job.company));
        if (!company) return null;

        const revenue = getCompanyRevenue(company.metadata);
        const revenueCategoryLabel = getRevenueCategoryLabel(revenue);

        return {
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
          source: "jobspy" as const,
        };
      })
      .filter((job): job is GroupedJob => job !== null);
  }

  const mergedJobs = mergeJobs(primaryJobs, jobSpyJobs);
  console.log("Revenue categories in dataset:", [...new Set(mergedJobs.map((job) => job.revenueCategory))]);
  console.log("Total jobs:", mergedJobs.length);
  let mergedFiltered = filterJobs(mergedJobs, {
    domain: effectiveDomain,
    role: effectiveRole,
    query: freeText,
  });

  if (mergedFiltered.length === 0) {
    console.warn("Fallback triggered due to empty dataset", {
      domain: effectiveDomain,
      role: effectiveRole,
      revenueCategory,
      query: freeText || q || "",
    });
    const relaxedFiltered = filterJobs(
      mergedJobs,
      {
        domain: effectiveDomain,
        role: effectiveRole,
        query: freeText,
      },
      {
        allowPartialRoleMatch: true,
        allowBroadDomainMatch: true,
        allowPartialQueryMatch: true,
      }
    );

    if (relaxedFiltered.length > 0) {
      mergedFiltered = relaxedFiltered;
    } else {
      console.warn("Empty results → fallback triggered", {
        domain: effectiveDomain,
        role: effectiveRole,
        revenueCategory,
        query: freeText || q || "",
      });

      const emptyFallbackQuery =
        buildFallbackQueryTerms({ domain: effectiveDomain, role: effectiveRole, query: freeText || q || "" }) ||
        q ||
        "engineer";
      const emptyFallbackRaw = await fetchJobSpyJobs(emptyFallbackQuery);
      const emptyFallbackJobs: GroupedJob[] = emptyFallbackRaw
        .map((job) => {
          const company = companyByName.get(normalizeKeyPart(job.company));
          if (!company) return null;

          const revenue = getCompanyRevenue(company.metadata);
          const revenueCategoryLabel = getRevenueCategoryLabel(revenue);

          return {
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
            source: "jobspy" as const,
          };
        })
        .filter((job): job is GroupedJob => job !== null);

      const fallbackMergedJobs = mergeJobs(mergedJobs, emptyFallbackJobs);
      const fallbackRelaxed = filterJobs(
        fallbackMergedJobs,
        {
          domain: effectiveDomain,
          role: effectiveRole,
          query: freeText,
        },
        {
          allowPartialRoleMatch: true,
          allowBroadDomainMatch: true,
          allowPartialQueryMatch: true,
        }
      );

      mergedFiltered = fallbackRelaxed.length > 0 ? fallbackRelaxed : fallbackMergedJobs;
    }
  }

  console.log("Filtered jobs count:", mergedFiltered.length);
  console.log("After revenue filter:", mergedFiltered.length);

  const primaryGrouped = groupByCompany(primaryFiltered, companyById);
  const mergedGrouped = groupByCompany(mergedFiltered, companyById);
  const validated = validateCompanyCounts(primaryGrouped, mergedGrouped);
  const minimumJobsValidated = await enforceMinimumJobs(validated, freeText || q || "", {
    domain: effectiveDomain,
    role: effectiveRole,
    revenueCategory,
  });
  const withIntegrity = enforceJobCountIntegrity(minimumJobsValidated);
  const withIndeedValidation = await validateAgainstIndeed(withIntegrity, {
    query: freeText || q || "",
    domain: effectiveDomain,
    role: effectiveRole,
  });

  const annotated = withIndeedValidation.filter(
    (company) => !enforceOpenRoles || company.jobCount > 0
  );
  console.log("Companies returned:", annotated.length);

  logValidationSummary({
    totalPrimaryJobs: primaryJobs.length,
    totalMergedJobs: mergedJobs.length,
    filteredJobs: mergedFiltered.length,
    companiesReturned: annotated.length,
    companies: annotated,
  });

  return NextResponse.json({
    data: annotated,
    page: page ?? 1,
    pageSize: pageSize ?? annotated.length,
    total: annotated.length,
    filters: {
      domain: effectiveDomain,
      role: effectiveRole,
      family,
      revenueCategory,
      minRevenue,
      maxRevenue,
      includeUnknownRevenue,
      q,
      smartQuery,
      jobSpyTriggered: shouldTriggerJobSpy,
    },
  });
}
