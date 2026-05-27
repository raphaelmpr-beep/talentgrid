import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";

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
  skills: string[];
  description: string;
  location?: string | null;
  createdAt: string;
  revenueCategory: string;
  revenue?: number | null;
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

function asLowerText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
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
  const annual = Number(m["annual_revenue"]);
  const min = Number(m["revenue_min"]);
  const max = Number(m["revenue_max"]);

  if (Number.isFinite(annual)) return annual >= minRevenue && annual <= maxRevenue;
  if (Number.isFinite(min) || Number.isFinite(max)) {
    const effectiveMin = Number.isFinite(min) ? min : Number.MIN_SAFE_INTEGER;
    const effectiveMax = Number.isFinite(max) ? max : Number.MAX_SAFE_INTEGER;
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
  const annual = Number(m["annual_revenue"]);
  if (Number.isFinite(annual) && annual > 0) return annual;

  const min = Number(m["revenue_min"]);
  const max = Number(m["revenue_max"]);
  if (Number.isFinite(min) && Number.isFinite(max)) return (min + max) / 2;
  if (Number.isFinite(max)) return max;
  if (Number.isFinite(min)) return min;

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
    if (!map.has(job.companyId)) {
      const company = companyById.get(job.companyId);
      map.set(job.companyId, {
        id: job.companyId,
        company: job.company,
        location: company?.location,
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

    const entry = map.get(job.companyId)!;
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
        jobCount: entry.jobCount,
        open_roles_count: entry.jobCount,
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
  const { data: companies, error: companiesErr } = await fetchAllCompanies(supabase, isHiring);
  if (companiesErr) {
    return NextResponse.json({ error: companiesErr.message }, { status: 500 });
  }

  const { data: roleRows, error: rolesErr } = await fetchAllActiveRoles(
    supabase,
    "id,company_id,title,description,location,remote,employment_type,seniority,salary_min,salary_max,url,ghost_score,posted_at,created_at,metadata"
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

  const shouldFilterRevenue =
    typeof minRevenue === "number" || typeof maxRevenue === "number";
  const effectiveMinRevenue =
    typeof minRevenue === "number" ? minRevenue : Number.MIN_SAFE_INTEGER;
  const effectiveMaxRevenue =
    typeof maxRevenue === "number" ? maxRevenue : Number.MAX_SAFE_INTEGER;

  const revenueFiltered = shouldFilterRevenue
    ? (companies ?? []).filter((company) =>
        hasRevenueOverlap(
          company.metadata,
          effectiveMinRevenue,
          effectiveMaxRevenue,
          includeUnknownRevenue
        )
      )
    : companies ?? [];

  const companyById = new Map(revenueFiltered.map((company) => [company.id, company]));

  const allJobs: GroupedJob[] = [];
  for (const company of revenueFiltered) {
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
    const revenueKey = getRevenueCategoryKey(revenue);
    const revenueLabel = getRevenueCategoryLabel(revenue);

    for (const roleRow of companyRoles) {
      const roleFamily = getRoleFamily(roleRow);
      const roleLabel = inferRoleFamilyLabel(roleFamily);
      const roleDomains = inferJobDomains(company, roleRow).map((d) => DOMAIN_LABELS[d]);
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
        skills,
        description: roleRow.description ?? "",
        location: roleRow.location,
        createdAt: roleRow.posted_at ?? roleRow.created_at ?? company.created_at,
        revenueCategory: revenueLabel,
        revenue,
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

      const domainMatch =
        !effectiveDomain ||
        roleDomains.includes(DOMAIN_LABELS[effectiveDomain]) ||
        detectDomainKeys(`${asLowerText(company.domain)} ${asLowerText(company.industry)}`).has(
          effectiveDomain
        );
      const roleMatch = !effectiveRole || roleFamily === effectiveRole;
      const queryMatch =
        !freeText || companyText.includes(freeText) || roleMatchesFreeText(roleRow, freeText);
      const revenueMatch =
        !revenueCategory || (revenueKey !== null && revenueKey === revenueCategory);

      if (domainMatch && roleMatch && queryMatch && revenueMatch) {
        allJobs.push(job);
      }
    }
  }

  console.log("Filtered jobs count:", allJobs.length);
  const annotated = groupByCompany(allJobs, companyById).filter(
    (company) => !enforceOpenRoles || company.jobCount > 0
  );

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
    },
  });
}
