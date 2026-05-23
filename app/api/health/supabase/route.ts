import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfig } from "@/lib/feeds/config";

export const runtime = "nodejs";

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
