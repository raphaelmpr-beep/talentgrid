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

const DEFAULT_FEED_LIMIT = 20;
const DEFAULT_POSTED_AT_MAX_AGE_DAYS = 7;
const DEFAULT_COUNTRY_CODES = ["US"];

/** Normalise a raw TheirStack job object into the canonical shape used by the
 *  rest of the import pipeline. Returns null if required fields are missing. */
function normaliseJob(raw) {
  if (!raw || typeof raw !== "object") return null;
  const r = raw;

  const externalId =
    (typeof r.external_id === "string" && r.external_id) ||
    (typeof r.id === "number" ? String(r.id) : typeof r.id === "string" ? r.id : null) ||
    (typeof r.job_id === "string" ? r.job_id : null);
  const title =
    (typeof r.title === "string" && r.title) ||
    (typeof r.job_title === "string" ? r.job_title : null) ||
    (typeof r.name === "string" ? r.name : null);
  if (!externalId || !title) return null;

  const companyRaw =
    r.company && typeof r.company === "object" ? r.company : {};
  const companyName =
    (typeof companyRaw.name === "string" && companyRaw.name) ||
    (typeof companyRaw.company_name === "string" ? companyRaw.company_name : null) ||
    (typeof r.company_name === "string" ? r.company_name : null);
  if (!companyName) return null;

  return {
    external_id: String(externalId),
    title: String(title),
    description:
      (typeof r.description === "string" ? r.description : null) ||
      (typeof r.job_description === "string" ? r.job_description : null) ||
      null,
    url:
      (typeof r.url === "string" ? r.url : null) ||
      (typeof r.final_url === "string" ? r.final_url : null) ||
      (typeof r.source_url === "string" ? r.source_url : null) ||
      null,
    location:
      (typeof r.location === "string" ? r.location : null) ||
      (typeof r.job_location === "string" ? r.job_location : null) ||
      null,
    remote:
      typeof r.remote === "boolean"
        ? r.remote
        : typeof r.is_remote === "boolean"
          ? r.is_remote
          : typeof r.remote_work_allowed === "boolean"
            ? r.remote_work_allowed
            : false,
    employment_type: typeof r.employment_type === "string" ? r.employment_type : null,
    seniority:
      (typeof r.seniority === "string" ? r.seniority : null) ||
      (typeof r.seniority_level === "string" ? r.seniority_level : null) ||
      null,
    salary_min:
      typeof r.salary_min === "number" && Number.isFinite(r.salary_min)
        ? r.salary_min
        : typeof r.min_annual_salary === "number" && Number.isFinite(r.min_annual_salary)
          ? r.min_annual_salary
          : null,
    salary_max:
      typeof r.salary_max === "number" && Number.isFinite(r.salary_max)
        ? r.salary_max
        : typeof r.max_annual_salary === "number" && Number.isFinite(r.max_annual_salary)
          ? r.max_annual_salary
          : null,
    posted_at:
      (typeof r.posted_at === "string" ? r.posted_at : null) ||
      (typeof r.date_posted === "string" ? r.date_posted : null) ||
      (typeof r.date_added === "string" ? r.date_added : null) ||
      null,
    company: {
      name: String(companyName),
      domain:
        (typeof companyRaw.domain === "string" ? companyRaw.domain : null) ||
        (typeof companyRaw.company_domain === "string" ? companyRaw.company_domain : null) ||
        null,
      website:
        (typeof companyRaw.website === "string" ? companyRaw.website : null) ||
        (typeof companyRaw.url === "string" ? companyRaw.url : null) ||
        null,
      industry: typeof companyRaw.industry === "string" ? companyRaw.industry : null,
      size:
        (typeof companyRaw.size === "string" ? companyRaw.size : null) ||
        (typeof companyRaw.employee_count_range === "string"
          ? companyRaw.employee_count_range
          : null) ||
        null,
      location:
        (typeof companyRaw.location === "string" ? companyRaw.location : null) ||
        (typeof companyRaw.hq_location === "string" ? companyRaw.hq_location : null) ||
        null,
      logo_url:
        (typeof companyRaw.logo_url === "string" ? companyRaw.logo_url : null) ||
        (typeof companyRaw.logo === "string" ? companyRaw.logo : null) ||
        null,
    },
  };
}

async function fetchJobs(input) {
  if (!THEIRSTACK_API_KEY) return { jobs: [], skipped: "no_api_key" };
  const base = THEIRSTACK_API_BASE_URL.endsWith("/")
    ? THEIRSTACK_API_BASE_URL
    : THEIRSTACK_API_BASE_URL + "/";
  const url = new URL("jobs/search", base);

  const limit =
    typeof input.limit === "number" &&
    Number.isFinite(input.limit) &&
    input.limit > 0
      ? Math.min(Math.floor(input.limit), 100)
      : DEFAULT_FEED_LIMIT;

  const body = {
    limit,
    posted_at_max_age_days: DEFAULT_POSTED_AT_MAX_AGE_DAYS,
    job_country_code_or: DEFAULT_COUNTRY_CODES,
  };

  if (typeof input.page === "number" && input.page > 1) {
    body.page = input.page;
  }
  if (input.query) {
    body.job_title_or = [input.query];
  }
  if (input.postedSince) {
    // Convert ISO date to max-age-days for TheirStack's API
    const since = Date.parse(input.postedSince);
    if (!Number.isNaN(since)) {
      const days = Math.ceil((Date.now() - since) / (1000 * 60 * 60 * 24));
      if (days > 0) body.posted_at_max_age_days = days;
    }
  }

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
    const text = await res.text().catch(() => "");
    throw new Error(`TheirStack ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // TheirStack v1 returns { data: [...] }; older shape used { jobs: [...] }.
  const rawJobs = Array.isArray(data.data)
    ? data.data
    : Array.isArray(data.jobs)
      ? data.jobs
      : [];
  const jobs = rawJobs.map(normaliseJob).filter(Boolean);
  return { jobs };
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
