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

// Bounded-batch params for the cron refresh endpoint. Parsed from the query
// string (GET, sent by Vercel cron) and accepted on POST too. Keeping the batch
// finite is what stops the endpoint from evaluating every monitored company —
// and every careers/TheirStack source — inside a single Vercel invocation.
export const REFRESH_DEFAULT_LIMIT = 20;
export const REFRESH_MAX_LIMIT = 50;

// Coerce a query-string value (always a string) into an int, then clamp.
const intParam = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? v : Number.parseInt(v, 10)))
  .pipe(z.number().int());

export const refreshJobsQuerySchema = z
  .object({
    dryRun: z
      .union([z.string(), z.boolean()])
      .transform((v) => v === true || v === "true" || v === "1")
      .default(false),
    limit: intParam
      .pipe(z.number().min(1).max(REFRESH_MAX_LIMIT))
      .default(REFRESH_DEFAULT_LIMIT),
    offset: intParam.pipe(z.number().min(0)).default(0),
    // Optional single-company targeting. companyId is a UUID; companyName is a
    // case-insensitive exact match; slug/atsSlug match companies.metadata.ats_slug
    // (the importer stores the ATS slug there — there is no top-level slug column).
    companyId: z.string().uuid().optional(),
    companyName: z.string().trim().min(1).max(200).optional(),
    slug: z.string().trim().min(1).max(200).optional(),
    atsSlug: z.string().trim().min(1).max(200).optional(),
  })
  .strip();

export type RefreshJobsQuery = z.infer<typeof refreshJobsQuerySchema>;

// POST /api/jobs/fetch-company body. Targets one company by id.
export const fetchCompanyBodySchema = z
  .object({
    company_id: z.string().uuid(),
    dryRun: z.boolean().optional().default(false),
    maxJobs: z.number().int().min(1).max(1000).optional(),
  })
  .strip();

export type FetchCompanyBody = z.infer<typeof fetchCompanyBodySchema>;

// POST /api/jobs/fetch-all body. Bounded batch across companies that have a
// validated fetchable source.
export const fetchAllBodySchema = z
  .object({
    dryRun: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(200).optional().default(50),
    offset: z.number().int().min(0).optional().default(0),
    maxJobs: z.number().int().min(1).max(1000).optional(),
  })
  .strip();

export type FetchAllBody = z.infer<typeof fetchAllBodySchema>;
