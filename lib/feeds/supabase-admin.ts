import { createServerClient } from "@supabase/ssr";

// Service-role client for server-to-server feed sync work. Never expose to
// user-facing routes — RLS-bypassing operations belong in the admin path only.
export function createFeedAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createServerClient(url, key, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}
