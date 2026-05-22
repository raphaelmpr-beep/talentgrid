import { Queue } from "bullmq";
import IORedis from "ioredis";
import { redisConfig } from "@/lib/feeds/config";

export const QUEUE_NAMES = {
  GHOST_CHECK: "ghost-check",
  ENRICH: "enrich",
  // Feed integration queues
  FEED_IMPORT_JOBS: "feed-import-jobs",
  FEED_ENRICH_COMPANY: "feed-enrich-company",
  FEED_ENRICH_POC: "feed-enrich-poc",
  FEED_INGEST_SIGNAL: "feed-ingest-signal",
} as const;

const globalForQueues = globalThis as unknown as {
  __bullmqConnection?: IORedis;
  __queues?: Partial<Record<(typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES], Queue>>;
};

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// Returns null when REDIS_URL is absent. Callers must treat null as "queues
// not available" and either fall back to dry-run or surface a 503.
export function getConnection(): IORedis | null {
  if (!globalForQueues.__bullmqConnection) {
    const cfg = redisConfig();
    if (!cfg.configured || !cfg.url) return null;
    globalForQueues.__bullmqConnection = new IORedis(cfg.url, {
      maxRetriesPerRequest: null,
    });
  }
  return globalForQueues.__bullmqConnection;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};

function ensureQueue(name: QueueName): Queue | null {
  const connection = getConnection();
  if (!connection) return null;
  if (!globalForQueues.__queues) globalForQueues.__queues = {};
  const cached = globalForQueues.__queues[name];
  if (cached) return cached;
  const q = new Queue(name, { connection, defaultJobOptions });
  globalForQueues.__queues[name] = q;
  return q;
}

export function ghostCheckQueue(): Queue | null {
  return ensureQueue(QUEUE_NAMES.GHOST_CHECK);
}

export function enrichQueue(): Queue | null {
  return ensureQueue(QUEUE_NAMES.ENRICH);
}

export function feedImportJobsQueue(): Queue | null {
  return ensureQueue(QUEUE_NAMES.FEED_IMPORT_JOBS);
}

export function feedEnrichCompanyQueue(): Queue | null {
  return ensureQueue(QUEUE_NAMES.FEED_ENRICH_COMPANY);
}

export function feedEnrichPocQueue(): Queue | null {
  return ensureQueue(QUEUE_NAMES.FEED_ENRICH_POC);
}

export function feedIngestSignalQueue(): Queue | null {
  return ensureQueue(QUEUE_NAMES.FEED_INGEST_SIGNAL);
}

// Job payload types — exported so workers and producers share one shape.
export type FeedImportJobsPayload = {
  query?: string;
  postedSince?: string;
  limit?: number;
  page?: number;
};

export type FeedEnrichCompanyPayload = {
  companyId: string;
};

export type FeedEnrichPocPayload = {
  companyId: string;
  roleId?: string;
};

export type FeedIngestSignalPayload = {
  kind:
    | "role_added"
    | "role_removed"
    | "company_started_hiring"
    | "ghost_detected"
    | "custom";
  title: string;
  detail?: string;
  href?: string;
  companyId?: string;
  roleId?: string;
  metadata?: Record<string, unknown>;
};
