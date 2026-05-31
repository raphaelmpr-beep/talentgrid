#!/usr/bin/env tsx
// Open-roles validation workflow.
//
// Why this exists
// ---------------
// Company cards in TalentGrid show an "open roles" count. For large employers
// those counts drift: the public careers site shows N roles, but TalentGrid has
// a stale or duplicated figure (Pinterest is the canonical case — the live
// Greenhouse board reports 176, while TalentGrid had carried 178). This script
// re-derives the *current* live inventory for every company in a seed dataset by
// hitting the same exact public ATS/board sources the app's refresh flow uses,
// then (optionally) diffs that against the live TalentGrid API so drift is
// caught before it reaches a card.
//
// It deliberately reuses lib/feeds/providers/careers-portal.ts rather than
// re-implementing ATS adapters: that provider already resolves Greenhouse,
// Lever, Workday CXS, and the Amazon/Microsoft/Apple named-employer APIs, and
// already reports an *exact, uncapped* `totalCount` (e.g. Greenhouse meta.total)
// distinct from the bounded `jobs` sample. Counts are never capped here — the
// stored title/URL sample is bounded for output size, but `active_openings_count`
// is always the provider's full inventory total.
//
// Usage
// -----
//   npm run validate:open-roles                 # all companies, default IO paths
//   npm run validate:open-roles -- <seed.json> <report.json>
//   npm run validate:open-roles:sample          # first SAMPLE_SIZE companies only
//
//   # CLI flags (after `--`):
//   --limit=N          validate only the first N companies (sample mode)
//   --only=Name        validate only companies whose name matches (case-insensitive substring)
//   --concurrency=N    parallel workers (default 4, env CONCURRENCY)
//   --timeout=N        per-request timeout ms (default 12000, env TIMEOUT_MS)
//   --sample-jobs=N    max sample titles/URLs to record per company (default 5)
//   --fail-on-drift    exit non-zero when a live TalentGrid count drifts from an
//                      exact source total (env FAIL_ON_DRIFT=1). Requires
//                      TALENTGRID_BASE_URL so a comparison can be made.
//
//   # Optional drift comparison against a live TalentGrid deployment:
//   TALENTGRID_BASE_URL=https://talentgrid-ebcb5665.vercel.app npm run validate:open-roles -- --limit=10
//
// The output report is JSON and never written into the app DB directly — see
// docs/open-roles-validation.md for how to use it to update source metadata
// safely.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fetchCareersPortalJobs,
  type FetchLike,
} from "@/lib/feeds/providers/careers-portal";
import { normalizeCompanyKey } from "@/lib/companies/search-scope";

// ---------------------------------------------------------------------------
// Seed + report types
// ---------------------------------------------------------------------------

type SeedCompany = {
  company_name: string;
  revenue_band?: string | null;
  industry?: string | null;
  careers_url?: string | null;
  job_portal_url?: string | null;
  source_name?: string | null;
  source_type?: string | null;
  api_url?: string | null;
  ats_slug?: string | null;
  // Other seed fields are passed through untouched.
  [key: string]: unknown;
};

type SeedDataset = {
  dataset_name?: string;
  generated_at?: string;
  company_count?: number;
  companies: SeedCompany[];
  [key: string]: unknown;
};

// The discrete states a single company validation can land in. These are stable
// strings — downstream tooling and the runbook key off them.
type CountStatus =
  | "counted_from_public_api_exact" // exact live total from a public ATS/board JSON API
  | "scraped_sample_not_exact" // HTML/JSON scrape recovered a lower-bound sample
  | "portal_accessible_but_roles_not_counted" // careers page reachable, no countable source
  | "captcha_or_bot_challenge" // blocked by a human-verification wall
  | "no_source_url" // nothing to fetch
  | "validation_failed"; // network/parse error

type CountMatchStatus = "match" | "drift" | "talentgrid_missing" | "not_compared";

// The `source` strings the careers-portal provider reports. null = no source
// resolved (no count).
type ValidationMethod =
  | "greenhouse"
  | "lever"
  | "workday"
  | "amazon"
  | "microsoft"
  | "apple"
  | "html"
  | "json"
  | null;

type OpenRolesValidation = {
  live_checked: boolean;
  checked_at: string;
  // Full, uncapped live inventory. null = not counted (never interpret as zero).
  active_openings_count: number | null;
  // True only when active_openings_count is a vendor-reported exact total.
  count_exact: boolean;
  count_status: CountStatus;
  // How the count was obtained, or null when no source resolved.
  validation_method: ValidationMethod;
  // The board/API URL hit (exact sources) or the careers/portal URL scraped.
  source_url: string | null;
  api_url: string | null;
  // Bounded sample for spot-checking — NOT the count.
  sample_job_titles: string[];
  job_listing_urls: string[];
  http_status: number | null;
  error: string | null;
  // Drift fields, populated only when TALENTGRID_BASE_URL is set.
  talentgrid_openings_count: number | null;
  count_delta: number | null;
  count_match_status: CountMatchStatus;
};

