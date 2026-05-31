// Mid-market ($100M–$600M revenue) candidate seed layer.
//
// Why this exists
// ---------------
// The two attachment datasets (company seed + job-sources seed) are a *candidate*
// layer: lower-confidence, not-yet-validated companies that must flow through the
// same company -> careers page -> ATS/source mapping -> active jobs -> count
// pipeline before any count is trusted. They are NOT audited exact data.
//
// This module is the single mapping authority shared by:
//   - scripts/import-midmarket-candidates.ts  (upsert into Supabase)
//   - scripts/build-midmarket-validation-seed.ts (emit the open-roles validator seed)
// so the field translation lives in exactly one place.
//
// Revenue mapping invariant
// -------------------------
// The seed reports revenue as MUSD bounds (annual_revenue_min_musd /
// annual_revenue_max_musd). The /api/companies revenue filter compares against
// metadata.revenue_min / metadata.revenue_max in *USD*. We therefore convert
// MUSD -> USD (x1_000_000) so the 100M–600M filter (revenueCategory=100m_600m
// and minRevenue/maxRevenue ranges) matches these companies without inventing a
// fake point estimate. We deliberately do NOT set annual_revenue (a point value)
// because the seed only gives a band.
//
// Trust invariant
// ---------------
// fetch_enabled stays false and source_status stays needs_*; nothing here ever
// writes source_openings_total/source_openings_exact. Those are promotable only
// by the validation workflow after an exact source resolves.

import { z } from "zod";
import type { CompanyImportInput } from "@/lib/feeds/import-companies";

// ---------------------------------------------------------------------------
// Raw seed shapes (as authored in the attachment files)
// ---------------------------------------------------------------------------

export const midmarketCompanySeedSchema = z
  .object({
    id: z.string().trim().min(1).nullish(),
    name: z.string().trim().min(1),
    estimated_revenue_band: z.string().trim().min(1).nullish(),
    annual_revenue_min_musd: z.number().finite().nonnegative().nullish(),
    annual_revenue_max_musd: z.number().finite().nonnegative().nullish(),
    revenue_verification_level: z.string().trim().min(1).nullish(),
    industry: z.string().trim().min(1).nullish(),
    domain_tags: z.array(z.string().trim().min(1)).default([]),
    role_tags: z.array(z.string().trim().min(1)).default([]),
    careers_url: z.string().trim().min(1).nullish(),
    job_portal_url: z.string().trim().min(1).nullish(),
    website_url: z.string().trim().min(1).nullish(),
    country: z.string().trim().min(1).nullish(),
    source_status: z.string().trim().min(1).nullish(),
    fetch_enabled: z.boolean().nullish(),
    validation_enabled: z.boolean().nullish(),
    notes: z.string().nullish(),
  })
  .strip();

export type MidmarketCompanySeed = z.infer<typeof midmarketCompanySeedSchema>;

export const midmarketJobSourceSeedSchema = z
  .object({
    companyName: z.string().trim().min(1),
    sourceName: z.string().trim().min(1).nullish(),
    sourceType: z.string().trim().min(1).nullish(),
    careersUrl: z.string().trim().min(1).nullish(),
    apiUrl: z.string().trim().min(1).nullish(),
    atsSlug: z.string().trim().min(1).nullish(),
    fetchEnabled: z.boolean().nullish(),
    validationEnabled: z.boolean().nullish(),
    sourceStatus: z.string().trim().min(1).nullish(),
  })
  .strip();

export type MidmarketJobSourceSeed = z.infer<typeof midmarketJobSourceSeedSchema>;

export const midmarketCompanySeedFileSchema = z.union([
  z.array(midmarketCompanySeedSchema),
  z.object({ companies: z.array(midmarketCompanySeedSchema) }),
]);

export const midmarketJobSourceSeedFileSchema = z.union([
  z.array(midmarketJobSourceSeedSchema),
  z.object({ job_sources: z.array(midmarketJobSourceSeedSchema) }),
  z.object({ sources: z.array(midmarketJobSourceSeedSchema) }),
]);

export function parseMidmarketCompanies(raw: unknown): MidmarketCompanySeed[] {
  const parsed = midmarketCompanySeedFileSchema.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.companies;
}

