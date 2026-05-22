import { z } from "zod";

export const FEED_PROVIDERS = ["theirstack", "enrichment"] as const;
export type FeedProvider = (typeof FEED_PROVIDERS)[number];

export const feedSyncBodySchema = z.object({
  dryRun: z.boolean().optional().default(false),
  // Provider-specific knobs. Kept loose — each provider validates what it cares about.
  query: z.string().max(200).optional(),
  postedSince: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  page: z.number().int().min(1).max(100).optional(),
  // Targeted enrichment runs
  companyId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
  // Canonical per-request enrichment endpoint. When supplied the enrichment
  // client POSTs directly to this URL instead of resolving against
  // ENRICHMENT_API_BASE_URL. Use this to point at the specific champion /
  // profile / company resource being enriched.
  targetUrl: z.string().url().max(2000).optional(),
});

export type FeedSyncBody = z.infer<typeof feedSyncBodySchema>;

export const signalIngestSchema = z.object({
  kind: z.enum([
    "role_added",
    "role_removed",
    "company_started_hiring",
    "ghost_detected",
    "custom",
  ]),
  title: z.string().min(1).max(300),
  detail: z.string().max(1000).optional(),
  href: z.string().max(500).optional(),
  companyId: z.string().uuid().optional(),
  roleId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type SignalIngest = z.infer<typeof signalIngestSchema>;
