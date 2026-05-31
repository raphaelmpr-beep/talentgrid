import { NextResponse, type NextRequest } from "next/server";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";
import { isFeedAdminAuthorized } from "@/lib/feeds/admin-auth";
import { fetchAllBodySchema } from "@/lib/validators/feed";
import {
  fetchCompanyJobs,
  loadFetchableCompanies,
} from "@/lib/jobs/fetch-pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/jobs/fetch-all
// Body: { dryRun?, limit?, offset?, maxJobs? }
//
// Loops the bounded set of companies that have a validated fetchable source and
// upserts each one's live postings. Mutating + service-role, gated behind the
// admin secret. Pass { dryRun: true } for a safe no-write preview.
export async function POST(req: NextRequest) {
  let parsedBody: unknown = {};
  try {
    const text = await req.text();
    parsedBody = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const parsed = fetchAllBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_body", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { dryRun, limit, offset, maxJobs } = parsed.data;

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

  const targets = await loadFetchableCompanies(supabase, { limit, offset });

  let companiesSuccessful = 0;
  let companiesFailed = 0;
  let jobsFetched = 0;
  let jobsUpserted = 0;
  let jobsWithCompensation = 0;
  let jobsWithoutCompensation = 0;
  let jobsWithPostedAt = 0;
  let jobsWithoutPostedAt = 0;
  const errors: Array<{ company_id: string; company_name: string; error: string }> =
    [];
  const results = [];

  for (const { company, sources } of targets) {
    const result = await fetchCompanyJobs(supabase, company, sources, {
      dryRun,
      maxJobs,
    });
    jobsFetched += result.fetched_count;
    jobsUpserted += result.upserted_count;
    jobsWithCompensation += result.jobs_with_compensation;
    jobsWithoutCompensation += result.jobs_without_compensation;
    jobsWithPostedAt += result.jobs_with_posted_at;
    jobsWithoutPostedAt += result.jobs_without_posted_at;
    if (result.error) {
      companiesFailed += 1;
      errors.push({
        company_id: result.company_id,
        company_name: result.company_name,
        error: result.error,
      });
    } else {
      companiesSuccessful += 1;
    }
    results.push({
      company_id: result.company_id,
      company_name: result.company_name,
      source_name: result.source_name,
      fetched_count: result.fetched_count,
      upserted_count: result.upserted_count,
      deactivated_count: result.deactivated_count,
      jobs_with_compensation: result.jobs_with_compensation,
      jobs_without_compensation: result.jobs_without_compensation,
      jobs_with_posted_at: result.jobs_with_posted_at,
      jobs_without_posted_at: result.jobs_without_posted_at,
      error: result.error,
    });
  }

  return NextResponse.json({
    companies_attempted: targets.length,
    companies_successful: companiesSuccessful,
    companies_failed: companiesFailed,
    jobs_fetched: jobsFetched,
    jobs_upserted: jobsUpserted,
    // Aggregate compensation/date parser summary across all companies.
    jobs_with_compensation: jobsWithCompensation,
    jobs_without_compensation: jobsWithoutCompensation,
    jobs_with_posted_at: jobsWithPostedAt,
    jobs_without_posted_at: jobsWithoutPostedAt,
    dry_run: dryRun,
    errors,
    results,
  });
}