export function parseMidmarketJobSources(raw: unknown): MidmarketJobSourceSeed[] {
  const parsed = midmarketJobSourceSeedFileSchema.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if ("job_sources" in parsed) return parsed.job_sources;
  return parsed.sources;
}

// Normalised key for joining a company seed record to its job-source record by
// company name (the only shared key between the two files).
export function midmarketNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const MUSD = 1_000_000;

// USD bounds derived from the MUSD band, or null when the seed gave no band.
export function revenueBoundsUsd(
  company: MidmarketCompanySeed
): { min: number | null; max: number | null } {
  const min =
    typeof company.annual_revenue_min_musd === "number"
      ? Math.round(company.annual_revenue_min_musd * MUSD)
      : null;
  const max =
    typeof company.annual_revenue_max_musd === "number"
      ? Math.round(company.annual_revenue_max_musd * MUSD)
      : null;
  return { min, max };
}

// A company whose source could not be resolved to an ATS/API yet needs source
// mapping; otherwise it just needs a live HTTP validation pass. We prefer the
// job-source record's status (it is the source-mapping authority) and fall back
// to the company record's own status, defaulting to needs_live_http_validation.
function resolveSourceStatus(
  company: MidmarketCompanySeed,
  source: MidmarketJobSourceSeed | undefined
): string {
  return (
    source?.sourceStatus ??
    company.source_status ??
    "needs_live_http_validation"
  );
}

// Map one candidate record (joined with its job-source row when present) into the
// importer's CompanyImportInput. The well-known top-level shortcut fields are
// folded into metadata by buildMetadataPatch, so we pass them top-level; the
// revenue bounds and candidate flags live in the explicit metadata bag.
export function toCompanyImportInput(
  company: MidmarketCompanySeed,
  source: MidmarketJobSourceSeed | undefined
): CompanyImportInput {
  const { min, max } = revenueBoundsUsd(company);
  const sourceStatus = resolveSourceStatus(company, source);

  const metadata: Record<string, unknown> = {
    candidate_seed: true,
    seed_layer: "midmarket_100m_600m",
    seed_id: company.id ?? null,
    estimated_revenue_band: company.estimated_revenue_band ?? null,
    annual_revenue_min_musd: company.annual_revenue_min_musd ?? null,
    annual_revenue_max_musd: company.annual_revenue_max_musd ?? null,
    revenue_verification_level: company.revenue_verification_level ?? "unverified",
    // USD bounds: what the /api/companies revenue filter reads. Inventory-band
    // (revenue_min/revenue_max) rather than a fabricated point estimate.
    revenue_min: min,
    revenue_max: max,
    // Trust gating: validation may run, fetch may not, until a source resolves.
    validation_enabled: company.validation_enabled ?? true,
    fetch_enabled: company.fetch_enabled ?? false,
    notes: company.notes ?? null,
    // Job-source mapping carried verbatim so the validation workflow can resolve
    // the source path (careers page -> ATS/API).
    job_source: source
      ? {
          source_name: source.sourceName ?? "manual",
          source_type: source.sourceType ?? "careers_url",
          careers_url: source.careersUrl ?? company.careers_url ?? null,
          api_url: source.apiUrl ?? null,
          ats_slug: source.atsSlug ?? null,
          fetch_enabled: source.fetchEnabled ?? false,
          validation_enabled: source.validationEnabled ?? true,
          source_status: source.sourceStatus ?? sourceStatus,
        }
      : null,
  };
  // Drop null-ish metadata so we never overwrite richer existing values on
  // re-import (mergeMetadata treats undefined as "skip", but JSON has no
  // undefined — strip explicit nulls except the booleans/flags we want set).
  for (const key of [
    "seed_id",
    "estimated_revenue_band",
    "annual_revenue_min_musd",
    "annual_revenue_max_musd",
    "revenue_min",
    "revenue_max",
    "notes",
  ]) {
    if (metadata[key] === null) delete metadata[key];
  }

  return {
    name: company.name.trim(),
    domain: null,
    website: null,
    industry: company.industry ?? null,
    // Stored as the legacy 100m_600m bucket so the revenueCategory filter matches
    // even for companies that carry no numeric revenue metadata.
    revenue_band: "100m_600m",
    annual_revenue: null,
    domain_tags: company.domain_tags,
    role_tags: company.role_tags,
    monitor: true,
    // Candidates are validation-pending, not asserted-hiring. The validation
    // workflow flips this only after a source resolves with active openings.
    is_hiring: false,
    is_active: null,
    metadata,
    country: company.country ?? null,
    website_url: company.website_url ?? null,
    careers_url: company.careers_url ?? null,
    job_portal_url: company.job_portal_url ?? null,
    career_url_validation: null,
    company_job_source: null,
    ats_type: source?.sourceName && source.sourceName !== "manual" ? source.sourceName : null,
    ats_slug: source?.atsSlug ?? null,
    source_status: sourceStatus,
  };
}

