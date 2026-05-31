// Company universe ingestion. Takes a batch of caller-supplied company
// records and upserts them into public.companies so the company-first views
// can grow toward hundreds of monitored companies organised by revenue band.
//
// Design goals:
//   - Idempotent: re-running the same batch makes no destructive change.
//   - Dedupe on domain first (the schema's unique key), then by normalised
//     name when no domain is available.
//   - Non-destructive metadata: existing metadata is read and deep-merged so
//     enrichment data (revenue, POC, etc.) is never clobbered by a re-import.
//   - dryRun-capable: every read happens, but no write is issued, mirroring
//     the convention in lib/feeds/sync.ts.

import { z } from "zod";

// companies.revenue_band is a free-text label. Two label families flow through
// it and the API filter must understand both:
//
//   1. Legacy internal buckets, capped at 1B+:
//        lt_50m | 50m_100m | 100m_600m | 600m_1b | gt_1b
//   2. The large-cap seed dataset bands the import utility ingests:
//        $1B-$10B | $10B-$50B | $50B-$100B | $100B-$250B | $250B-$500B | $500B+
//
// The seed bands are all subdivisions of the legacy gt_1b bucket, so they
// cannot be losslessly collapsed onto the legacy keys. We therefore store the
// seed band verbatim (canonicalised) and keep a separate legacy-key normaliser
// for the older convention. The API filter (app/api/companies/route.ts) matches
// against both families.
export type RevenueBand = "lt_50m" | "50m_100m" | "100m_600m" | "600m_1b" | "gt_1b";

const LEGACY_REVENUE_BAND_BY_LABEL: Record<string, RevenueBand> = {
  lt_50m: "lt_50m",
  "50m_100m": "50m_100m",
  "100m_600m": "100m_600m",
  "600m_1b": "600m_1b",
  gt_1b: "gt_1b",
  "<50m": "lt_50m",
  "50m-100m": "50m_100m",
  "100m-600m": "100m_600m",
  "600m-1b": "600m_1b",
  "1b+": "gt_1b",
};

// Canonical seed-dataset bands, keyed by a normalised form (lowercased, "$" and
// whitespace stripped) so "$1B-$10B", "1b-10b", and " $1B - $10B " all resolve.
const SEED_REVENUE_BANDS = [
  "$1B-$10B",
  "$10B-$50B",
  "$50B-$100B",
  "$100B-$250B",
  "$250B-$500B",
  "$500B+",
] as const;

export type SeedRevenueBand = (typeof SEED_REVENUE_BANDS)[number];

function canonicalBandKey(value: string): string {
  return value.trim().toLowerCase().replace(/[$\s]/g, "");
}

const SEED_REVENUE_BAND_BY_KEY: Record<string, SeedRevenueBand> = Object.fromEntries(
  SEED_REVENUE_BANDS.map((band) => [canonicalBandKey(band), band])
);

// Resolve a caller-supplied revenue_band into the value we persist. Seed bands
// win and are stored verbatim; otherwise we fall back to the legacy bucket key.
export function normalizeRevenueBand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seed = SEED_REVENUE_BAND_BY_KEY[canonicalBandKey(trimmed)];
  if (seed) return seed;
  return LEGACY_REVENUE_BAND_BY_LABEL[trimmed.toLowerCase()] ?? null;
}

// Derive a band from a numeric annual-revenue figure. Above 1B we emit the
// seed band so large-cap companies imported with annual_revenue but no explicit
// band still land in a meaningful bucket.
export function revenueBandFromAmount(revenue: number | null | undefined): string | null {
  if (typeof revenue !== "number" || !Number.isFinite(revenue) || revenue <= 0) return null;
  if (revenue < 50_000_000) return "lt_50m";
  if (revenue < 100_000_000) return "50m_100m";
  if (revenue < 600_000_000) return "100m_600m";
  if (revenue < 1_000_000_000) return "600m_1b";
  if (revenue < 10_000_000_000) return "$1B-$10B";
  if (revenue < 50_000_000_000) return "$10B-$50B";
  if (revenue < 100_000_000_000) return "$50B-$100B";
  if (revenue < 250_000_000_000) return "$100B-$250B";
  if (revenue < 500_000_000_000) return "$250B-$500B";
  return "$500B+";
}