type ValidatedCompany = SeedCompany & {
  open_roles_validation: OpenRolesValidation;
};

// ---------------------------------------------------------------------------
// CLI / env config
// ---------------------------------------------------------------------------

type Cli = {
  inputPath: string;
  outputPath: string;
  limit: number | null;
  only: string | null;
  concurrency: number;
  timeoutMs: number;
  sampleJobs: number;
  // When set, exit non-zero if any company's live TalentGrid count drifts from
  // the freshly-derived exact source total. Lets CI gate on count drift.
  failOnDrift: boolean;
};

const DEFAULT_INPUT = "scripts/data/open-roles-validation-seed.json";
const DEFAULT_OUTPUT = "scripts/data/open-roles-validation-report.json";

function parseCli(argv: string[]): Cli {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags.set(k, v ?? "true");
    } else {
      positional.push(arg);
    }
  }

  const num = (flag: string, env: string | undefined, fallback: number): number => {
    const raw = flags.get(flag) ?? env;
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };

  const limitRaw = flags.get("limit");
  const limit = limitRaw != null && Number.isFinite(Number(limitRaw)) ? Math.max(1, Math.floor(Number(limitRaw))) : null;

  return {
    inputPath: positional[0] ?? DEFAULT_INPUT,
    outputPath: positional[1] ?? DEFAULT_OUTPUT,
    limit,
    only: flags.get("only") ?? null,
    concurrency: num("concurrency", process.env.CONCURRENCY, 4),
    timeoutMs: num("timeout", process.env.TIMEOUT_MS, 12000),
    sampleJobs: num("sample-jobs", process.env.SAMPLE_JOBS, 5),
    failOnDrift: flags.get("fail-on-drift") === "true" || process.env.FAIL_ON_DRIFT === "1",
  };
}

// ---------------------------------------------------------------------------
// Per-company validation
// ---------------------------------------------------------------------------

// Map the provider's non-fatal `reason` to a stable count_status.
function statusFromReason(reason: string | undefined): CountStatus {
  switch (reason) {
    case "captcha_or_bot_challenge":
      return "captcha_or_bot_challenge";
    case "no_careers_url":
    case "invalid_url":
      return "no_source_url";
    case "js_only_portal":
    case "no_jobs_extracted":
      return "portal_accessible_but_roles_not_counted";
    case "timeout":
    case "fetch_failed":
      return "validation_failed";
    default:
      // http_4xx / http_5xx and anything unknown: reachable attempt, no count.
      if (reason && reason.startsWith("http_")) {
        return "portal_accessible_but_roles_not_counted";
      }
      return "validation_failed";
  }
}

function httpStatusFromReason(reason: string | undefined): number | null {
  if (reason && reason.startsWith("http_")) {
    const code = Number(reason.slice("http_".length));
    return Number.isFinite(code) ? code : null;
  }
  return null;
}

export async function validateCompany(
  company: SeedCompany,
  cli: Cli,
  // Optional fetch override so the offline smoke test can exercise this path
  // without any network access. Defaults to the global fetch in production.
  fetchImpl?: FetchLike
): Promise<ValidatedCompany> {
  const checkedAt = new Date().toISOString();
  const base: OpenRolesValidation = {
    live_checked: true,
    checked_at: checkedAt,
    active_openings_count: null,
    count_exact: false,
    count_status: "validation_failed",
    validation_method: null,
    source_url: null,
    api_url: null,
    sample_job_titles: [],
    job_listing_urls: [],
    http_status: null,
    error: null,
    talentgrid_openings_count: null,
    count_delta: null,
    count_match_status: "not_compared",
  };

  try {
    const result = await fetchCareersPortalJobs(
      {
        companyName: company.company_name,
        careersUrl: company.careers_url ?? null,
        jobPortalUrl: company.job_portal_url ?? null,
        // ats_type isn't a distinct seed field; the provider also sniffs URLs and
        // guesses Greenhouse slugs from the name, so passing the slug as a hint is
        // safe and lets a manual-source company still resolve an exact board.
        atsType: company.source_name ?? null,
        atsSlug: company.ats_slug ?? null,
        // Bound only the stored sample, never the count.
        maxJobs: cli.sampleJobs,
      },
      { timeoutMs: cli.timeoutMs, ...(fetchImpl ? { fetch: fetchImpl } : {}) }
    );

    base.validation_method = (result.source as ValidationMethod) ?? null;
    base.sample_job_titles = result.jobs.slice(0, cli.sampleJobs).map((j) => j.title);
    base.job_listing_urls = result.jobs
      .slice(0, cli.sampleJobs)
      .map((j) => j.url)
      .filter((u): u is string => typeof u === "string");

    if (result.totalCount > 0) {
      // Uncapped: this is the provider's full inventory total, not jobs.length.
      base.active_openings_count = result.totalCount;
      base.count_exact = result.countExact === true;
      base.count_status = base.count_exact ? "counted_from_public_api_exact" : "scraped_sample_not_exact";
      base.source_url = result.fetchedUrl;
      // Exact counts come from a board/named-employer API; record it as api_url.
      base.api_url = base.count_exact ? result.fetchedUrl : null;
      return { ...company, open_roles_validation: base };
    }

    // No count: translate the provider reason into a stable status.
    base.count_status = statusFromReason(result.reason);
    base.http_status = httpStatusFromReason(result.reason);
    base.source_url = result.fetchedUrl ?? company.careers_url ?? company.job_portal_url ?? null;
    base.error = result.reason ?? "no_jobs_extracted";
    if (base.count_status === "no_source_url") base.error = "No careers_url or job_portal_url present.";
    return { ...company, open_roles_validation: base };
  } catch (err) {
    base.count_status = "validation_failed";
    base.error = err instanceof Error ? err.message : String(err);
    return { ...company, open_roles_validation: base };
  }
}

