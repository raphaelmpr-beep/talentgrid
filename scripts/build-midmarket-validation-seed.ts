#!/usr/bin/env tsx
// Build the open-roles validation seed for the mid-market candidate layer.
//
// Joins the candidate company seed to the job-sources seed and emits a dataset in
// the exact shape scripts/validate-open-roles.ts consumes (a { companies: [...] }
// object whose entries carry company_name / careers_url / job_portal_url /
// source_name / api_url / ats_slug). The validator then resolves each company's
// source (careers page -> ATS/API), counts active jobs UNCAPPED, and reports
// exactness + drift.
//
// This is a pure file transform — no network, no Supabase.
//
// Usage:
//   npm run build:midmarket-validation-seed
//   npm run build:midmarket-validation-seed -- <out.json>

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  joinMidmarketSeed,
  parseMidmarketCompanies,
  parseMidmarketJobSources,
} from "@/lib/feeds/midmarket-seed";

const DEFAULT_COMPANIES = "scripts/data/midmarket/midmarket-company-seed.json";
const DEFAULT_SOURCES = "scripts/data/midmarket/midmarket-job-sources-seed.json";
const DEFAULT_OUTPUT = "scripts/data/midmarket/midmarket-open-roles-validation-seed.json";

async function readJson(filePath: string): Promise<unknown> {
  const resolved = path.resolve(process.cwd(), filePath);
  return JSON.parse(await readFile(resolved, "utf8"));
}

async function main(): Promise<void> {
  const outArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const outputPath = path.resolve(process.cwd(), outArg ?? DEFAULT_OUTPUT);

  const companies = parseMidmarketCompanies(await readJson(DEFAULT_COMPANIES));
  const jobSources = parseMidmarketJobSources(await readJson(DEFAULT_SOURCES));
  const { validationCompanies } = joinMidmarketSeed(companies, jobSources);

  const dataset = {
    dataset_name: "TalentGrid mid-market ($100M–$600M) open roles validation",
    seed_layer: "midmarket_100m_600m",
    candidate_seed: true,
    generated_at: new Date().toISOString(),
    company_count: validationCompanies.length,
    important_warning:
      "Candidate layer. active_openings_count is null until live-validated; null means NOT YET VALIDATED, never zero. Counts are uncapped.",
    open_roles_count_semantics:
      "Per-company source totals are uncapped. Only sample_job_titles/job_listing_urls are bounded for report size.",
    recommended_pipeline:
      "company -> careers page -> ATS/source mapping -> active jobs -> count exactness -> drift report. Promote source_openings_total/source_openings_exact only after an exact source resolves.",
    companies: validationCompanies,
  };

  await writeFile(outputPath, JSON.stringify(dataset, null, 2));
  console.log(
    `Wrote ${validationCompanies.length} candidate companies → ${path.relative(process.cwd(), outputPath)}`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
