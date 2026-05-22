const { Worker } = require("bullmq");
const { createClient } = require("@supabase/supabase-js");
const { connection, QUEUE_NAMES } = require("./queues");

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkRole(roleId) {
  const { data: role, error } = await supabase
    .from("roles")
    .select("id, url, posted_at, last_checked_at, ghost_score")
    .eq("id", roleId)
    .single();

  if (error || !role) {
    throw new Error(`role ${roleId} not found: ${error?.message ?? "missing"}`);
  }

  let score = role.ghost_score ?? 0;

  if (role.posted_at) {
    const ageDays = (Date.now() - new Date(role.posted_at).getTime()) / 86_400_000;
    if (ageDays > 60) score = Math.min(100, score + 40);
    else if (ageDays > 30) score = Math.min(100, score + 20);
  }

  if (role.url) {
    try {
      const res = await fetch(role.url, { method: "HEAD", redirect: "follow" });
      if (!res.ok) score = Math.min(100, score + 30);
    } catch {
      score = Math.min(100, score + 30);
    }
  }

  const isActive = score < 40;

  const { error: updateError } = await supabase
    .from("roles")
    .update({
      ghost_score: score,
      is_active: isActive,
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", roleId);

  if (updateError) throw updateError;

  return { roleId, ghostScore: score, isActive };
}

const worker = new Worker(
  QUEUE_NAMES.GHOST_CHECK,
  async (job) => checkRole(job.data.roleId),
  { connection, concurrency: 5 }
);

worker.on("failed", (job, err) => {
  console.error(`[ghost-check] job ${job?.id} failed:`, err.message);
});

worker.on("completed", (job, result) => {
  console.log(`[ghost-check] job ${job.id} done`, result);
});

console.log("[ghost-check] worker started");
