import { Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_NAMES = {
  GHOST_CHECK: "ghost-check",
  ENRICH: "enrich",
} as const;

const globalForQueues = globalThis as unknown as {
  __bullmqConnection?: IORedis;
  __ghostCheckQueue?: Queue;
  __enrichQueue?: Queue;
};

function getConnection(): IORedis {
  if (!globalForQueues.__bullmqConnection) {
    globalForQueues.__bullmqConnection = new IORedis(
      process.env.REDIS_URL || "redis://127.0.0.1:6379",
      { maxRetriesPerRequest: null }
    );
  }
  return globalForQueues.__bullmqConnection;
}

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 24 * 3600 },
};

export function ghostCheckQueue(): Queue {
  if (!globalForQueues.__ghostCheckQueue) {
    globalForQueues.__ghostCheckQueue = new Queue(QUEUE_NAMES.GHOST_CHECK, {
      connection: getConnection(),
      defaultJobOptions,
    });
  }
  return globalForQueues.__ghostCheckQueue;
}

export function enrichQueue(): Queue {
  if (!globalForQueues.__enrichQueue) {
    globalForQueues.__enrichQueue = new Queue(QUEUE_NAMES.ENRICH, {
      connection: getConnection(),
      defaultJobOptions,
    });
  }
  return globalForQueues.__enrichQueue;
}
