const { Worker } = require("bullmq");
const { createClient } = require("@supabase/supabase-js");
const { connection, QUEUE_NAMES } = require("./queues");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function enrichCompany(companyId) {
  const { data: company, error } = await supabase
    .from("companies")
    .select("id, name, domain, website, metadata")
    .eq("id", companyId)
    .single();

  if (error || !company) {
    throw new Error(`company ${companyId} not found: ${error?.message ?? "missing"}`);
  }

  // Placeholder enrichment: in production this would call an external
  // data provider (Clearbit / TheirStack / etc.) and merge the response.
  const enrichedMetadata = {
    ...(company.metadata ?? {}),
    enrichedAt: new Date().toISOString(),
  };

  const { error: updateError } = await supabase
    .from("companies")
    .update({ metadata: enrichedMetadata, updated_at: new Date().toISOString() })
    .eq("id", companyId);

  if (updateError) throw updateError;

  return { companyId, enrichedAt: enrichedMetadata.enrichedAt };
}

const worker = new Worker(
  QUEUE_NAMES.ENRICH,
  async (job) => enrichCompany(job.data.companyId),
  { connection, concurrency: 3 }
);

worker.on("failed", (job, err) => {
  console.error(`[enrich] job ${job?.id} failed:`, err.message);
});

worker.on("completed", (job, result) => {
  console.log(`[enrich] job ${job.id} done`, result);
});

console.log("[enrich] worker started");
