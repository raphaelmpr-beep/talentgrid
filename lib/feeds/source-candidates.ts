// ATS source-candidate normaliser + import mapping authority.
//
// Why this exists
// ---------------
// Open-source job-source datasets (stapply-ai/jobhive, outscal/OpenJobs, …) are
// useful for *discovering* which ATS a company uses, but they are NOT truth:
// slugs go stale, vendors change, and licenses differ. This module turns those
// heterogeneous records into a single normalised candidate shape destined for
// the public.company_job_sources_candidate quarantine table
// (supabase/migrations/005_company_job_sources_candidate.sql), where every row
// is fetch_enabled=false until TalentGrid's own provider validates it.
//
// Design (mirrors lib/feeds/midmarket-seed.ts):
//   - Pure, dependency-light, unit-testable: no network, no Supabase here.
//   - Reflects the research in ats_source_mapping_research.md: jobhive is the
//     primary seed, OpenJobs the supplement, CC BY-NC datasets are NOT enabled
//     by default, and iCIMS/JazzHR are imported as unsupported_source_type.
//   - Never fabricates a count. The only thing produced is a discovery mapping
//     plus a confidence_score; counts are the validation workflow's job.
//
// See docs/ats-source-candidates.md for the full import/validation/promotion
// flow and the hard safety rules.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// The documented, user-facing source-origin set (task contract). Internal
// dataset aliases are accepted on input and mapped onto these.
export const SOURCE_ORIGINS = [
  "manual",
  "openjobs",
  "levergreen",
  "ats_scrapers",
  "jobber",
  "other",
] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

// Clearer internal aliases callers may pass; mapped to the documented names so
// the table and docs stay on the requested vocabulary.
const SOURCE_ORIGIN_ALIASES: Record<string, SourceOrigin> = {
  jobhive: "ats_scrapers",
  "ats-scrapers": "ats_scrapers",
  "stapply-ai": "ats_scrapers",
  outscal_openjobs: "openjobs",
  "outscal/openjobs": "openjobs",
  outscal: "openjobs",
  "job-board-scraper": "levergreen",
  levergreen_dev: "levergreen",
};

export function normalizeSourceOrigin(value: unknown): SourceOrigin {
  if (typeof value !== "string") return "other";
  const key = value.trim().toLowerCase();
  if ((SOURCE_ORIGINS as readonly string[]).includes(key)) return key as SourceOrigin;
  return SOURCE_ORIGIN_ALIASES[key] ?? "other";
}

// The validation lifecycle states (mirror the SQL CHECK constraint).
export const VALIDATION_STATUSES = [
  "imported_unvalidated",
  "validated_fetchable",
  "validation_failed",
  "stale_import",
  "source_changed",
  "duplicate_source",
  "unsupported_source_type",
] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

export type SupportedFetchStrategy = "exact_api" | "html_only" | "unsupported";

// ---------------------------------------------------------------------------
// ATS vendor vocabulary + fetch-strategy classification
//
// Canonical vendor names follow the careers-portal provider + the ever-jobs
// siteType vocabulary (research §1.6). A vendor's fetch strategy decides the
// ceiling of what validation can achieve:
//   exact_api   -> the provider can hit a keyless public JSON board API and get
//                  a vendor-exact total (Greenhouse/Lever/Workday today; the
//                  others are exact-capable in principle and validation decides).
//   html_only   -> only a best-effort HTML/XML scrape is possible: never exact.
//   unsupported -> no self-serve fetch path (iCIMS official API is partner-gated,
//                  JazzHR has no stable public JSON API). Imported but not probed
//                  for an exact count.
// ---------------------------------------------------------------------------

// Vendors the careers-portal provider resolves to an EXACT public JSON board
// today. Validation can promote these to validated_fetchable.
const EXACT_API_VENDORS = new Set(["greenhouse", "lever", "ashby", "workday"]);

// Vendors with a public JSON/XML endpoint that TalentGrid does not yet resolve
// to an exact total in the provider. They are imported as discovery rows but
// validation will not mark them validated_fetchable (non-exact), matching the
// research's "do not promote counts as exact" rule.
const HTML_ONLY_VENDORS = new Set([
  "smartrecruiters",
  "workable",
  "recruitee",
  "teamtailor",
  "bamboohr",
  "personio",
  "breezy",
  "jobvite",
  "joincom",
  "rippling",
  "gem",
  "pinpoint",
]);

