import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";

export const runtime = "nodejs";

type RoleRow = {
  company_id: string | null;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
};

function normaliseRoleFamily(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  if (value.includes("engineer") || value.includes("developer")) return "engineering";
  if (value.includes("product")) return "product";
  if (value.includes("design")) return "design";
  if (value.includes("sales") || value.includes("account executive") || value === "ae") {
    return "sales";
  }
  if (
    value.includes("operations") ||
    value.includes("ops") ||
    value.includes("finance") ||
    value.includes("hr") ||
    value.includes("people") ||
    value.includes("talent")
  ) {
    return "ops";
  }

  return null;
}

function inferRoleFamilyFromTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = title.toLowerCase();
  if (/engineer|developer|software|frontend|backend|full\s*stack|devops|sre|data\s*engineer/.test(t)) {
    return "engineering";
  }
  if (/product\s*(manager|owner)|\bpm\b/.test(t)) return "product";
  if (/designer|ux|ui|product\s*design/.test(t)) return "design";
  if (/sales|account\s*executive|account\s*manager|business\s*development/.test(t)) {
    return "sales";
  }
  if (/operations|ops|finance|accounting|hr|people\s*ops|talent\s*acquisition|recruit/.test(t)) {
    return "ops";
  }
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
  } = parsed.data;

  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();

  // Use live role activity as the source of truth for "hiring" state.
  const enforceOpenRoles = isHiring !== false;
  let hiringCompanyIds: string[] | null = null;
  let familyCompanyIds: string[] | null = null;
  let activeRoles: RoleRow[] = [];
  if (enforceOpenRoles || family) {
    const { data: activeRoleRows, error: rolesErr } = await supabase
      .from("roles")
      .select("company_id,title,metadata")
      .eq("is_active", true)
      .lt("ghost_score", 40)
      .limit(10000);

    if (rolesErr) {
      return NextResponse.json({ error: rolesErr.message }, { status: 500 });
    }

    activeRoles = (activeRoleRows ?? []) as RoleRow[];

    if (enforceOpenRoles) {
      hiringCompanyIds = Array.from(
        new Set(
          activeRoles
            .map((r) => r.company_id)
            .filter((id): id is string => typeof id === "string" && id.length > 0)
        )
      );

      if (hiringCompanyIds.length === 0) {
        return NextResponse.json({
          data: [],
          page,
          pageSize,
          total: 0,
          filters: { family, minRevenue, maxRevenue, includeUnknownRevenue },
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
          filters: { family, minRevenue, maxRevenue, includeUnknownRevenue },
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
  if (ids.length > 0) {
    const { data: roleRows, error: rolesErr } = await supabase
      .from("roles")
      .select("company_id,title,metadata")
      .in("company_id", ids)
      .eq("is_active", true)
      .lt("ghost_score", 40);

    if (rolesErr) {
      return NextResponse.json({ error: rolesErr.message }, { status: 500 });
    }

    for (const r of (roleRows ?? []) as RoleRow[]) {
      if (!r.company_id) continue;
      counts.set(r.company_id, (counts.get(r.company_id) ?? 0) + 1);

      const roleFamily = getRoleFamily(r);
      if (!roleFamily) continue;

      const current = familyCounts.get(r.company_id) ?? {};
      current[roleFamily] = (current[roleFamily] ?? 0) + 1;
      familyCounts.set(r.company_id, current);
    }
  }

  const annotated = rows.map((r) => ({
    ...r,
    open_roles_count: counts.get(String(r.id)) ?? 0,
    role_families: familyCounts.get(String(r.id)) ?? {},
  }));

  return NextResponse.json({
    data: annotated,
    page,
    pageSize,
    total: count ?? 0,
    filters: { family, minRevenue, maxRevenue, includeUnknownRevenue },
  });
}
