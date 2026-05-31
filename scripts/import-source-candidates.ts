#!/usr/bin/env tsx
// ATS source-candidate import CLI.
//
// Reads a LOCAL open-source job-source dataset file (never a live download in
// production), normalises it into candidate ATS source mappings, dedupes, and
// upserts into public.company_job_sources_candidate with fetch_enabled=false.
// Every imported row is source-discovery only until the validation workflow
// promotes it (see scripts/validate-source-candidates.ts).
//
// Supported input formats (--format):
//   jobhive    stapply-ai/ats-scrapers rows  { company, ats_type, ats_id, url }
//   openjobs   outscal/OpenJobs records      { name, website, ats_links[] }
//   candidate  directly-authored rows        { company_name, source_name, ... }
// Each format accepts JSON array, { records|companies|data: [...] }, NDJSON, or CSV.
//
// Usage:
//   npm run import:source-candidates -- --dry-run                       # preview, no writes (default-safe)
//   npm run import:source-candidates -- --file=path.json --format=jobhive
//   npm run import:source-candidates                                    # real upsert (needs Supabase env)
//
// Env required for a real write (skipped automatically in --dry-run):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// SAFETY: this tool NEVER promotes a candidate (fetch_enabled stays false) and
// NEVER overwrites a manually_verified row. It only inserts/updates quarantine
// rows. Do not run against production without dataset-license clearance — see
// docs/ats-source-candidates.md.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  parseSourceFile,
  dedupeCandidates,
  type NormalizedSourceCandidate,
  type SourceFormat,
} from "@/lib/feeds/source-candidates";

const DEFAULT_FILE = "scripts/data/source-candidates/sample-candidates.json";

type Cli = {
  dryRun: boolean;
  file: string;
  format: SourceFormat;
  originUrl: string | null;
  only: string | null;
};

function parseCli(argv: string[]): Cli {
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=");
      flags.set(k, v ?? "true");
    }
  }
  const format = (flags.get("format") ?? "candidate") as SourceFormat;
  if (!["jobhive", "openjobs", "candidate"].includes(format)) {
    throw new Error(`--format must be one of jobhive|openjobs|candidate (got ${format})`);
  }
  return {
    dryRun: flags.get("dry-run") === "true",
    file: flags.get("file") ?? DEFAULT_FILE,
    format,
    originUrl: flags.get("origin-url") ?? null,
    only: flags.get("only") ?? null,
  };
}

type CandidateClient = {
  from: (table: string) => {
    upsert: (
      rows: Record<string, unknown>[],
      opts: { onConflict: string; ignoreDuplicates?: boolean }
    ) => Promise<{ error: { message: string } | null }>;
  };
};

function makeAdminClient(): CandidateClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as CandidateClient;
}

// Map a normalised candidate onto the table's column names.
function toRow(c: NormalizedSourceCandidate): Record<string, unknown> {
  return {
    company_name: c.company_name,
    source_origin: c.source_origin,
    source_origin_url: c.source_origin_url,
    source_name: c.source_name,
    ats_slug: c.ats_slug,
    careers_url: c.careers_url,
    api_url: c.api_url,
    source_type: c.source_type,
    supported_fetch_strategy: c.supported_fetch_strategy,
    validation_status: c.validation_status,
    confidence_score: c.confidence_score,
    fetch_enabled: false,
    validation_enabled: c.validation_enabled,
    manually_verified: c.manually_verified,
  };
}

function summarize(candidates: NormalizedSourceCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) {
    out[c.validation_status] = (out[c.validation_status] ?? 0) + 1;
  }
  return out;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const resolved = path.resolve(process.cwd(), cli.file);

  let body: string;
  try {
    body = readFileSync(resolved, "utf8");
  } catch (err) {
    console.error(`Failed to read ${resolved}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  let normalized = parseSourceFile(body, cli.format, { originUrl: cli.originUrl });
  if (cli.only) {
    const needle = cli.only.toLowerCase();
    normalized = normalized.filter((c) => c.company_name.toLowerCase().includes(needle));
  }

  const { unique, duplicates } = dedupeCandidates(normalized);

  console.log(
    `Source-candidate import: file=${cli.file} format=${cli.format} ` +
      `parsed=${normalized.length} unique=${unique.length} duplicates=${duplicates.length} ` +
      `dryRun=${cli.dryRun}`
  );
  console.log("Status breakdown:", JSON.stringify(summarize(unique), null, 2));

  if (cli.dryRun) {
    console.log(`\nDry-run: no writes. Sample (first 5):`);
    for (const c of unique.slice(0, 5)) {
      console.log(
        `  ${c.company_name} -> ${c.source_name ?? "?"}/${c.ats_slug ?? "?"} ` +
          `[${c.supported_fetch_strategy}] ${c.validation_status} conf=${c.confidence_score}`
      );
    }
    if (duplicates.length > 0) {
      console.log(`\n${duplicates.length} duplicate(s) flagged duplicate_source (not inserted).`);
    }
    return;
  }

  const supabase = makeAdminClient();
  if (!supabase) {
    console.error(
      "Supabase not configured (need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY). " +
        "Re-run with --dry-run to preview without writing."
    );
    process.exit(1);
  }

  // ignoreDuplicates so a re-import of an unchanged dataset never overwrites a
  // row that validation may have since promoted. Updating an existing candidate
  // is the validation workflow's job, not the importer's.
  const rows = unique.map(toRow);
  const { error } = await supabase
    .from("company_job_sources_candidate")
    .upsert(rows, {
      onConflict:
        "lower(company_name), coalesce(lower(source_name), ''), coalesce(lower(ats_slug), ''), coalesce(lower(api_url), '')",
      ignoreDuplicates: true,
    });
  if (error) {
    console.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nImported ${rows.length} candidate(s) (fetch_enabled=false).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
