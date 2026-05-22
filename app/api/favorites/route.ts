import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";

export const runtime = "nodejs";

const favoriteCreateSchema = z
  .object({
    companyId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  })
  .refine((v) => v.companyId || v.roleId, {
    message: "companyId or roleId is required",
  });

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const page = Math.max(1, Number(req.nextUrl.searchParams.get("page") ?? 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(req.nextUrl.searchParams.get("pageSize") ?? 20))
  );

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  // RLS scopes by user_id automatically.
  const { data, error, count } = await supabase
    .from("favorites")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ data, page, pageSize, total: count ?? 0 });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const parsed = favoriteCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("favorites")
    .insert({
      user_id: user.id,
      company_id: parsed.data.companyId ?? null,
      role_id: parsed.data.roleId ?? null,
      notes: parsed.data.notes ?? null,
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data }, { status: 201 });
}
