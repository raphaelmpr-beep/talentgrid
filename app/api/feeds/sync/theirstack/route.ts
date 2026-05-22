import { NextResponse, type NextRequest } from "next/server";
import { checkFeedAdmin } from "@/lib/feeds/config";
import { feedSyncBodySchema } from "@/lib/validators/feed";
import { runTheirStackImport, enqueueImportJobs } from "@/lib/feeds/sync";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults to dryRun=false (gated by admin secret)
  }
  const parsed = feedSyncBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const queryDryRun = req.nextUrl.searchParams.get("dryRun") === "true";
  const { query, postedSince, limit, page } = parsed.data;
  const dryRun = parsed.data.dryRun || queryDryRun;

  // Explicit dry-runs are public/safe: no writes, no queue side effects.
  // Only enforce the admin gate for real (mutating) runs.
  if (!dryRun) {
    const gate = checkFeedAdmin(req.headers.get("x-feed-admin-secret"), { dryRun });
    if (!gate.ok) {
      return NextResponse.json({ error: gate.reason }, { status: gate.status });
    }
  }

  // Dry-runs execute inline so callers see the mapped payload immediately.
  // Real runs are pushed onto BullMQ when available; if Redis is missing we
  // execute inline with service-role Supabase to remain useful in early dev.
  if (dryRun) {
    const supabase = createFeedAdminClient();
    const report = await runTheirStackImport(
      { dryRun: true, query, postedSince, limit, page },
      supabase as never
    );
    return NextResponse.json(report);
  }

  const enqueued = await enqueueImportJobs({ query, postedSince, limit, page });
  if (enqueued) {
    return NextResponse.json({ enqueued: true, jobId: enqueued.id });
  }

  // Redis unavailable: fall back to an inline run via service role.
  const supabase = createFeedAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "neither REDIS_URL nor service-role Supabase is configured" },
      { status: 503 }
    );
  }
  const report = await runTheirStackImport(
    { dryRun: false, query, postedSince, limit, page },
    supabase as never
  );
  return NextResponse.json(report);
}
