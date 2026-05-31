import { NextResponse, type NextRequest } from "next/server";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";
import { isFeedAdminAuthorized } from "@/lib/feeds/admin-auth";
import { fetchCompanyBodySchema } from "@/lib/validators/feed";
import {
  fetchCompanyJobs,
  loadCompanyJobSources,
} from "@/lib/jobs/fetch-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/fetch-company
// Body: { company_id: uuid, dryRun?, maxJobs? }
//
// Loads the company's source-of-sources rows, fetches its first validated
// fetchable source, and upserts the live postings into `roles` (the
// job_openings view). Mutating + service-role, so it is gated behind the same
// admin secret as the cron. Pass { dryRun: true } for a no-write preview.
export async function POST(req: NextRequest) {
  let parsedBody: unknown;
  try {
    parsedBody = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const parsed = fetchCompanyBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { company_id, dryRun, maxJobs } = parsed.data;

  if (!dryRun && !isFeedAdminAuthorized(req)) {
    return NextResponse.json(
      {
        error:
          "unauthorized: set CRON_SECRET (or FEED_ADMIN_SECRET) and provide it via Authorization: Bearer, x-cron-secret, or ?secret=. Send { \"dryRun\": true } for a safe no-write preview.",
      },
      { status: 401 }
    );
  }

  const supabase = createFeedAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "feed_admin_client_unavailable: missing Supabase service-role env" },
      { status: 503 }
    );
  }

  const { data: company, error: companyErr } = await supabase
    .from("companies")
    .select("id,name,domain,industry,description,metadata")
    .eq("id", company_id)
    .maybeSingle();
  if (companyErr) {
    return NextResponse.json(
      { error: `company_lookup_failed: ${companyErr.message}` },
      { status: 500 }
    );
  }
  if (!company) {
    return NextResponse.json({ error: "company_not_found" }, { status: 404 });
  }

  const sources = await loadCompanyJobSources(supabase, {
    id: company.id,
    name: company.name,
  });

  const result = await fetchCompanyJobs(supabase, company, sources, {
    dryRun,
    maxJobs,
  });

  // Surface the Requirement-C contract fields explicitly.
  return NextResponse.json({
    company_id: result.company_id,
    company_name: result.company_name,
    source_name: result.source_name,
    fetched_count: result.fetched_count,
    upserted_count: result.upserted_count,
    deactivated_count: result.deactivated_count,
    source_total: result.source_total,
    source_count_exact: result.source_count_exact,
    // Compensation/date parser summary for this run.
    jobs_with_compensation: result.jobs_with_compensation,
    jobs_without_compensation: result.jobs_without_compensation,
    jobs_with_posted_at: result.jobs_with_posted_at,
    jobs_without_posted_at: result.jobs_without_posted_at,
    parser_samples: result.parser_samples,
    dry_run: dryRun,
    error: result.error,
  });
}
