#!/usr/bin/env tsx
// Smoke test for the mid-market ($100M–$600M) candidate seed layer. Fully offline
// (no network, no Supabase) so it can gate CI / run ad hoc:
//
//   npm run smoke:midmarket
//   tsx scripts/midmarket-candidates-smoke.ts
//
// It protects two guarantees:
//
//  1. SEED MAPPING — every candidate maps to a CompanyImportInput that is
//     validation-pending and never carries a fabricated count: revenue lives as
//     USD bounds (revenue_min/max), revenue_band is the 100m_600m bucket so the
//     /api/companies 100M–600M filter matches, fetch_enabled stays false,
//     is_hiring stays false, and no source_openings_total/exact leaks in.
//
//  2. UNCAPPED VALIDATION — a known ATS-backed midmarket company (Fastly, modelled
//     here on a Greenhouse board) reports its FULL inventory total even though the
//     stored title/URL sample is bounded. active_openings_count must be the full
//     vendor total, count_exact must be true. This is the "no cap on counts"
//     invariant for the candidate layer.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  joinMidmarketSeed,
  parseMidmarketCompanies,
  parseMidmarketJobSources,
  revenueBoundsUsd,
  type MidmarketCompanySeed,
} from "@/lib/feeds/midmarket-seed";
import { validateCompany, type Cli, type SeedCompany } from "@/scripts/validate-open-roles";
import type { FetchLike } from "@/lib/feeds/providers/careers-portal";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

const COMPANIES_PATH = "scripts/data/midmarket/midmarket-company-seed.json";
const SOURCES_PATH = "scripts/data/midmarket/midmarket-job-sources-seed.json";

const SAMPLE_SIZE = 5;
const CLI: Cli = {
  inputPath: "",
  outputPath: "",
  limit: null,
  only: null,
  concurrency: 4,
  timeoutMs: 5000,
  sampleJobs: SAMPLE_SIZE,
  failOnDrift: false,
};

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), p), "utf8"));
}

async function main(): Promise<void> {
  const companies = parseMidmarketCompanies(readJson(COMPANIES_PATH));
  const jobSources = parseMidmarketJobSources(readJson(SOURCES_PATH));

  console.log("midmarket: seed files parse and join cleanly");
  {
    assert(companies.length === 121, `121 candidate companies (got ${companies.length})`);
    assert(jobSources.length === 121, `121 job sources (got ${jobSources.length})`);
    const { importInputs, validationCompanies } = joinMidmarketSeed(companies, jobSources);
    assert(importInputs.length === companies.length, "every company maps to an import input");
    assert(
      validationCompanies.length === companies.length,
      "every company maps to a validation-seed record"
    );
  }

  console.log("midmarket: import inputs are validation-pending with no fabricated counts");
  {
    const { importInputs } = joinMidmarketSeed(companies, jobSources);
    const allBucket = importInputs.every((c) => c.revenue_band === "100m_600m");
    assert(allBucket, "all map to revenue_band=100m_600m so the 100M–600M filter matches");
    const allCandidate = importInputs.every((c) => c.metadata.candidate_seed === true);
    assert(allCandidate, "all carry metadata.candidate_seed=true");
    const noFetch = importInputs.every((c) => c.metadata.fetch_enabled === false);
    assert(noFetch, "all carry metadata.fetch_enabled=false");
    const notHiring = importInputs.every((c) => c.is_hiring === false);
    assert(notHiring, "none assert is_hiring=true (no fake active state)");
    const noLeakedCount = importInputs.every(
      (c) =>
        c.metadata.source_openings_total === undefined &&
        c.metadata.source_openings_exact === undefined &&
        c.metadata.open_roles_count === undefined
    );
    assert(noLeakedCount, "no record carries a source_openings_total/exact or open_roles_count");
    const validStatus = importInputs.every(
      (c) =>
        typeof c.source_status === "string" &&
        (c.source_status.includes("needs_live_http_validation") ||
          c.source_status.includes("needs_source_mapping"))
    );
    assert(validStatus, "source_status is needs_live_http_validation | needs_source_mapping");
  }

  console.log("midmarket: revenue bounds convert MUSD → USD inside the 100M–600M window");
  {
    const fastly = companies.find((c) => c.name === "Fastly") as MidmarketCompanySeed;
    const { min, max } = revenueBoundsUsd(fastly);
    assert(min === 400_000_000, `Fastly revenue_min is 400M USD (got ${min})`);
    assert(max === 600_000_000, `Fastly revenue_max is 600M USD (got ${max})`);
    // The window must fall inside the 100M–600M band the filter ranges over.
    const inBand = importInputsInBand(companies, jobSources);
    assert(inBand, "every candidate's USD bounds (when present) sit within [100M, 600M]");
  }

  console.log("midmarket: an ATS-backed candidate (Fastly) reports an UNCAPPED exact total");
  {
    const TOTAL = 142; // Fastly's live board total in this fixture; arbitrary >sample.
    const ghJobs = Array.from({ length: 50 }, (_, i) => ({
      id: 7000 + i,
      title: `Fastly Engineer ${i}`,
      absolute_url: `https://boards.greenhouse.io/fastly/jobs/${7000 + i}`,
      location: { name: "Remote, US" },
    }));
    const jobsBody = JSON.stringify({ jobs: ghJobs, meta: { total: TOTAL } });
    const stubFetch: FetchLike = async (url) => {
      const u = String(url);
      if (u === "https://boards-api.greenhouse.io/v1/boards/fastly") {
        return new Response(JSON.stringify({ name: "Fastly" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u === "https://boards-api.greenhouse.io/v1/boards/fastly/jobs") {
        return new Response(jobsBody, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    // Model Fastly as resolved to a Greenhouse board (the state the validation
    // workflow would promote it to once source mapping succeeds).
    const company: SeedCompany = {
      company_name: "Fastly",
      careers_url: "https://www.fastly.com/about/careers",
      job_portal_url: null,
      source_name: "greenhouse",
      ats_slug: "fastly",
    };
    const result = await validateCompany(company, CLI, stubFetch);
    const v = result.open_roles_validation;

    assert(v.active_openings_count === TOTAL, `count is the full ${TOTAL} (got ${v.active_openings_count})`);
    assert(v.count_exact === true, `count_exact is true (got ${v.count_exact})`);
    assert(
      v.count_status === "counted_from_public_api_exact",
      `count_status is counted_from_public_api_exact (got ${v.count_status})`
    );
    assert(
      v.sample_job_titles.length === SAMPLE_SIZE,
      `sample bounded at ${SAMPLE_SIZE} (got ${v.sample_job_titles.length})`
    );
    assert(
      (v.active_openings_count ?? 0) > v.sample_job_titles.length,
      "count is NOT capped to the sample size (uncapped invariant)"
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll midmarket smoke assertions passed.");
}

// Every candidate that carries USD revenue bounds must sit inside the 100M–600M
// window the filter ranges over (the band the whole layer claims to be).
function importInputsInBand(
  companies: MidmarketCompanySeed[],
  jobSources: Parameters<typeof joinMidmarketSeed>[1]
): boolean {
  const { importInputs } = joinMidmarketSeed(companies, jobSources);
  return importInputs.every((c) => {
    const min = c.metadata.revenue_min;
    const max = c.metadata.revenue_max;
    if (typeof min !== "number" || typeof max !== "number") return true;
    return min >= 100_000_000 && max <= 600_000_000;
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
