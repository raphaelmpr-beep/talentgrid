import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { roleQuerySchema } from "@/lib/validators/role";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const parsed = roleQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { page, pageSize, isActive, maxGhostScore, companyId, q } = parsed.data;

  const supabase = await createClient();
  let query = supabase
    .from("roles")
    .select("*", { count: "exact" })
    .order("posted_at", { ascending: false, nullsFirst: false });

  // Defaults: only active roles, ghost_score < 40 — caller can override.
  query = query.eq("is_active", isActive ?? true);
  query = query.lt("ghost_score", maxGhostScore ?? 40);

  if (companyId) query = query.eq("company_id", companyId);
  if (q) query = query.ilike("title", `%${q}%`);

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
  });
}