// ---------------------------------------------------------------------------
// Optional drift comparison against a live TalentGrid deployment
// ---------------------------------------------------------------------------

// Query the live TalentGrid companies API for a company's current openings count.
// Best-effort and non-fatal: any failure leaves the drift fields at their
// not-compared defaults. Returns null when the company isn't found or the count
// is unavailable.
async function fetchTalentGridCount(
  baseUrl: string,
  companyName: string,
  timeoutMs: number
): Promise<number | null> {
  const url = new URL("/api/companies", baseUrl);
  url.searchParams.set("q", companyName);
  url.searchParams.set("pageSize", "5");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const rows = extractCompanyRows(json);
    const target = normalizeCompanyKey(companyName);
    // Exact name match first, then fall back to the first row.
    const match =
      rows.find((r) => normalizeCompanyKey(r.name) === target) ?? rows[0] ?? null;
    return match ? match.count : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type ApiCompanyRow = { name: string; count: number };

// The /api/companies response shape isn't imported here (this script stays
// decoupled from app route types); pull name + openings count defensively from
// the common shapes: { data: [...] } | { companies: [...] } | [...].
function extractCompanyRows(json: unknown): ApiCompanyRow[] {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? ((json as Record<string, unknown>).data ?? (json as Record<string, unknown>).companies)
      : null;
  if (!Array.isArray(list)) return [];
  const out: ApiCompanyRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : typeof row.company_name === "string" ? row.company_name : null;
    if (!name) continue;
    const count = pickCount(row);
    if (count == null) continue;
    out.push({ name, count });
  }
  return out;
}

