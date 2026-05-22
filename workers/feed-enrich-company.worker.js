// Revenue / company-metadata enrichment worker. Mirrors lib/feeds/sync.ts
// semantics: missing keys cause a graceful skip, present keys do a real call.

const { Worker } = require("bullmq");
const { createClient } = require("@supabase/supabase-js");
const { connection, QUEUE_NAMES } = require("./queues");

function readEnv(name) {
  const v = process.env[name];
  return v && String(v).trim().length > 0 ? v : undefined;
}

const ENRICHMENT_API_KEY = readEnv("ENRICHMENT_API_KEY");
const ENRICHMENT_API_BASE_URL = readEnv("ENRICHMENT_API_BASE_URL");
const SUPABASE_URL = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = readEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

function applyRevenueToMetadata(metadata, revenue) {
  const base = { ...(metadata || {}) };
  if (!revenue) return base;
  if (typeof revenue.annualRevenue === "number") {
    base.annual_revenue = Math.round(revenue.annualRevenue);
  }
  if (typeof revenue.revenueMin === "number") {
    base.revenue_min = Math.round(revenue.revenueMin);
  }
  if (typeof revenue.revenueMax === "number") {
    base.revenue_max = Math.round(revenue.revenueMax);
  }
  if (revenue.confidence || revenue.source || revenue.currency) {
    base.revenue_meta = {
      confidence: revenue.confidence,
      source: revenue.source,
      currency: revenue.currency || "USD",
    };
  }
  return base;
}

async function enrichCompany(companyId) {
  if (!supabase) return { skipped: "supabase_not_configured" };
  if (!ENRICHMENT_API_KEY || !ENRICHMENT_API_BASE_URL) {
    return { skipped: "enrichment_not_configured" };
  }

  const { data: company, error } = await supabase
    .from("companies")
    .select("id, name, domain, metadata")
    .eq("id", companyId)
    .single();
  if (error || !company) throw new Error(`company ${companyId} missing`);

  const base = ENRICHMENT_API_BASE_URL.endsWith("/")
    ? ENRICHMENT_API_BASE_URL
    : ENRICHMENT_API_BASE_URL + "/";
  const res = await fetch(new URL("companies/enrich", base).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${ENRICHMENT_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ domain: company.domain, name: company.name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`enrichment ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();

  const metadata = applyRevenueToMetadata(company.metadata, data.revenue);
  if (data.raw) {
    metadata.enrichment = {
      ...(typeof metadata.enrichment === "object" && metadata.enrichment
        ? metadata.enrichment
        : {}),
      ...data.raw,
      enrichedAt: new Date().toISOString(),
    };
  }
  const update = { metadata, updated_at: new Date().toISOString() };
  if (data.industry) update.industry = data.industry;
  if (data.size) update.size = data.size;
  const { error: updErr } = await supabase
    .from("companies")
    .update(update)
    .eq("id", companyId);
  if (updErr) throw updErr;

  return { companyId, written: true };
}

const worker = new Worker(
  QUEUE_NAMES.FEED_ENRICH_COMPANY,
  async (job) => enrichCompany(job.data.companyId),
  { connection, concurrency: 3 }
);

worker.on("failed", (job, err) => {
  console.error(`[feed-enrich-company] job ${job?.id} failed:`, err.message);
});

worker.on("completed", (job, result) => {
  console.log(`[feed-enrich-company] job ${job.id} done`, result);
});

console.log("[feed-enrich-company] worker started");
