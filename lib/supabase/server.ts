import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/** Strip Unicode whitespace variants (e.g. U+2009 thin space from mobile keyboards). */
function sanitizeEnv(v: string | undefined): string | undefined {
  const c = v?.replace(/^[\s\u00A0\u2000-\u200B\u2009\u202F\uFEFF]+|[\s\u00A0\u2000-\u200B\u2009\u202F\uFEFF]+$/g, "");
  return c && c.length > 0 ? c : undefined;
}

export async function createClient() {
  const url = sanitizeEnv(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const anonKey = sanitizeEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (!url || !anonKey) return null;

  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Called from a Server Component — safe to ignore when middleware refreshes sessions.
        }
      },
    },
  });
}

export function supabaseNotConfiguredResponse() {
  return NextResponse.json(
    { error: "Supabase is not configured" },
    { status: 503 }
  );
}