function pickCount(row: Record<string, unknown>): number | null {
  for (const key of ["open_roles", "openings_count", "open_roles_count", "active_openings_count", "openings"]) {
    const v = row[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function applyDrift(v: OpenRolesValidation, talentgridCount: number | null): void {
  v.talentgrid_openings_count = talentgridCount;
  if (talentgridCount == null) {
    v.count_match_status = "talentgrid_missing";
    return;
  }
  if (v.active_openings_count == null) {
    // Couldn't derive a live count this run, so drift is undefined.
    v.count_match_status = "not_compared";
    return;
  }
  v.count_delta = talentgridCount - v.active_openings_count;
  v.count_match_status = v.count_delta === 0 ? "match" : "drift";
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------

async function runPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number,
  onDone?: (index: number, total: number, result: R) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const total = items.length;
  const runNext = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor++;
      const result = await worker(items[index], index);
      results[index] = result;
      onDone?.(index, total, result);
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(concurrency, 1), total || 1) }, runNext);
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function selectCompanies(all: SeedCompany[], cli: Cli): SeedCompany[] {
  let selected = all;
  if (cli.only) {
    // --only accepts a comma-separated list so a multi-company sample (e.g.
    // "Fastly,HashiCorp,Sprout Social") can be validated in one run. A company
    // matches when its name contains any of the listed substrings.
    const needles = cli.only
      .split(",")
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean);
    if (needles.length > 0) {
      selected = selected.filter((c) =>
        needles.some((needle) => c.company_name.toLowerCase().includes(needle))
      );
    }
  }
  if (cli.limit != null) selected = selected.slice(0, cli.limit);
  return selected;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), cli.inputPath);
  const outputPath = path.resolve(process.cwd(), cli.outputPath);

  const dataset = JSON.parse(await readFile(inputPath, "utf8")) as SeedDataset;
  if (!Array.isArray(dataset.companies)) {
    throw new Error(`Seed at ${inputPath} has no "companies" array.`);
  }

  const companies = selectCompanies(dataset.companies, cli);
  const talentgridBaseUrl = process.env.TALENTGRID_BASE_URL?.trim() || null;

  console.log(
    `Validating ${companies.length}/${dataset.companies.length} companies ` +
      `(concurrency=${cli.concurrency}, timeout=${cli.timeoutMs}ms` +
      `${talentgridBaseUrl ? `, drift vs ${talentgridBaseUrl}` : ""})`
  );

  const validated = await runPool(
    companies,
    async (company) => {
      // The live validation and the TalentGrid drift lookup are independent, so
      // overlap them rather than fetching one after the other.
      const [result, tgCount] = await Promise.all([
        validateCompany(company, cli),
        talentgridBaseUrl
          ? fetchTalentGridCount(talentgridBaseUrl, company.company_name, cli.timeoutMs)
          : Promise.resolve(null),
      ]);
      if (talentgridBaseUrl) applyDrift(result.open_roles_validation, tgCount);
      return result;
    },
    cli.concurrency,
    (index, total, result) => {
      const v = result.open_roles_validation;
      const count = v.active_openings_count;
      const exact = v.count_exact ? " exact" : "";
      console.log(
        `[${index + 1}/${total}] ${companies[index].company_name}: ` +
          `${count == null ? v.count_status : `${count}${exact}`}`
      );
    }
  );

  const summary = summarize(validated);
  const output = {
    ...dataset,
    dataset_name: dataset.dataset_name ?? "TalentGrid open roles validation",
    generated_at: new Date().toISOString(),
    validated_count: validated.length,
    seed_company_count: dataset.companies.length,
    talentgrid_base_url: talentgridBaseUrl,
    validation_summary: summary,
    companies: validated,
  };

  await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log("\nValidation complete →", outputPath);
  console.log(JSON.stringify(summary, null, 2));

  // Drift report: list every company whose live TalentGrid count differs from
  // the freshly-derived source count, so the drift is visible (and CI-gateable
  // via --fail-on-drift) before it reaches a card.
  const drifted = collectDrift(validated);
  if (drifted.length > 0) {
    console.error(`\nDrift detected for ${drifted.length} company/companies:`);
    for (const d of drifted) {
      const exact = d.count_exact ? " (exact source)" : " (non-exact source)";
      console.error(
        `  ${d.company_name}: TalentGrid=${d.talentgrid_openings_count} ` +
          `source=${d.active_openings_count}${exact} delta=${d.count_delta}`
      );
    }
    if (cli.failOnDrift) {
      // Drift against an *exact* source is authoritative and must fail CI. Drift
      // against a non-exact (sample) source is a lower-bound mismatch only, so it
      // is reported but does not fail the run.
      const exactDrift = drifted.filter((d) => d.count_exact);
      if (exactDrift.length > 0) {
        console.error(
          `\n--fail-on-drift: ${exactDrift.length} company/companies drift from an ` +
            `exact source total. Failing.`
        );
        process.exit(2);
      }
      console.error("\n--fail-on-drift: drift is only against non-exact sources; not failing.");
    }
  }
}

type DriftRow = {
  company_name: string;
  talentgrid_openings_count: number | null;
  active_openings_count: number | null;
  count_delta: number | null;
  count_exact: boolean;
};

function collectDrift(validated: ValidatedCompany[]): DriftRow[] {
  const out: DriftRow[] = [];
  for (const c of validated) {
    const v = c.open_roles_validation;
    if (v.count_match_status !== "drift") continue;
    out.push({
      company_name: c.company_name,
      talentgrid_openings_count: v.talentgrid_openings_count,
      active_openings_count: v.active_openings_count,
      count_delta: v.count_delta,
      count_exact: v.count_exact,
    });
  }
  return out;
}

type ValidationSummary = {
  by_status: Record<string, number>;
  exact_counts: number;
  drift_detected: number;
};

function summarize(validated: ValidatedCompany[]): ValidationSummary {
  const byStatus: Record<string, number> = {};
  let exact = 0;
  let drift = 0;
  for (const c of validated) {
    const v = c.open_roles_validation;
    byStatus[v.count_status] = (byStatus[v.count_status] ?? 0) + 1;
    if (v.count_exact) exact += 1;
    if (v.count_match_status === "drift") drift += 1;
  }
  return { by_status: byStatus, exact_counts: exact, drift_detected: drift };
}

// Only run main when executed directly (not when imported by the smoke test).
const invokedDirectly = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

export type { Cli, SeedCompany, ValidatedCompany, OpenRolesValidation, CountStatus };
export { parseCli, summarize, applyDrift, statusFromReason };
