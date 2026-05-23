import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { ghostCheckQueue, enrichQueue } from "@/lib/queues";

export const runtime = "nodejs";

// TheirStack webhook payload (subset we care about).
type TheirStackJob = {
  external_id: string;
  title: string;
  description?: string;
  url?: string;
  location?: string;
  remote?: boolean;
  employment_type?: string;
  seniority?: string;
  salary_min?: number;
  salary_max?: number;
  posted_at?: string;
  company: {
    name: string;
    domain?: string;
    website?: string;
    industry?: string;
    size?: string;
    location?: string;
    logo_url?: string;
  };
};

type TheirStackPayload = {
  event: string;
  jobs: TheirStackJob[];
};

function adminClient() {
  // Webhook is server-to-server: use service role to bypass RLS.
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => [], setAll: () => {} } }
  );
}

export async function POST(req: NextRequest) {
  const secret = process.env.THEIRSTACK_WEBHOOK_SECRET;
  const provided = req.headers.get("x-theirstack-signature");
  if (secret && provided !== secret) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: TheirStackPayload;
  try {
    payload = (await req.json()) as TheirStackPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!payload?.jobs?.length) {
    return NextResponse.json({ received: 0 });
  }

  const supabase = adminClient();
  const results: { roleId: string; companyId: string }[] = [];

  for (const job of payload.jobs) {
    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .upsert(
        {
          name: job.company.name,
          domain: job.company.domain ?? null,
          website: job.company.website ?? null,
          industry: job.company.industry ?? null,
          size: job.company.size ?? null,
          location: job.company.location ?? null,
          logo_url: job.company.logo_url ?? null,
          is_hiring: true,
        },
        { onConflict: "domain" }
      )
      .select("id")
      .single();

    if (companyErr || !company) continue;

    const { data: role, error: roleErr } = await supabase
      .from("roles")
      .upsert(
        {
          company_id: company.id,
          external_id: job.external_id ?? null,
          title: job.title,
          description: job.description ?? null,
          location: job.location ?? null,
          remote: job.remote ?? false,
          employment_type: job.employment_type ?? null,
          seniority: job.seniority ?? null,
          salary_min: job.salary_min ?? null,
          salary_max: job.salary_max ?? null,
          url: job.url ?? null,
          source: "theirstack",
          posted_at: job.posted_at ?? null,
          metadata: { external_id: job.external_id },
          is_active: true,
        },
        { onConflict: "company_id,external_id" }
      )
      .select("id")
      .single();

    if (roleErr || !role) continue;

    results.push({ roleId: role.id, companyId: company.id });

    const ghostQ = ghostCheckQueue();
    const enrichQ = enrichQueue();
    if (ghostQ) await ghostQ.add("check", { roleId: role.id });
    if (enrichQ) await enrichQ.add("enrich", { companyId: company.id });
  }

  return NextResponse.json({ received: results.length, results });
}
