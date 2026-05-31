#!/usr/bin/env tsx
// Mid-market ($100M–$600M) candidate company import CLI.
//
// Reads the candidate seed layer (company seed + job-sources seed), joins them by
// company name, maps each record into the importer's CompanyImportInput, and
// upserts via lib/feeds/import-companies.ts. Idempotent: re-running merges
// metadata and never destroys enrichment data.
//
// These are CANDIDATE companies, not audited data: every record is stored with
//   metadata.candidate_seed = true
//   metadata.seed_layer     = "midmarket_100m_600m"
//   metadata.fetch_enabled  = false
//   source_status           = needs_live_http_validation | needs_source_mapping
// and is NEVER assigned an active role count. source_openings_total/exact are
// promotable only by the validation workflow after a source resolves.
//
// Usage:
//   npm run import:midmarket -- --dry-run            # preview, no writes (default-safe)
//   npm run import:midmarket                         # real upsert (needs Supabase env)
//   npm run import:midmarket -- --only=Fastly        # single company (substring, case-insensitive)
//   npm run import:midmarket -- \
//     --companies=scripts/data/midmarket/midmarket-company-seed.json \
//     --sources=scripts/data/midmarket/midmarket-job-sources-seed.json
//
// Env required for a real write (skipped automatically in --dry-run):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { importCompanies, type CompaniesClient } from "@/lib/feeds/import-companies";
import {
  joinMidmarketSeed,
  parseMidmarketCompanies,
  parseMidmarketJobSources,
} from "@/lib/feeds/midmarket-seed";

const DEFAULT_COMPANIES = "scripts/data/midmarket/midmarket-company-seed.json";
const DEFAULT_SOURCES = "scripts/data/midmarket/midmarket-job-sources-seed.json";

type Cli = {
  dryRun: boolean;
  only: string | null;
  companiesPath: string;
  sourcesPath: string;
};

function parseCli(argv: string[]): Cli {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags.set(k, v ?? "true");
    }
  }
  return {
    dryRun: flags.get("dry-run") === "true",
    only: flags.get("only") ?? null,
    companiesPath: flags.get("companies") ?? DEFAULT_COMPANIES,
    sourcesPath: flags.get("sources") ?? DEFAULT_SOURCES,
  };
}

function makeAdminClient(): CompaniesClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as CompaniesClient;
}

function readJson(filePath: string): unknown {
  const resolved = path.resolve(process.cwd(), filePath);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));

  let companies, jobSources;
  try {
    companies = parseMidmarketCompanies(readJson(cli.companiesPath));
    jobSources = parseMidmarketJobSources(readJson(cli.sourcesPath));
  } catch (err) {
    console.error(`Failed to read/parse seed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  let { importInputs } = joinMidmarketSeed(companies, jobSources);
  if (cli.only) {
    const needle = cli.only.toLowerCase();
    importInputs = importInputs.filter((c) => c.name.toLowerCase().includes(needle));
  }

  console.log(
    `Mid-market candidate import: ${importInputs.length} company/companies ` +
      `(seed=${companies.length}, sources=${jobSources.length}, dryRun=${cli.dryRun})`
  );

  const supabase = cli.dryRun ? null : makeAdminClient();
  if (!cli.dryRun && !supabase) {
    console.error(
      "Supabase not configured (need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY). " +
        "Re-run with --dry-run to preview without writing."
    );
    process.exit(1);
  }

  const report = await importCompanies(importInputs, supabase, { dryRun: cli.dryRun });

  console.log(
    JSON.stringify(
      {
        dryRun: report.dryRun,
        total: report.total,
        inserted: report.inserted,
        updated: report.updated,
        skipped: report.skipped,
        errors: report.errors,
      },
      null,
      2
    )
  );

  const failures = report.results.filter((r) => r.outcome === "error");
  if (failures.length > 0) {
    console.error(`\n${failures.length} record(s) failed:`);
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