// Shape a caller is expected to provide. Everything except `name` is optional;
// metadata fields (country, website_url, careers_url, ats_*) live in the jsonb
// blob to match the additive convention in migration 004.
export const companyImportSchema = z
  .object({
    name: z.string().trim().min(1, "name is required"),
    domain: z.string().trim().min(1).nullish(),
    website: z.string().trim().min(1).nullish(),
    industry: z.string().trim().min(1).nullish(),
    revenue_band: z.string().trim().min(1).nullish(),
    annual_revenue: z.number().finite().positive().nullish(),
    domain_tags: z.array(z.string().trim().min(1)).default([]),
    role_tags: z.array(z.string().trim().min(1)).default([]),
    monitor: z.boolean().default(true),
    is_hiring: z.boolean().nullish(),
    is_active: z.boolean().nullish(),
    // Free-form metadata bag; the well-known keys below are also accepted as
    // top-level shortcuts and folded into metadata.
    metadata: z.record(z.unknown()).default({}),
    country: z.string().trim().min(1).nullish(),
    website_url: z.string().trim().min(1).nullish(),
    careers_url: z.string().trim().min(1).nullish(),
    // Direct careers/ATS portal metadata from the seed file. `job_portal_url`
    // is the ATS-hosted listing page (when distinct from careers_url);
    // `career_url_validation` records how the URL was checked; and
    // `company_job_source` describes the resolved source path the careers-portal
    // provider should follow. Stored verbatim as nested objects.
    job_portal_url: z.string().trim().min(1).nullish(),
    career_url_validation: z.record(z.unknown()).nullish(),
    company_job_source: z.record(z.unknown()).nullish(),
    ats_type: z.string().trim().min(1).nullish(),
    ats_slug: z.string().trim().min(1).nullish(),
    source_status: z.string().trim().min(1).nullish(),
  })
  .strip();

export type CompanyImportInput = z.infer<typeof companyImportSchema>;

export const companyImportBatchSchema = z.union([
  companyImportSchema,
  z.array(companyImportSchema),
  z.object({ companies: z.array(companyImportSchema) }),
]);

export function parseCompanyBatch(raw: unknown): CompanyImportInput[] {
  const parsed = companyImportBatchSchema.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if ("companies" in parsed) return parsed.companies;
  return [parsed];
}

// Lowercased, host-only domain so "https://Acme.com/" and "acme.com" dedupe
// to the same row.
export function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  let v = value.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "");
  v = v.split("/")[0].split("?")[0].split("#")[0];
  return v || null;
}

export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// Hosts that belong to ATS/job-board vendors rather than the company itself.
// Deriving a company `domain` from a careers URL pointing at one of these would
// be wrong (it would collide many companies onto e.g. "greenhouse.io"), so we
// refuse to derive a domain from them and only keep the URL in metadata.
const VENDOR_HOST_SUFFIXES = [
  "greenhouse.io",
  "boards.greenhouse.io",
  "lever.co",
  "jobs.lever.co",
  "myworkdayjobs.com",
  "workday.com",
  "ashbyhq.com",
  "jobs.ashbyhq.com",
  "smartrecruiters.com",
  "icims.com",
  "taleo.net",
  "successfactors.com",
  "bamboohr.com",
  "workable.com",
  "jobvite.com",
  "recruitee.com",
  "breezy.hr",
  "applytojob.com",
  "jazz.co",
  "jazzhr.com",
  "linkedin.com",
  "indeed.com",
  "google.com",
  "bing.com",
];

