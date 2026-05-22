import { NextResponse, type NextRequest } from "next/server";
import { checkFeedAdmin } from "@/lib/feeds/config";
import { signalIngestSchema } from "@/lib/validators/feed";
import { createClient, supabaseNotConfiguredResponse } from "@/lib/supabase/server";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";
import { runSignalIngest } from "@/lib/feeds/sync";
import { feedIngestSignalQueue } from "@/lib/queues";

export const runtime = "nodejs";

// GET: signed-in users read the most recent signals (RLS allows public reads).
// POST: admin-gated ingestion. Mirrors the same gate as other /api/feeds routes.

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  if (!supabase) return supabaseNotConfiguredResponse();
  const url = new URL(req.url);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("pageSize") ?? 50))
  );
  const companyId = url.searchParams.get("companyId");
  let query = supabase
    .from("signals")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(pageSize);
  if (companyId) query = query.eq("company_id", companyId);
  const { data, error } = await query;
  if (error) {
    // Table may not exist yet (migration 002 not applied) — surface a soft
    // empty response so the dashboard can render without errors.
    if (/relation .* does not exist/i.test(error.message)) {
      return NextResponse.json({ data: [], notDeployed: true });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const parsed = signalIngestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Ingestion is always a state change — never let it bypass the gate even on dryRun.
  const dryRun = false;
  const gate = checkFeedAdmin(req.headers.get("x-feed-admin-secret"), { dryRun });
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: gate.status });
  }

  const q = feedIngestSignalQueue();
  if (q) {
    const job = await q.add("ingest", parsed.data);
    return NextResponse.json({ enqueued: true, jobId: String(job.id) });
  }

  const supabase = createFeedAdminClient();
  const report = await runSignalIngest(parsed.data, { dryRun: false }, supabase as never);
  return NextResponse.json(report);
}