// Vendors with no self-serve exact fetch path (partner-gated or HTML-only,
// flagged unsupported per research §4.5 safety rules 5).
const UNSUPPORTED_VENDORS = new Set(["icims", "jazzhr", "taleo", "successfactors", "oracle"]);

export function fetchStrategyForVendor(
  vendor: string | null | undefined
): SupportedFetchStrategy {
  if (!vendor) return "unsupported";
  const v = vendor.trim().toLowerCase();
  if (EXACT_API_VENDORS.has(v)) return "exact_api";
  if (HTML_ONLY_VENDORS.has(v)) return "html_only";
  if (UNSUPPORTED_VENDORS.has(v)) return "unsupported";
  return "unsupported";
}

// Map a vendor + strategy to the source_type label the provider/docs use.
function sourceTypeForVendor(
  vendor: string | null | undefined,
  strategy: SupportedFetchStrategy
): string {
  const v = (vendor ?? "").trim().toLowerCase();
  if (v === "workday") return "api_json_post";
  if (v === "workable") return "api_graphql";
  if (v === "personio") return "api_xml";
  if (strategy === "exact_api" || strategy === "html_only") return "api_json";
  if (v === "icims") return "api_gated";
  return "html_scrape";
}

// ---------------------------------------------------------------------------
// Normalised candidate shape (one row of company_job_sources_candidate)
// ---------------------------------------------------------------------------

export type NormalizedSourceCandidate = {
  company_name: string;
  source_origin: SourceOrigin;
  source_origin_url: string | null;
  source_name: string | null; // canonical ATS vendor
  ats_slug: string | null;
  careers_url: string | null;
  api_url: string | null;
  source_type: string | null;
  supported_fetch_strategy: SupportedFetchStrategy;
  validation_status: ValidationStatus;
  confidence_score: number;
  fetch_enabled: false; // ALWAYS false on import — only promotion flips it.
  validation_enabled: boolean;
  manually_verified: boolean;
};

// ---------------------------------------------------------------------------
// Vendor detection from URLs / type strings
// ---------------------------------------------------------------------------

// Map a host or free-text ATS type onto a canonical vendor name. Returns null
// when nothing recognisable is present.
export function detectVendor(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;
  // Direct vendor-name match first (jobhive ats_type, ever-jobs siteType).
  const known = [
    ...EXACT_API_VENDORS,
    ...HTML_ONLY_VENDORS,
    ...UNSUPPORTED_VENDORS,
  ];
  for (const vendor of known) {
    if (v === vendor) return vendor;
  }
  // Host-pattern match for ats_links[] style URLs.
  const HOST_PATTERNS: Array<[RegExp, string]> = [
    [/greenhouse\.io/, "greenhouse"],
    [/lever\.co/, "lever"],
    [/myworkdayjobs\.com|workday\.com/, "workday"],
    [/ashbyhq\.com/, "ashby"],
    [/smartrecruiters\.com/, "smartrecruiters"],
    [/workable\.com/, "workable"],
    [/recruitee\.com/, "recruitee"],
    [/teamtailor\.com/, "teamtailor"],
    [/bamboohr\.com/, "bamboohr"],
    [/personio\.(com|de)/, "personio"],
    [/breezy\.hr/, "breezy"],
    [/jobvite\.com/, "jobvite"],
    [/join\.com/, "joincom"],
    [/rippling\.com/, "rippling"],
    [/icims\.com/, "icims"],
    [/applytojob\.com|jazz\.co|jazzhr\.com/, "jazzhr"],
    [/taleo\.net/, "taleo"],
    [/successfactors\.com/, "successfactors"],
  ];
  for (const [re, vendor] of HOST_PATTERNS) {
    if (re.test(v)) return vendor;
  }
  return null;
}

