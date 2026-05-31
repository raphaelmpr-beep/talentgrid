import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";

export const runtime = "nodejs";

const rolodexCreateSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  email: z.string().email().optional(),
  linkedin: z.string().url().optional(),
  phone: z.string().max(50).optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(50).optional(),
  // Recruiter Intel context (all optional; user-entered or routed). source_type
  // and verification_status default server-side so a saved contact is never
  // presented as a verified exact recruiter.
  companyName: z.string().max(200).optional(),
  jobOpeningId: z.string().uuid().optional(),
  jobTitle: z.string().max(200).optional(),
  contactPathLabel: z.string().max(200).optional(),
  confidenceLevel: z.enum(["high", "medium", "low"]).optional(),
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
  const q = req.nextUrl.searchParams.get("q");

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("rolodex_entries")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false });

  if (q) query = query.ilike("name", `%${q}%`);

  const { data, error, count } = await query.range(from, to);
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

  const parsed = rolodexCreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("rolodex_entries")
    .insert({
      user_id: user.id,
      company_id: parsed.data.companyId ?? null,
      name: parsed.data.name,
      title: parsed.data.title ?? null,
      email: parsed.data.email ?? null,
      linkedin: parsed.data.linkedin ?? null,
      phone: parsed.data.phone ?? null,
      notes: parsed.data.notes ?? null,
      tags: parsed.data.tags ?? [],
      company_name: parsed.data.companyName ?? null,
      job_opening_id: parsed.data.jobOpeningId ?? null,
      job_title: parsed.data.jobTitle ?? null,
      contact_path_label: parsed.data.contactPathLabel ?? null,
      confidence_level: parsed.data.confidenceLevel ?? null,
      // Compliance defaults: user-entered + needs manual verification.
      source_type: "manual_user_entry",
      verification_status: "manual_review_required",
    })
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ data }, { status: 201 });
}
