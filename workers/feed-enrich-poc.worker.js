// POC enrichment worker — discovers champion contacts for a company.
// Persists candidates into companies.metadata.poc_candidates so the
// dashboard can hydrate the PocDrawer without immediately writing into
// the per-user rolodex (rolodex is user-scoped under RLS).

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

async function enrichPoc({ companyId }) {
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
  const res = await fetch(new URL("pocs/enrich", base).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${ENRICHMENT_API_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ companyDomain: company.domain, companyName: company.name }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`enrichment ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];

  const metadata = {
    ...(company.metadata || {}),
    poc_candidates: candidates,
    poc_enriched_at: new Date().toISOString(),
  };
  const { error: updErr } = await supabase
    .from("companies")
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq("id", companyId);
  if (updErr) throw updErr;

  return { companyId, candidates: candidates.length };
}

const worker = new Worker(
  QUEUE_NAMES.FEED_ENRICH_POC,
  async (job) => enrichPoc(job.data),
  { connection, concurrency: 3 }
);

worker.on("failed", (job, err) => {
  console.error(`[feed-enrich-poc] job ${job?.id} failed:`, err.message);
});
worker.on("completed", (job, result) => {
  console.log(`[feed-enrich-poc] job ${job.id} done`, result);
});

console.log("[feed-enrich-poc] worker started");