// Extract a board slug from a known ATS URL. Conservative: returns null when the
// host isn't recognised or the slug position is ambiguous.
export function slugFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);

  if (host.endsWith("greenhouse.io")) {
    const idx = parts.indexOf("boards");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return parts[0] ?? null;
  }
  if (host.endsWith("lever.co")) {
    const idx = parts.indexOf("postings");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    if (parts[0] && parts[0] !== "v0") return parts[0];
    return null;
  }
  if (host.endsWith("ashbyhq.com")) {
    const idx = parts.indexOf("job-board");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return parts[parts.length - 1] ?? null;
  }
  if (host.endsWith("recruitee.com") || host.endsWith("bamboohr.com")) {
    // {slug}.recruitee.com / {slug}.bamboohr.com
    const sub = host.split(".")[0];
    return sub && sub !== "www" ? sub : null;
  }
  if (host.endsWith("smartrecruiters.com")) {
    const idx = parts.indexOf("companies");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return parts[parts.length - 1] ?? null;
  }
  if (host.endsWith("myworkdayjobs.com")) {
    // Workday's identifier is tenant+site, not a single slug; the tenant is the
    // left-most host label. Return it as the slug for dedup, but the provider
    // resolves the full board from the URL (carried in careers_url/api_url).
    return host.split(".")[0] ?? null;
  }
  // Generic ATS: last non-empty path segment is the usual slug position.
  return parts[parts.length - 1] ?? null;
}

// ---------------------------------------------------------------------------
// Confidence scoring (research §4.3)
// ---------------------------------------------------------------------------

// Base confidence by origin + how complete the resolved mapping is. These are
// pre-validation discovery scores; validation adjusts them (+0.20 on success,
// -0.30 on failure) — see source-candidate-validation.ts.
export function baseConfidence(
  origin: SourceOrigin,
  strategy: SupportedFetchStrategy,
  hasSlug: boolean
): number {
  let score: number;
  switch (origin) {
    case "manual":
      return 1.0; // human-verified; never auto-overwritten.
    case "ats_scrapers": // jobhive — primary seed.
      score = hasSlug ? 0.75 : 0.55;
      break;
    case "openjobs":
      score = hasSlug ? 0.6 : 0.35;
      break;
    case "levergreen":
      score = hasSlug ? 0.6 : 0.4;
      break;
    case "jobber":
      score = hasSlug ? 0.5 : 0.3;
      break;
    default:
      score = hasSlug ? 0.45 : 0.3;
  }
  // An unsupported fetch path can never be promoted to an exact count, so cap
  // its discovery confidence lower to reflect the lower utility.
  if (strategy === "unsupported") score = Math.min(score, 0.4);
  return round3(score);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Raw source record schemas
// ---------------------------------------------------------------------------

// outscal/OpenJobs companies_v2.json record: { name, website, ats_links[] }.
// ats_links may be strings or { type, url } objects depending on dataset age.
const openJobsAtsLinkSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      type: z.string().trim().min(1).nullish(),
      url: z.string().trim().min(1).nullish(),
      ats: z.string().trim().min(1).nullish(),
    })
    .strip(),
]);

export const openJobsRecordSchema = z
  .object({
    name: z.string().trim().min(1),
    website: z.string().trim().min(1).nullish(),
    ats_links: z.array(openJobsAtsLinkSchema).default([]),
  })
  .strip();

export type OpenJobsRecord = z.infer<typeof openJobsRecordSchema>;

// jobhive (stapply-ai/ats-scrapers) row: { company, ats_type, ats_id, url, … }.
export const jobhiveRecordSchema = z
  .object({
    company: z.string().trim().min(1),
    ats_type: z.string().trim().min(1).nullish(),
    ats_id: z.string().trim().min(1).nullish(),
    url: z.string().trim().min(1).nullish(),
    apply_url: z.string().trim().min(1).nullish(),
  })
  .strip();

export type JobhiveRecord = z.infer<typeof jobhiveRecordSchema>;

// A generic candidate row authored directly (manual seed / fixture). Mirrors the
// table columns; everything except company_name is optional.
export const candidateRowSchema = z
  .object({
    company_name: z.string().trim().min(1),
    source_origin: z.string().trim().min(1).nullish(),
    source_origin_url: z.string().trim().min(1).nullish(),
    source_name: z.string().trim().min(1).nullish(),
    ats_slug: z.string().trim().min(1).nullish(),
    careers_url: z.string().trim().min(1).nullish(),
    api_url: z.string().trim().min(1).nullish(),
    source_type: z.string().trim().min(1).nullish(),
    validation_enabled: z.boolean().nullish(),
    manually_verified: z.boolean().nullish(),
  })
  .strip();

export type CandidateRow = z.infer<typeof candidateRowSchema>;

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

const DEFAULT_ORIGIN_URLS: Partial<Record<SourceOrigin, string>> = {
  ats_scrapers: "https://github.com/kalil0321/ats-scrapers",
  openjobs: "https://github.com/outscal/OpenJobs",
  levergreen: "https://github.com/adgramigna/job-board-scraper",
  jobber: "https://github.com/plibither8/jobber",
};

