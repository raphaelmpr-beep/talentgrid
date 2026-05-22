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
  const queryDryRun = req.nextUrl.searchParams.get("dryRun") === "true";
  const { companyId, roleId, targetUrl } = parsed.data;
  const dryRun = parsed.data.dryRun || queryDryRun;

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

  // The enrichment endpoint URL is generally per-target (champion/profile/
  // company page). Require either an explicit `targetUrl` in the body or a
  // configured ENRICHMENT_API_BASE_URL fallback — otherwise we cannot decide
  // where to send the request.
  if (!targetUrl && !process.env.ENRICHMENT_API_BASE_URL) {
    return NextResponse.json(
      {
        error: "enrichment_target_url_required",
        detail:
          "Supply a `targetUrl` in the request body (canonical per-request enrichment URL) or set ENRICHMENT_API_BASE_URL.",
      },
      { status: 400 }
    );
  }

  if (dryRun) {
    const report =
      mode === "poc"
        ? await runPocEnrichment(
            { companyId, roleId, targetUrl, dryRun: true },
            supabase as never
          )
        : await runCompanyEnrichment(
            companyId,
            { dryRun: true, targetUrl },
            supabase as never
          );
    return NextResponse.json(report);
  }

  // Real run: prefer queueing so workers handle backpressure.
  const queue = mode === "poc" ? feedEnrichPocQueue() : feedEnrichCompanyQueue();
  if (queue) {
    const job = await queue.add(
      mode === "poc" ? "enrich-poc" : "enrich-company",
      mode === "poc"
        ? { companyId, roleId, targetUrl }
        : { companyId, targetUrl }
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
      ? await runPocEnrichment(
          { companyId, roleId, targetUrl, dryRun: false },
          supabase as never
        )
      : await runCompanyEnrichment(
          companyId,
          { dryRun: false, targetUrl },
          supabase as never
        );
  return NextResponse.json(report);
}
