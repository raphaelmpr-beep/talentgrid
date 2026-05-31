import { NextResponse } from "next/server";
import { createFeedAdminClient } from "@/lib/feeds/supabase-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/debug/job-pipeline
//
// Read-only health snapshot of the ingestion pipeline. No mutations, so it is
// not secret-gated, but it requires the service-role client to read across the
// candidate-source and roles tables (both RLS-locked to service role).
//
// Counts come from `head: true, count: "exact"` queries so we never pull rows.
export async function GET() {
  const supabase = createFeedAdminClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "feed_admin_client_unavailable: missing Supabase service-role env" },
      { status: 503 }
    );
  }

  const headCount = async (
    builder: PromiseLike<{ count: number | null; error: unknown }>
  ): Promise<number> => {
    const { count, error } = await builder;
    return error ? 0 : count ?? 0;
  };
  const exact = { count: "exact" as const, head: true };

  const [
    totalCompanies,
    totalJobSources,
    jobSourcesWithApiUrl,
    jobSourcesFetchEnabled,
    jobSourcesValidatedFetchable,
    totalJobOpenings,
    totalActiveJobOpenings,
  ] = await Promise.all([
    headCount(supabase.from("companies").select("*", exact)),
    headCount(supabase.from("company_job_sources_candidate").select("*", exact)),
    headCount(
      supabase
        .from("company_job_sources_candidate")
        .select("*", exact)
        .not("api_url", "is", null)
    ),
    headCount(
      supabase
        .from("company_job_sources_candidate")
        .select("*", exact)
        .eq("fetch_enabled", true)
    ),
    headCount(
      supabase
        .from("company_job_sources_candidate")
        .select("*", exact)
        .eq("validation_status", "validated_fetchable")
    ),
    headCount(supabase.from("roles").select("*", exact)),
    headCount(supabase.from("roles").select("*", exact).eq("is_active", true)),
  ]);

  // companies_with_active_jobs: distinct company_id among active roles. Pull
  // just the company_id column (bounded) and dedupe in memory.
  let companiesWithActiveJobs = 0;
  {
    const { data } = await supabase
      .from("roles")
      .select("company_id")
      .eq("is_active", true)
      .not("company_id", "is", null)
      .limit(100000);
    if (data) {
      const ids = new Set(
        (data as Array<{ company_id: string | null }>)
          .map((r) => r.company_id)
          .filter((id): id is string => Boolean(id))
      );
      companiesWithActiveJobs = ids.size;
    }
  }
  const companiesWithoutActiveJobs = Math.max(
    totalCompanies - companiesWithActiveJobs,
    0
  );

  // last_fetch_run_at: the most recent source_openings_checked_at the pipeline
  // persisted onto a company. recent_fetch_errors: candidate rows that failed
  // validation, with their stored error.
  let lastFetchRunAt: string | null = null;
  {
    const { data } = await supabase
      .from("companies")
      .select("metadata")
      .not("metadata->>source_openings_checked_at", "is", null)
      .order("metadata->>source_openings_checked_at", { ascending: false })
      .limit(1);
    const meta = (data as Array<{ metadata: Record<string, unknown> | null }> | null)?.[0]
      ?.metadata;
    const checked = meta?.["source_openings_checked_at"];
    if (typeof checked === "string") lastFetchRunAt = checked;
  }

  let recentFetchErrors: Array<{
    company_name: string;
    source_name: string | null;
    validation_status: string;
    error: string | null;
    validated_at: string | null;
  }> = [];
  {
    const { data } = await supabase
      .from("company_job_sources_candidate")
      .select("company_name,source_name,validation_status,validation_error,validated_at")
      .in("validation_status", [
        "validation_failed",
        "stale_import",
        "source_changed",
        "unsupported_source_type",
      ])
      .order("validated_at", { ascending: false })
      .limit(25);
    if (data) {
      recentFetchErrors = (
        data as Array<{
          company_name: string;
          source_name: string | null;
          validation_status: string;
          validation_error: string | null;
          validated_at: string | null;
        }>
      ).map((r) => ({
        company_name: r.company_name,
        source_name: r.source_name,
        validation_status: r.validation_status,
        error: r.validation_error,
        validated_at: r.validated_at,
      }));
    }
  }

  return NextResponse.json({
    total_companies: totalCompanies,
    total_job_sources: totalJobSources,
    job_sources_with_api_url: jobSourcesWithApiUrl,
    job_sources_fetch_enabled: jobSourcesFetchEnabled,
    job_sources_validated_fetchable: jobSourcesValidatedFetchable,
    total_job_openings: totalJobOpenings,
    total_active_job_openings: totalActiveJobOpenings,
    companies_with_active_jobs: companiesWithActiveJobs,
    companies_without_active_jobs: companiesWithoutActiveJobs,
    last_fetch_run_at: lastFetchRunAt,
    recent_fetch_errors: recentFetchErrors,
  });
}