function resolveOriginUrl(origin: SourceOrigin, explicit: string | null | undefined): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  return DEFAULT_ORIGIN_URLS[origin] ?? null;
}

// Build the initial validation_status for an import: an unsupported fetch path
// is parked as unsupported_source_type up front (no point probing it for an
// exact count); everything else starts imported_unvalidated.
function initialStatus(strategy: SupportedFetchStrategy): ValidationStatus {
  return strategy === "unsupported" ? "unsupported_source_type" : "imported_unvalidated";
}

function buildCandidate(args: {
  companyName: string;
  origin: SourceOrigin;
  originUrl: string | null;
  vendor: string | null;
  atsSlug: string | null;
  careersUrl: string | null;
  apiUrl: string | null;
  validationEnabled?: boolean;
  manuallyVerified?: boolean;
}): NormalizedSourceCandidate {
  const vendor = args.vendor ? args.vendor.trim().toLowerCase() : null;
  const strategy = fetchStrategyForVendor(vendor);
  const manuallyVerified = args.manuallyVerified ?? false;
  const origin = manuallyVerified ? "manual" : args.origin;
  return {
    company_name: args.companyName.trim(),
    source_origin: origin,
    source_origin_url: args.originUrl,
    source_name: vendor,
    ats_slug: args.atsSlug?.trim() || null,
    careers_url: args.careersUrl?.trim() || null,
    api_url: args.apiUrl?.trim() || null,
    source_type: vendor ? sourceTypeForVendor(vendor, strategy) : null,
    supported_fetch_strategy: strategy,
    validation_status: manuallyVerified ? "validated_fetchable" : initialStatus(strategy),
    confidence_score: baseConfidence(origin, strategy, Boolean(args.atsSlug)),
    fetch_enabled: false,
    validation_enabled: args.validationEnabled ?? true,
    manually_verified: manuallyVerified,
  };
}

// Normalise one OpenJobs record into 0..N candidates (one per ats_link). A
// company with multiple ATS links becomes multiple discovery rows.
export function normalizeOpenJobsRecord(
  record: OpenJobsRecord,
  originUrl?: string | null
): NormalizedSourceCandidate[] {
  const url = resolveOriginUrl("openjobs", originUrl);
  const out: NormalizedSourceCandidate[] = [];
  for (const link of record.ats_links) {
    const linkUrl = typeof link === "string" ? link : link.url ?? null;
    const typeHint =
      typeof link === "string" ? null : link.type ?? link.ats ?? null;
    const vendor = detectVendor(typeHint) ?? detectVendor(linkUrl);
    if (!vendor && !linkUrl) continue;
    out.push(
      buildCandidate({
        companyName: record.name,
        origin: "openjobs",
        originUrl: url,
        vendor,
        atsSlug: slugFromUrl(linkUrl),
        careersUrl: linkUrl,
        apiUrl: null,
      })
    );
  }
  return out;
}

// Normalise one jobhive record. jobhive carries an explicit ats_type/ats_id, so
// the mapping is exact: ats_type -> vendor, ats_id -> slug.
export function normalizeJobhiveRecord(
  record: JobhiveRecord,
  originUrl?: string | null
): NormalizedSourceCandidate | null {
  const url = resolveOriginUrl("ats_scrapers", originUrl);
  const vendor = detectVendor(record.ats_type) ?? detectVendor(record.url);
  const slug = record.ats_id?.trim() || slugFromUrl(record.url) || null;
  const careers = record.url ?? record.apply_url ?? null;
  if (!vendor && !careers) return null;
  return buildCandidate({
    companyName: record.company,
    origin: "ats_scrapers",
    originUrl: url,
    vendor,
    atsSlug: slug,
    careersUrl: careers,
    apiUrl: null,
  });
}