// ---------------------------------------------------------------------------
// Validation-seed shape (matches scripts/validate-open-roles.ts SeedDataset)
// ---------------------------------------------------------------------------

export type MidmarketValidationSeedCompany = {
  company_name: string;
  revenue_band: string;
  estimated_revenue_band: string | null;
  annual_revenue_min_musd: number | null;
  annual_revenue_max_musd: number | null;
  revenue_verification_level: string;
  industry: string | null;
  domain_tags: string[];
  role_tags: string[];
  country: string | null;
  careers_url: string | null;
  job_portal_url: string | null;
  source_name: string | null;
  source_type: string | null;
  api_url: string | null;
  ats_slug: string | null;
  fetch_enabled: boolean;
  validation_enabled: boolean;
  source_status: string;
  seed_layer: string;
  candidate_seed: true;
};

// Map one candidate record (joined with its job-source row) into the open-roles
// validator's per-company seed shape. The validator keys off company_name,
// careers_url, job_portal_url, source_name, api_url and ats_slug.
export function toValidationSeedCompany(
  company: MidmarketCompanySeed,
  source: MidmarketJobSourceSeed | undefined
): MidmarketValidationSeedCompany {
  return {
    company_name: company.name.trim(),
    revenue_band: company.estimated_revenue_band ?? "$100M-$600M",
    estimated_revenue_band: company.estimated_revenue_band ?? null,
    annual_revenue_min_musd: company.annual_revenue_min_musd ?? null,
    annual_revenue_max_musd: company.annual_revenue_max_musd ?? null,
    revenue_verification_level: company.revenue_verification_level ?? "unverified",
    industry: company.industry ?? null,
    domain_tags: company.domain_tags,
    role_tags: company.role_tags,
    country: company.country ?? null,
    careers_url: source?.careersUrl ?? company.careers_url ?? null,
    job_portal_url: company.job_portal_url ?? null,
    source_name: source?.sourceName ?? "manual",
    source_type: source?.sourceType ?? "careers_url",
    api_url: source?.apiUrl ?? null,
    ats_slug: source?.atsSlug ?? null,
    fetch_enabled: source?.fetchEnabled ?? company.fetch_enabled ?? false,
    validation_enabled: source?.validationEnabled ?? company.validation_enabled ?? true,
    source_status: resolveSourceStatus(company, source),
    seed_layer: "midmarket_100m_600m",
    candidate_seed: true,
  };
}

// Join companies to job sources by normalised name and produce both import
// inputs and validation-seed records in one pass, so a name present in one file
// but not the other is handled identically by both consumers.
export function joinMidmarketSeed(
  companies: MidmarketCompanySeed[],
  jobSources: MidmarketJobSourceSeed[]
): {
  importInputs: CompanyImportInput[];
  validationCompanies: MidmarketValidationSeedCompany[];
} {
  const sourceByName = new Map<string, MidmarketJobSourceSeed>();
  for (const source of jobSources) {
    sourceByName.set(midmarketNameKey(source.companyName), source);
  }

  const importInputs: CompanyImportInput[] = [];
  const validationCompanies: MidmarketValidationSeedCompany[] = [];
  for (const company of companies) {
    const source = sourceByName.get(midmarketNameKey(company.name));
    importInputs.push(toCompanyImportInput(company, source));
    validationCompanies.push(toValidationSeedCompany(company, source));
  }
  return { importInputs, validationCompanies };
}
