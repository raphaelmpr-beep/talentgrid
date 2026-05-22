const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis(process.env.REDIS_URL || "redis://127.0.0.1:6379", {
  maxRetriesPerRequest: null,
});

const QUEUE_NAMES = Object.freeze({
  GHOST_CHECK: "ghost-check",
  ENRICH: "enrich",
});

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};

const ghostCheckQueue = new Queue(QUEUE_NAMES.GHOST_CHECK, {
  connection,
  defaultJobOptions,
});

const enrichQueue = new Queue(QUEUE_NAMES.ENRICH, {
  connection,
  defaultJobOptions,
});

module.exports = {
  connection,
  QUEUE_NAMES,
  ghostCheckQueue,
  enrichQueue,
};