// Normalise a directly-authored candidate row (manual seed / fixture).
export function normalizeCandidateRow(record: CandidateRow): NormalizedSourceCandidate {
  const origin = normalizeSourceOrigin(record.source_origin);
  const vendor =
    detectVendor(record.source_name) ??
    detectVendor(record.api_url) ??
    detectVendor(record.careers_url);
  return buildCandidate({
    companyName: record.company_name,
    origin,
    originUrl: resolveOriginUrl(origin, record.source_origin_url),
    vendor: vendor ?? record.source_name?.trim().toLowerCase() ?? null,
    atsSlug: record.ats_slug ?? slugFromUrl(record.api_url) ?? slugFromUrl(record.careers_url),
    careersUrl: record.careers_url ?? null,
    apiUrl: record.api_url ?? null,
    validationEnabled: record.validation_enabled ?? true,
    manuallyVerified: record.manually_verified ?? false,
  });
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

// The dedup key mirrors the SQL unique index: company + vendor + slug + api_url.
// Detecting a collision lets the importer mark the later row duplicate_source
// rather than inserting a clashing row.
export function candidateDedupKey(c: {
  company_name: string;
  source_name: string | null;
  ats_slug: string | null;
  api_url: string | null;
}): string {
  return [
    c.company_name.trim().toLowerCase(),
    (c.source_name ?? "").toLowerCase(),
    (c.ats_slug ?? "").toLowerCase(),
    (c.api_url ?? "").toLowerCase(),
  ].join("::");
}

// Dedupe a normalised batch in-process: the first occurrence of a key wins; any
// later duplicate is flagged validation_status='duplicate_source' so it is kept
// for provenance but never promoted. Returns the de-duplicated list plus a count
// of how many were flagged.
export function dedupeCandidates(
  candidates: NormalizedSourceCandidate[]
): { unique: NormalizedSourceCandidate[]; duplicates: NormalizedSourceCandidate[] } {
  const seen = new Set<string>();
  const unique: NormalizedSourceCandidate[] = [];
  const duplicates: NormalizedSourceCandidate[] = [];
  for (const c of candidates) {
    const key = candidateDedupKey(c);
    if (seen.has(key)) {
      duplicates.push({ ...c, validation_status: "duplicate_source" });
      continue;
    }
    seen.add(key);
    unique.push(c);
  }
  return { unique, duplicates };
}

// ---------------------------------------------------------------------------
// File parsing: JSON / NDJSON / CSV
// ---------------------------------------------------------------------------

export type SourceFormat = "openjobs" | "jobhive" | "candidate";

// Parse a raw file body (already read from disk) into normalised candidates. The
// importer is offline-only by design — it never downloads from a live external
// URL — so the dataset is supplied as a local file in one of three encodings.
export function parseSourceFile(
  body: string,
  format: SourceFormat,
  opts: { originUrl?: string | null } = {}
): NormalizedSourceCandidate[] {
  const ext = sniffEncoding(body);
  const records = ext === "csv" ? parseCsv(body) : parseJsonOrNdjson(body);
  const out: NormalizedSourceCandidate[] = [];
  for (const raw of records) {
    if (format === "openjobs") {
      const parsed = openJobsRecordSchema.safeParse(raw);
      if (parsed.success) out.push(...normalizeOpenJobsRecord(parsed.data, opts.originUrl));
    } else if (format === "jobhive") {
      const parsed = jobhiveRecordSchema.safeParse(raw);
      if (parsed.success) {
        const c = normalizeJobhiveRecord(parsed.data, opts.originUrl);
        if (c) out.push(c);
      }
    } else {
      const parsed = candidateRowSchema.safeParse(raw);
      if (parsed.success) out.push(normalizeCandidateRow(parsed.data));
    }
  }
  return out;
}

function sniffEncoding(body: string): "json" | "csv" {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return "json";
  // NDJSON lines also start with { — handled by parseJsonOrNdjson. A CSV header
  // row has no leading brace and contains a comma.
  return trimmed.includes(",") && !trimmed.startsWith("{") ? "csv" : "json";
}

// Accepts a JSON array, a wrapper object ({ companies | records | data: [...] }),
// or newline-delimited JSON (one object per line).
function parseJsonOrNdjson(body: string): unknown[] {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      for (const key of ["companies", "records", "data", "rows", "jobs"]) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[];
      }
      return [parsed];
    }
    return [];
  } catch {
    // NDJSON: parse each non-empty line independently.
    const out: unknown[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {
        // skip malformed line
      }
    }
    return out;
  }
}

// Minimal CSV reader (comma-delimited, double-quote escaping). Sufficient for
// the simple per-ATS company lists these datasets ship; not a full RFC-4180
// implementation. The first row is the header.
export function parseCsv(body: string): Record<string, string>[] {
  const rows = splitCsvRows(body);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (cells.length === 1 && cells[0].trim() === "") continue;
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key] = (cells[idx] ?? "").trim();
    });
    out.push(record);
  }
  return out;
}

function splitCsvRows(body: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Flush trailing field/row when the file doesn't end in a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
