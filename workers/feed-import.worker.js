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
  const rawJobs = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.jobs)
      ? data.jobs
      : [];
  return { jobs: rawJobs.map(normalizeJob).filter(Boolean) };
}

function buildSearchBody(input) {
  const body = {
    limit: clampLimit(input.limit),
    job_country_code_or: ["US"],
    posted_at_max_age_days: 7,
  };
  if (input.query && String(input.query).trim()) {
    body.job_title_or = [String(input.query).trim()];
  }
  if (input.page && Number.isFinite(input.page) && input.page > 1) {
    body.page = Math.floor(input.page);
  }
  if (input.postedSince) {
    const sinceTs = Date.parse(input.postedSince);
    if (!Number.isNaN(sinceTs)) {
      const days = Math.ceil((Date.now() - sinceTs) / (1000 * 60 * 60 * 24));
      if (days > 0) body.posted_at_max_age_days = days;
    }
  }
  return body;
}

function clampLimit(limit) {
  if (!Number.isFinite(limit) || limit <= 0) return 20;
  return Math.min(Math.floor(limit), 100);
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== "object") return null;
  const companyRaw = raw.company && typeof raw.company === "object" ? raw.company : {};
  const externalId = pickString(raw, ["external_id", "id", "job_id"]);
  const title = pickString(raw, ["title", "job_title", "name"]);
  const companyName =
    pickString(companyRaw, ["name", "company_name"]) ||
    pickString(raw, ["company_name", "company"]);
  if (!externalId || !title || !companyName) return null;

  return {
    external_id: externalId,
    title,
    description: pickString(raw, ["description", "job_description"]),
    url: pickString(raw, ["url", "final_url", "source_url"]),
    location: pickString(raw, ["location", "job_location"]),
    remote: pickBool(raw, ["remote", "is_remote", "remote_work_allowed"]),
    employment_type: pickString(raw, ["employment_type", "employment_statuses"]),
    seniority: pickString(raw, ["seniority", "seniority_level"]),
    salary_min: pickNumber(raw, ["salary_min", "min_annual_salary"]),
    salary_max: pickNumber(raw, ["salary_max", "max_annual_salary"]),
    posted_at: pickString(raw, ["posted_at", "date_posted", "date_added"]),
    company: {
      name: companyName,
      domain: pickString(companyRaw, ["domain", "company_domain"]),
      website: pickString(companyRaw, ["website", "url"]),
      industry: pickString(companyRaw, ["industry"]),
      size: pickString(companyRaw, ["size", "employee_count_range"]),
      location: pickString(companyRaw, ["location", "hq_location"]),
      logo_url: pickString(companyRaw, ["logo_url", "logo"]),
    },
  };
}

function pickString(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function pickNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function pickBool(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
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
