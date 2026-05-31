import { NextResponse } from "next/server";
import {
  theirStackConfig,
  enrichmentConfig,
  redisConfig,
  supabaseConfig,
} from "@/lib/feeds/config";

export const runtime = "nodejs";

// Public readiness summary. Returns only non-secret state (which keys are
// present, which are missing) so the dashboard can show "not configured"
// banners without leaking credentials.
export async function GET() {
  const theirstack = theirStackConfig();
  const enrichment = enrichmentConfig();
  const redis = redisConfig();
  const supabase = supabaseConfig();
  return NextResponse.json({
    supabase: {
      configured: supabase.configured,
      missing: supabase.missing,
    },
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
      // Direct careers-portal source needs no API key: it fetches each
      // company's own careers/ATS URL stored in companies.metadata. Always
      // available; per-company effectiveness depends on the portal being
      // server-rendered (JS-only SPAs fail closed).
      careers_portal: {
        configured: true,
        requires_key: false,
        missing: [],
        meta: { note: "fetches company careers_url / job_portal_url; no API key required" },
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
