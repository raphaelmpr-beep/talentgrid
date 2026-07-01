import { createServerClient } from "@supabase/ssr";

// Service-role client for server-to-server feed sync work. Never expose to
// user-facing routes — RLS-bypassing operations belong in the admin path only.
function sanitizeEnv(v: string | undefined): string | undefined {
  const c = v?.replace(/^[\s\u00A0\u2000-\u200B\u2009\u202F\uFEFF]+|[\s\u00A0\u2000-\u200B\u2009\u202F\uFEFF]+$/g, "");
  return c && c.length > 0 ? c : undefined;
}

export function createFeedAdminClient() {
  const url = sanitizeEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const key = sanitizeEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!url || !key) return null;
  return createServerClient(url, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
