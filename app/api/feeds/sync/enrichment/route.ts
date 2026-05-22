import { NextResponse, type NextRequest } from "next/server";
import { checkFeedAdmin } from "@/lib/feeds/config";
import { feedSyncBodySchema } from "@/lib/validators/feed";
import { runCompanyEnrichment, runPocEnrichment } from "@/lib/feeds/sync";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";
import {
  feedEnrichCompanyQueue,
  feedEnrichPocQueue,
} from "@/lib/queues";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    /* empty body is allowed */
  }
  const parsed = feedSyncBodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { dryRun, companyId, roleId } = parsed.data;

  const gate = checkFeedAdmin(req.headers.get("x-feed-admin-secret"), { dryRun });
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: gate.status });
  }

  if (!companyId) {
    return NextResponse.json(
      { error: "companyId is required for enrichment sync" },
      { status: 400 }
    );
  }

  const supabase = createFeedAdminClient();
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "poc" ? "poc" : "company";

  if (dryRun) {
    const report =
      mode === "poc"
        ? await runPocEnrichment(
            { companyId, roleId, dryRun: true },
            supabase as never
          )
        : await runCompanyEnrichment(
            companyId,
            { dryRun: true },
            supabase as never
          );
    return NextResponse.json(report);
  }

  // Real run: prefer queueing so workers handle backpressure.
  const queue = mode === "poc" ? feedEnrichPocQueue() : feedEnrichCompanyQueue();
  if (queue) {
    const job = await queue.add(
      mode === "poc" ? "enrich-poc" : "enrich-company",
      mode === "poc" ? { companyId, roleId } : { companyId }
    );
    return NextResponse.json({ enqueued: true, jobId: String(job.id), mode });
  }

  if (!supabase) {
    return NextResponse.json(
      { error: "neither REDIS_URL nor service-role Supabase is configured" },
      { status: 503 }
    );
  }
  const report =
    mode === "poc"
      ? await runPocEnrichment({ companyId, roleId, dryRun: false }, supabase as never)
      : await runCompanyEnrichment(companyId, { dryRun: false }, supabase as never);
  return NextResponse.json(report);
}
