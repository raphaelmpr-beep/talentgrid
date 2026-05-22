import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { companyQuerySchema } from "@/lib/validators/company";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const parsed = companyQuerySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams)
  );
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { page, pageSize, isHiring, q } = parsed.data;

  const supabase = await createClient();
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
