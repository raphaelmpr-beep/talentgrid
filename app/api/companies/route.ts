import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";

export const runtime = "nodejs";

type RoleRow = {
  id?: string | null;
  company_id: string | null;
  title?: string | null;
  location?: string | null;
  remote?: boolean | null;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number | null;
  posted_at?: string | null;
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

type SupabaseClient = NonNullable<Awaited<ReturnType<typeof createClient>>>;

// Safe batch size — kept at 200 so it fits within any reasonable PostgREST
// max_rows setting.  We advance by the *actual* number of rows received rather
// than by ROLE_BATCH_SIZE so that a server-side cap never causes the loop to
// skip pages.
const ROLE_BATCH_SIZE = 200;

async function fetchAllActiveRoles(
  supabase: SupabaseClient,
  columns: string,
  companyIds?: string[]
) {
  if (companyIds && companyIds.length === 0) return { data: [] as RoleRow[], error: null };

  // ── 1. Get exact total so we know when to stop ──────────────────────────
  let countQuery = supabase
    .from("roles")
    .select("*", { count: "exact", head: true })
    .eq("is_active", true)
    .lt("ghost_score", 70);

  if (companyIds) countQuery = countQuery.in("company_id", companyIds);

  const { count: total, error: countError } = await countQuery;
  if (countError) return { data: null, error: countError };
  if (!total) return { data: [] as RoleRow[], error: null };

  // ── 2. Page through results, advancing by rows *actually* received ───────
  const rows: RoleRow[] = [];
  let from = 0;

  while (from < total) {
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
    if (chunk.length === 0) break; // safety: no forward progress
    rows.push(...chunk);
    from += chunk.length; // advance by rows actually returned
  }

  return { data: rows, error: null };
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
    isHiring,
    q,
    minRevenue,
    maxRevenue,
    includeUnknownRevenue,
    minOpenRoles,
  } = parsed.data;

  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();

  // Use live role activity as the source of truth for "hiring" state.
  const enforceOpenRoles = isHiring !== false;
  let hiringCompanyIds: string[] | null = null;
  let familyCompanyIds: string[] | null = null;
  let activeRoles: RoleRow[] = [];
  if (enforceOpenRoles || family) {
    const { data: activeRoleRows, error: rolesErr } = await fetchAllActiveRoles(
      supabase,
      "company_id,title,metadata"
    );

    if (rolesErr) {
      return NextResponse.json({ error: rolesErr.message }, { status: 500 });
    }

    activeRoles = (activeRoleRows ?? []) as RoleRow[];

    if (enforceOpenRoles) {
      // Count active open roles per company so we can enforce minOpenRoles.
      const roleCountPerCompany = new Map<string, number>();
      for (const r of activeRoles) {
        if (typeof r.company_id === "string" && r.company_id.length > 0) {
          roleCountPerCompany.set(
            r.company_id,
            (roleCountPerCompany.get(r.company_id) ?? 0) + 1
          );
        }
      }

      hiringCompanyIds = Array.from(roleCountPerCompany.entries())
        .filter(([, count]) => count >= minOpenRoles)
        .map(([id]) => id);

      if (hiringCompanyIds.length === 0) {
        return NextResponse.json({
          data: [],
          page,
          pageSize,
          total: 0,
          filters: { family, minRevenue, maxRevenue, includeUnknownRevenue, minOpenRoles },
        });
      }
    }

    if (family) {
      familyCompanyIds = Array.from(
        new Set(
          activeRoles
            .filter((r) => getRoleFamily(r) === family)
            .map((r) => r.company_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
        )
      );

      if (familyCompanyIds.length === 0) {
        return NextResponse.json({
          data: [],
          page,
          pageSize,
          total: 0,
          filters: { family, minRevenue, maxRevenue, includeUnknownRevenue, minOpenRoles },
        });
      }
    }
  }

  let query = supabase
    .from("companies")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (enforceOpenRoles && hiringCompanyIds) {
    query = query.in("id", hiringCompanyIds);
  } else if (isHiring === false) {
    query = query.eq("is_hiring", false);
  }

  if (family && familyCompanyIds) {
    query = query.in("id", familyCompanyIds);
  }

  if (q) query = query.ilike("name", `%${q}%`);

  const overlapBranches = [
    `and(metadata->annual_revenue.gte.${minRevenue},metadata->annual_revenue.lte.${maxRevenue})`,
    `and(metadata->revenue_max.gte.${minRevenue},metadata->revenue_min.lte.${maxRevenue})`,
  ];

  if (includeUnknownRevenue) {
    overlapBranches.push(
      "and(metadata->annual_revenue.is.null,metadata->revenue_min.is.null,metadata->revenue_max.is.null)"
    );
  }

  query = query.or(overlapBranches.join(","));

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await query.range(from, to);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ids = rows
    .map((r) => (typeof r.id === "string" ? r.id : null))
    .filter((id): id is string => !!id);

  const counts = new Map<string, number>();
  const familyCounts = new Map<string, Record<string, number>>();
  const rolesMap = new Map<string, EmbeddedRole[]>();
  if (ids.length > 0) {
    const { data: roleRows, error: rolesErr } = await fetchAllActiveRoles(
      supabase,
      "id,company_id,title,location,remote,employment_type,seniority,salary_min,salary_max,url,ghost_score,posted_at,metadata",
      ids
    );

    if (rolesErr) {
      return NextResponse.json({ error: rolesErr.message }, { status: 500 });
    }

    const sortedRoleRows = [...((roleRows ?? []) as RoleRow[])].sort((a, b) => {
      const aPosted = a.posted_at ? Date.parse(a.posted_at) : 0;
      const bPosted = b.posted_at ? Date.parse(b.posted_at) : 0;
      return bPosted - aPosted;
    });

    for (const r of sortedRoleRows) {
      if (!r.company_id || !r.id) continue;
      counts.set(r.company_id, (counts.get(r.company_id) ?? 0) + 1);

      const roleFamily = getRoleFamily(r);

      if (roleFamily) {
        const current = familyCounts.get(r.company_id) ?? {};
        current[roleFamily] = (current[roleFamily] ?? 0) + 1;
        familyCounts.set(r.company_id, current);
      }

      const embedded: EmbeddedRole = {
        id: r.id,
        title: r.title ?? "",
        location: r.location,
        remote: r.remote,
        employment_type: r.employment_type,
        seniority: r.seniority,
        salary_min: r.salary_min,
        salary_max: r.salary_max,
        url: r.url,
        ghost_score: r.ghost_score,
        posted_at: r.posted_at,
        role_family: roleFamily,
      };

      const list = rolesMap.get(r.company_id) ?? [];
      list.push(embedded);
      rolesMap.set(r.company_id, list);
    }
  }

  const annotated = rows.map((r) => ({
    ...r,
    open_roles_count: counts.get(String(r.id)) ?? 0,
    role_families: familyCounts.get(String(r.id)) ?? {},
    roles: rolesMap.get(String(r.id)) ?? [],
  }));

  return NextResponse.json({
    data: annotated,
    page,
    pageSize,
    total: count ?? 0,
    filters: { family, minRevenue, maxRevenue, includeUnknownRevenue, minOpenRoles },
  });
}