export function isVendorHost(domain: string | null | undefined): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return VENDOR_HOST_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`));
}

// Derive a company domain from a careers/website URL only when it is safe:
// the URL must parse to a real host that is not an ATS/job-board vendor host.
// Returns null when no safe domain can be derived (caller then preserves
// metadata without touching `companies.domain`).
export function deriveCompanyDomain(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const domain = normalizeDomain(candidate);
    if (domain && !isVendorHost(domain)) return domain;
  }
  return null;
}

// Deep-merge metadata so a re-import never drops keys an enrichment pass wrote.
// Incoming values win for scalar collisions, but objects merge recursively and
// existing keys absent from the incoming patch are preserved.
export function mergeMetadata(
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming ?? {})) {
    if (value === undefined) continue;
    const prev = out[key];
    if (isPlainObject(prev) && isPlainObject(value)) {
      out[key] = mergeMetadata(prev, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Fold the well-known top-level shortcut fields into a metadata patch without
// overwriting anything already inside the caller's explicit metadata object.
export function buildMetadataPatch(input: CompanyImportInput): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...input.metadata };
  const shortcuts: Array<[string, unknown]> = [
    ["country", input.country],
    ["website_url", input.website_url],
    ["careers_url", input.careers_url],
    ["job_portal_url", input.job_portal_url],
    ["career_url_validation", input.career_url_validation],
    ["company_job_source", input.company_job_source],
    ["ats_type", input.ats_type],
    ["ats_slug", input.ats_slug],
    ["source_status", input.source_status],
  ];
  for (const [key, value] of shortcuts) {
    if (value != null && patch[key] === undefined) patch[key] = value;
  }
  if (typeof input.annual_revenue === "number" && patch.annual_revenue === undefined) {
    patch.annual_revenue = Math.round(input.annual_revenue);
  }
  return patch;
}

// Minimal structural type for the Supabase client, matching the style used in
// lib/feeds/sync.ts so tests/dry-run can pass a stub.
export type CompaniesClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        limit: (n: number) => Promise<{
          data: ExistingCompany[] | null;
          error: { message: string } | null;
        }>;
      };
      ilike: (column: string, value: string) => {
        limit: (n: number) => Promise<{
          data: ExistingCompany[] | null;
          error: { message: string } | null;
        }>;
      };
    };
    insert: (values: Record<string, unknown>) => {
      select: (columns: string) => {
        single: () => Promise<{
          data: { id: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (values: Record<string, unknown>) => {
      eq: (
        column: string,
        value: string
      ) => Promise<{ error: { message: string } | null }>;
    };
  };
};

type ExistingCompany = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  revenue_band: string | null;
  domain_tags: string[] | null;
  role_tags: string[] | null;
  monitor: boolean | null;
  is_hiring: boolean | null;
  metadata: Record<string, unknown> | null;
};

const SELECT_COLUMNS =
  "id, name, domain, industry, revenue_band, domain_tags, role_tags, monitor, is_hiring, metadata";

export type CompanyImportOutcome = "inserted" | "updated" | "skipped" | "error";

export type CompanyImportResult = {
  name: string;
  domain: string | null;
  outcome: CompanyImportOutcome;
  id?: string;
  error?: string;
};

export type ImportCompaniesReport = {
  dryRun: boolean;
  total: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  results: CompanyImportResult[];
};

function uniqueStrings(...lists: Array<string[] | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const list of lists) {
    for (const item of list ?? []) {
      const v = item.trim();
      if (v) seen.add(v);
    }
  }
  return [...seen];
}

async function findExisting(
  supabase: CompaniesClient,
  domain: string | null,
  name: string
): Promise<{ company: ExistingCompany | null; error?: string }> {
  if (domain) {
    const { data, error } = await supabase
      .from("companies")
      .select(SELECT_COLUMNS)
      .eq("domain", domain)
      .limit(1);
    if (error) return { company: null, error: error.message };
    if (data && data.length > 0) return { company: data[0] };
  }
  // No domain match: fall back to a case-insensitive exact name match so
  // domain-less records still dedupe across re-imports.
  const { data, error } = await supabase
    .from("companies")
    .select(SELECT_COLUMNS)
    .ilike("name", name)
    .limit(1);
  if (error) return { company: null, error: error.message };
  if (data && data.length > 0) return { company: data[0] };
  return { company: null };
}

// Upsert one company. Reads the existing row first (when present) so metadata
// merges instead of being replaced — Supabase's native upsert would overwrite
// the whole jsonb column.
export async function importCompany(
  input: CompanyImportInput,
  supabase: CompaniesClient,
  options: { dryRun: boolean }
): Promise<CompanyImportResult> {
  const domain =
    normalizeDomain(input.domain ?? input.website_url ?? input.website) ??
    deriveCompanyDomain(input.careers_url, input.job_portal_url);
  const name = input.name.trim();

  const { company: existing, error: lookupErr } = await findExisting(
    supabase,
    domain,
    name
  );
  if (lookupErr) {
    return { name, domain, outcome: "error", error: lookupErr };
  }

  const metadataPatch = buildMetadataPatch(input);
  const revenueBand =
    normalizeRevenueBand(input.revenue_band) ??
    revenueBandFromAmount(input.annual_revenue);

  if (existing) {
    const mergedMetadata = mergeMetadata(existing.metadata, metadataPatch);
    const update: Record<string, unknown> = {
      metadata: mergedMetadata,
      updated_at: new Date().toISOString(),
    };
    // Only fill gaps / extend — never blank out useful existing values.
    if (input.industry && !existing.industry) update.industry = input.industry;
    if (revenueBand && !existing.revenue_band) update.revenue_band = revenueBand;
    const mergedDomainTags = uniqueStrings(existing.domain_tags, input.domain_tags);
    const mergedRoleTags = uniqueStrings(existing.role_tags, input.role_tags);
    if (mergedDomainTags.length !== (existing.domain_tags?.length ?? 0)) {
      update.domain_tags = mergedDomainTags;
    }
    if (mergedRoleTags.length !== (existing.role_tags?.length ?? 0)) {
      update.role_tags = mergedRoleTags;
    }
    if (input.monitor && !existing.monitor) update.monitor = true;
    if (typeof input.is_hiring === "boolean" && input.is_hiring && !existing.is_hiring) {
      update.is_hiring = true;
    }
    if (domain && !existing.domain) update.domain = domain;

    if (options.dryRun) {
      return { name, domain, outcome: "updated", id: existing.id };
    }
    const { error } = await supabase
      .from("companies")
      .update(update)
      .eq("id", existing.id);
    if (error) return { name, domain, outcome: "error", id: existing.id, error: error.message };
    return { name, domain, outcome: "updated", id: existing.id };
  }

  const insertRow: Record<string, unknown> = {
    name,
    domain,
    industry: input.industry ?? null,
    revenue_band: revenueBand,
    domain_tags: uniqueStrings(input.domain_tags),
    role_tags: uniqueStrings(input.role_tags),
    monitor: input.monitor,
    is_hiring: input.is_hiring ?? false,
    metadata: metadataPatch,
  };

  if (options.dryRun) {
    return { name, domain, outcome: "inserted" };
  }
  const { data, error } = await supabase
    .from("companies")
    .insert(insertRow)
    .select("id")
    .single();
  if (error || !data) {
    return { name, domain, outcome: "error", error: error?.message ?? "insert returned no row" };
  }
  return { name, domain, outcome: "inserted", id: data.id };
}

export async function importCompanies(
  inputs: CompanyImportInput[],
  supabase: CompaniesClient | null,
  options: { dryRun: boolean }
): Promise<ImportCompaniesReport> {
  const dryRun = options.dryRun || !supabase;
  const report: ImportCompaniesReport = {
    dryRun,
    total: inputs.length,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    results: [],
  };

  // Track keys seen within this batch so duplicates in the same payload
  // collapse onto one row instead of racing each other.
  const seenDomains = new Set<string>();
  const seenNames = new Set<string>();

  for (const input of inputs) {
    const domain =
      normalizeDomain(input.domain ?? input.website_url ?? input.website) ??
      deriveCompanyDomain(input.careers_url, input.job_portal_url);
    const nameKey = normalizeName(input.name);
    const seen = domain ? seenDomains.has(domain) : seenNames.has(nameKey);
    if (seen) {
      report.skipped += 1;
      report.results.push({ name: input.name, domain, outcome: "skipped" });
      continue;
    }
    if (domain) seenDomains.add(domain);
    else seenNames.add(nameKey);

    if (!supabase) {
      // No client: pure dry-run accounting so the primary agent can preview.
      const result: CompanyImportResult = {
        name: input.name,
        domain,
        outcome: "inserted",
      };
      report.inserted += 1;
      report.results.push(result);
      continue;
    }

    const result = await importCompany(input, supabase, { dryRun });
    report.results.push(result);
    if (result.outcome === "inserted") report.inserted += 1;
    else if (result.outcome === "updated") report.updated += 1;
    else if (result.outcome === "skipped") report.skipped += 1;
    else report.errors += 1;
  }

  return report;
}
