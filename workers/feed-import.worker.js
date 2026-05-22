// Imports jobs from TheirStack (or a compatible provider) and persists
// them via the Supabase service role. The worker is intentionally
// permissive about missing env: when keys are absent it logs and exits the
// job successfully instead of crashing.

const { Worker } = require("bullmq");
const { createClient } = require("@supabase/supabase-js");
const {
  connection,
  QUEUE_NAMES,
  feedEnrichCompanyQueue,
  ghostCheckQueue,
} = require("./queues");

function readEnv(name) {
  const v = process.env[name];
  return v && String(v).trim().length > 0 ? v : undefined;
}

const THEIRSTACK_API_KEY = readEnv("THEIRSTACK_API_KEY");
const THEIRSTACK_API_BASE_URL =
  readEnv("THEIRSTACK_API_BASE_URL") || "https://api.theirstack.com/v1";
const SUPABASE_URL = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = readEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

async function fetchJobs(input) {
  if (!THEIRSTACK_API_KEY) return { jobs: [], skipped: "no_api_key" };
  const base = THEIRSTACK_API_BASE_URL.endsWith("/")
    ? THEIRSTACK_API_BASE_URL
    : THEIRSTACK_API_BASE_URL + "/";
  const url = new URL("jobs/search", base);
  const body = buildSearchBody(input || {});
  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${THEIRSTACK_API_KEY}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`TheirStack ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const jobs = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.jobs)
      ? data.jobs
      : [];
  return { jobs };
}

function buildSearchBody(input) {
  const body = {
    limit: clampLimit(input.limit),
    posted_at_max_age_days: resolveMaxAgeDays(input),
    job_country_code_or:
      Array.isArray(input.jobCountryCodeOr) && input.jobCountryCodeOr.length > 0
        ? input.jobCountryCodeOr
        : ["US"],
  };
  if (typeof input.page === "number" && input.page > 1) {
    body.page = input.page;
  }
  if (Array.isArray(input.jobTitleOr) && input.jobTitleOr.length > 0) {
    body.job_title_or = input.jobTitleOr;
  } else if (typeof input.query === "string" && input.query.trim().length > 0) {
    body.job_title_or = [input.query.trim()];
  }
  if (
    Array.isArray(input.companyDomainOr) &&
    input.companyDomainOr.every((v) => typeof v === "string" && v.length > 0)
  ) {
    body.company_domain_or = input.companyDomainOr;
  }
  return body;
}

function clampLimit(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(Math.floor(limit), 100);
}

function resolveMaxAgeDays(input) {
  if (
    typeof input.postedAtMaxAgeDays === "number" &&
    Number.isFinite(input.postedAtMaxAgeDays) &&
    input.postedAtMaxAgeDays > 0
  ) {
    return Math.floor(input.postedAtMaxAgeDays);
  }
  if (typeof input.postedSince === "string" && input.postedSince.length > 0) {
    const since = Date.parse(input.postedSince);
    if (!Number.isNaN(since)) {
      const days = Math.ceil((Date.now() - since) / (1000 * 60 * 60 * 24));
      if (days > 0) return days;
    }
  }
  return 7;
}

async function importJobs(payload) {
  if (!supabase) {
    return { skipped: "supabase_not_configured", written: 0 };
  }
  const { jobs, skipped } = await fetchJobs(payload || {});
  if (skipped) return { skipped, written: 0 };

  let written = 0;
  for (const job of jobs) {
    const { data: company, error: companyErr } = await supabase
      .from("companies")
      .upsert(
        {
          name: job.company?.name,
          domain: job.company?.domain ?? null,
          website: job.company?.website ?? null,
          industry: job.company?.industry ?? null,
          size: job.company?.size ?? null,
          location: job.company?.location ?? null,
          logo_url: job.company?.logo_url ?? null,
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
        { onConflict: "id" }
      )
      .select("id")
      .single();
    if (roleErr || !role) continue;

    written += 1;
    await feedEnrichCompanyQueue.add("enrich", { companyId: company.id });
    await ghostCheckQueue.add("check", { roleId: role.id });
  }
  return { written, fetched: jobs.length };
}

const worker = new Worker(
  QUEUE_NAMES.FEED_IMPORT_JOBS,
  async (job) => importJobs(job.data || {}),
  { connection, concurrency: 2 }
);

worker.on("failed", (job, err) => {
  console.error(`[feed-import] job ${job?.id} failed:`, err.message);
});

worker.on("completed", (job, result) => {
  console.log(`[feed-import] job ${job.id} done`, result);
});

console.log("[feed-import] worker started");
