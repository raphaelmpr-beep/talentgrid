const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
});

const QUEUE_NAMES = Object.freeze({
  GHOST_CHECK: "ghost-check",
  ENRICH: "enrich",
  FEED_IMPORT_JOBS: "feed-import-jobs",
  FEED_ENRICH_COMPANY: "feed-enrich-company",
  FEED_ENRICH_POC: "feed-enrich-poc",
  FEED_INGEST_SIGNAL: "feed-ingest-signal",
});

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};

function queue(name) {
  return new Queue(name, { connection, defaultJobOptions });
}

const ghostCheckQueue = queue(QUEUE_NAMES.GHOST_CHECK);
const enrichQueue = queue(QUEUE_NAMES.ENRICH);
const feedImportJobsQueue = queue(QUEUE_NAMES.FEED_IMPORT_JOBS);
const feedEnrichCompanyQueue = queue(QUEUE_NAMES.FEED_ENRICH_COMPANY);
const feedEnrichPocQueue = queue(QUEUE_NAMES.FEED_ENRICH_POC);
const feedIngestSignalQueue = queue(QUEUE_NAMES.FEED_INGEST_SIGNAL);

module.exports = {
  connection,
  QUEUE_NAMES,
  ghostCheckQueue,
  enrichQueue,
  feedImportJobsQueue,
  feedEnrichCompanyQueue,
  feedEnrichPocQueue,
  feedIngestSignalQueue,
};
