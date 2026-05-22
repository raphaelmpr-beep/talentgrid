import { NextResponse, type NextRequest } from "next/server";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";

export const runtime = "nodejs";

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
    isHiring,
    q,
    minRevenue,
    maxRevenue,
    includeUnknownRevenue,
  } = parsed.data;

  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();
  let query = supabase
    .from("companies")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  // Default: only companies that are hiring, unless caller opts out with isHiring=false.
  if (isHiring === undefined) {
    query = query.eq("is_hiring", true);
  } else {
    query = query.eq("is_hiring", isHiring);
  }

  if (q) query = query.ilike("name", `%${q}%`);

  // Annual-revenue window. A company matches when either:
  //   - metadata.annual_revenue ∈ [minRevenue, maxRevenue], or
  //   - the optional metadata.revenue_min / revenue_max range overlaps the window.
  // Using `metadata->key` (jsonb) lets PostgREST compare numerically.
  const overlapBranches = [
    `and(metadata->annual_revenue.gte.${minRevenue},metadata->annual_revenue.lte.${maxRevenue})`,
    `and(metadata->revenue_max.gte.${minRevenue},metadata->revenue_min.lte.${maxRevenue})`,
  ];
  if (includeUnknownRevenue) {
    // Companies with no revenue metadata at all (e.g. freshly imported, pre-enrichment).
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

  // Annotate each company with a live `open_roles_count` derived from the
  // roles table (active, non-ghost). This is the source of truth for the
  // Companies UI — metadata.open_roles_count on the company row can be stale
  // until the enrichment worker catches up.
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const ids = rows
    .map((r) => (typeof r.id === "string" ? r.id : null))
    .filter((id): id is string => !!id);
  const counts = new Map<string, number>();
  if (ids.length > 0) {
    const { data: roleRows, error: rolesErr } = await supabase
      .from("roles")
      .select("company_id")
      .in("company_id", ids)
      .eq("is_active", true)
      .lt("ghost_score", 40);
    if (rolesErr) {
      return NextResponse.json({ error: rolesErr.message }, { status: 500 });
    }
    for (const r of (roleRows ?? []) as Array<{ company_id: string }>) {
      counts.set(r.company_id, (counts.get(r.company_id) ?? 0) + 1);
    }
  }
  const annotated = rows.map((r) => ({
    ...r,
    open_roles_count: counts.get(String(r.id)) ?? 0,
  }));

  return NextResponse.json({
    data: annotated,
    page,
    pageSize,
    total: count ?? 0,
    filters: { minRevenue, maxRevenue, includeUnknownRevenue },
  });
}
