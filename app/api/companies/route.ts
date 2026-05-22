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

  return NextResponse.json({
    data,
    page,
    pageSize,
    total: count ?? 0,
    filters: { minRevenue, maxRevenue, includeUnknownRevenue },
  });
}
