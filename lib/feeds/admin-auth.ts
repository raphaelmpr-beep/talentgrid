import { type NextRequest } from "next/server";

// Shared admin gate for mutating, service-role feed/ingestion endpoints.
//
// Prefer CRON_SECRET (Vercel cron sends it as a Bearer token via the
// `Authorization` header / `?secret=`); fall back to FEED_ADMIN_SECRET so the
// endpoint reuses the existing admin gate convention. Accepts the secret via
// Authorization: Bearer, x-cron-secret, x-feed-admin-secret, or ?secret=.
export function isFeedAdminAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET ?? process.env.FEED_ADMIN_SECRET;
  if (!expected) return false;

  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${expected}`) return true;
  if (req.headers.get("x-cron-secret") === expected) return true;
  if (req.headers.get("x-feed-admin-secret") === expected) return true;
  if (req.nextUrl.searchParams.get("secret") === expected) return true;
  return false;
}
