import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/feeds/config";

export const runtime = "nodejs";

// Lightweight connectivity test for Supabase.
// Returns 200 when the connection works, 503 when env vars are missing, or
// 502 when env vars are set but the database query fails.
export async function GET() {
  const cfg = supabaseConfig();

  if (!cfg.configured) {
    return NextResponse.json(
      {
        ok: false,
        reason: "not_configured",
        missing: cfg.missing,
      },
      { status: 503 }
    );
  }

  const supabase = await createClient();
  if (!supabase) {
    return NextResponse.json(
      { ok: false, reason: "client_init_failed" },
      { status: 503 }
    );
  }

  // Run the cheapest possible query — count rows in companies with a limit of
  // 0 so Postgres returns immediately without scanning any data.
  const { error } = await supabase
    .from("companies")
    .select("id", { count: "exact", head: true });

  if (error) {
    return NextResponse.json(
      { ok: false, reason: "query_failed", detail: error.message },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}
