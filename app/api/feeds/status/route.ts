import { NextResponse } from "next/server";
import {
  theirStackConfig,
  enrichmentConfig,
  redisConfig,
} from "@/lib/feeds/config";

export const runtime = "nodejs";

// Public readiness summary. Returns only non-secret state (which keys are
// present, which are missing) so the dashboard can show "not configured"
// banners without leaking credentials.
export async function GET() {
  const theirstack = theirStackConfig();
  const enrichment = enrichmentConfig();
  const redis = redisConfig();
  return NextResponse.json({
    providers: {
      theirstack: {
        configured: theirstack.configured,
        missing: theirstack.missing,
        meta: theirstack.meta,
      },
      enrichment: {
        configured: enrichment.configured,
        missing: enrichment.missing,
        meta: enrichment.meta,
      },
    },
    queues: {
      configured: redis.configured,
      source: redis.source,
    },
    adminGate: {
      configured: !!process.env.FEED_ADMIN_SECRET,
    },
  });
}
