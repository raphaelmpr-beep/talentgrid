#!/usr/bin/env tsx
// Company universe import CLI.
//
// Reads a JSON payload of companies (from a file path argument or stdin) and
// upserts them into Supabase via the service-role admin client. Idempotent:
// re-running the same payload merges metadata and never destroys existing
// enrichment data. See lib/feeds/import-companies.ts for the upsert logic.
//
// Usage:
//   npm run import:companies -- ./companies.json
//   cat companies.json | npm run import:companies
//   npm run import:companies -- ./companies.json --dry-run
//
// Accepted JSON shapes (see companyImportBatchSchema):
//   [ { "name": "Acme", ... }, ... ]
//   { "companies": [ { "name": "Acme", ... } ] }
//   { "name": "Acme", ... }            (single object)
//
// Env required for a real write (skipped automatically in --dry-run):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  importCompanies,
  parseCompanyBatch,
  type CompaniesClient,
} from "@/lib/feeds/import-companies";

function readInput(filePath: string | undefined): string {
  if (filePath) return readFileSync(filePath, "utf8");
  return readFileSync(0, "utf8"); // fd 0 = stdin
}

function makeAdminClient(): CompaniesClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as CompaniesClient;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filePath = args.find((a) => !a.startsWith("--"));

  let raw: unknown;
  try {
    raw = JSON.parse(readInput(filePath));
  } catch (err) {
    console.error(`Failed to read/parse JSON input: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  let companies;
  try {
    companies = parseCompanyBatch(raw);
  } catch (err) {
    console.error(`Invalid company payload: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const supabase = dryRun ? null : makeAdminClient();
  if (!dryRun && !supabase) {
    console.error(
      "Supabase not configured (need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY). " +
        "Re-run with --dry-run to preview without writing."
    );
    process.exit(1);
  }

  const report = await importCompanies(companies, supabase, { dryRun });

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
    for (const f of failures) console.error(`  - ${f.name} (${f.domain ?? "no domain"}): ${f.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
