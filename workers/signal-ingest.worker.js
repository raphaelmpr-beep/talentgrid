// Persists signal events into public.signals. The signal feed component
// reads (and subscribes to) this table via Supabase realtime.

const { Worker } = require("bullmq");
const { createClient } = require("@supabase/supabase-js");
const { connection, QUEUE_NAMES } = require("./queues");

function readEnv(name) {
  const v = process.env[name];
  return v && String(v).trim().length > 0 ? v : undefined;
}

const SUPABASE_URL = readEnv("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = readEnv("SUPABASE_SERVICE_ROLE_KEY");

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

async function ingestSignal(payload) {
  if (!supabase) return { skipped: "supabase_not_configured" };
  const { error } = await supabase.from("signals").insert({
    kind: payload.kind,
    title: payload.title,
    detail: payload.detail || null,
    href: payload.href || null,
    company_id: payload.companyId || null,
    role_id: payload.roleId || null,
    metadata: payload.metadata || {},
  });
  if (error) throw error;
  return { written: true, kind: payload.kind };
}

const worker = new Worker(
  QUEUE_NAMES.FEED_INGEST_SIGNAL,
  async (job) => ingestSignal(job.data),
  { connection, concurrency: 5 }
);

worker.on("failed", (job, err) => {
  console.error(`[signal-ingest] job ${job?.id} failed:`, err.message);
});
worker.on("completed", (job, result) => {
  console.log(`[signal-ingest] job ${job.id} done`, result);
});

console.log("[signal-ingest] worker started");
