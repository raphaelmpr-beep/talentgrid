// Centralised env/config helpers for external feed providers.
// Every provider reads its credentials through these helpers so callers
// can decide between a real API call, a dry-run, or a graceful
// "not configured" response without touching `process.env` directly.

export type ProviderId = "theirstack" | "enrichment";

export type ProviderConfig = {
  id: ProviderId;
  configured: boolean;
  missing: string[];
  // Present only when configured === true.
  credentials?: Record<string, string>;
  // Optional non-secret hints (e.g. base URL) — safe to expose in status responses.
  meta?: Record<string, string>;
};

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v : undefined;
}

export function theirStackConfig(): ProviderConfig {
  const apiKey = readEnv("THEIRSTACK_API_KEY");
  const webhookSecret = readEnv("THEIRSTACK_WEBHOOK_SECRET");
  const baseUrl =
    readEnv("THEIRSTACK_API_BASE_URL") ?? "https://api.theirstack.com/v1";

  const missing: string[] = [];
  if (!apiKey) missing.push("THEIRSTACK_API_KEY");

  return {
    id: "theirstack",
    configured: missing.length === 0,
    missing,
    credentials: apiKey
      ? { apiKey, ...(webhookSecret ? { webhookSecret } : {}) }
      : undefined,
    meta: { baseUrl },
  };
}

// Enrichment provider config.
//
// Only ENRICHMENT_API_KEY is strictly required: the enrichment URL is
// generally dynamic (per champion / profile / company), so callers supply a
// per-request `targetUrl`. ENRICHMENT_API_BASE_URL is an optional fallback
// used when no per-request URL is given (e.g. a generic
// `${baseUrl}/companies/enrich` endpoint). When neither is available the
// caller surfaces a clear `enrichment_target_url_required` error.
export function enrichmentConfig(): ProviderConfig {
  const apiKey = readEnv("ENRICHMENT_API_KEY");
  const baseUrl = readEnv("ENRICHMENT_API_BASE_URL");

  const missing: string[] = [];
  if (!apiKey) missing.push("ENRICHMENT_API_KEY");

  return {
    id: "enrichment",
    configured: missing.length === 0,
    missing,
    credentials: apiKey
      ? { apiKey, ...(baseUrl ? { baseUrl } : {}) }
      : undefined,
    meta: {
      ...(baseUrl ? { baseUrl } : {}),
      baseUrlConfigured: baseUrl ? "true" : "false",
    },
  };
}

export type RedisConfig = {
  configured: boolean;
  url?: string;
  source?: "REDIS_URL" | "UPSTASH_REDIS_REST_URL";
};

// Resolve a connection string we can hand to ioredis / BullMQ. Upstash REST is
// not a wire-compatible Redis endpoint, so it is only surfaced as `meta` — the
// BullMQ workers still need REDIS_URL. The helper exposes both so callers can
// decide whether to enqueue (needs REDIS_URL) or fall back to dry-run.
export function redisConfig(): RedisConfig {
  const redisUrl = readEnv("REDIS_URL");
  if (redisUrl) return { configured: true, url: redisUrl, source: "REDIS_URL" };
  const upstash = readEnv("UPSTASH_REDIS_REST_URL");
  if (upstash) return { configured: false, url: upstash, source: "UPSTASH_REDIS_REST_URL" };
  return { configured: false };
}

// Admin-gating for sync endpoints. If FEED_ADMIN_SECRET is unset the endpoint
// must refuse anything that mutates state; callers may still issue dryRun=true.
export type AdminGate =
  | { ok: true; reason: "secret_match" | "no_secret_configured_dryrun_only" }
  | { ok: false; status: 401 | 403 | 503; reason: string };

export function checkFeedAdmin(
  providedSecret: string | null,
  options: { dryRun: boolean }
): AdminGate {
  const expected = readEnv("FEED_ADMIN_SECRET");
  if (!expected) {
    // No secret configured: only dryRun=true is allowed; mutating calls refuse.
    if (options.dryRun) {
      return { ok: true, reason: "no_secret_configured_dryrun_only" };
    }
    return {
      ok: false,
      status: 503,
      reason:
        "FEED_ADMIN_SECRET is not configured; only dryRun=true is permitted.",
    };
  }
  if (!providedSecret) {
    return { ok: false, status: 401, reason: "missing x-feed-admin-secret header" };
  }
  if (providedSecret !== expected) {
    return { ok: false, status: 403, reason: "invalid feed admin secret" };
  }
  return { ok: true, reason: "secret_match" };
}

export function notConfiguredPayload(provider: ProviderConfig) {
  return {
    error: "provider_not_configured",
    provider: provider.id,
    missing: provider.missing,
  };
}
