#!/usr/bin/env tsx
// ATS source-candidate validation CLI.
//
// Probes each candidate ATS source mapping against its LIVE endpoint using the
// same provider the refresh flow uses (lib/feeds/providers/careers-portal.ts),
// then applies the pure transition + promotion gate
// (lib/feeds/source-candidate-validation.ts). Emits a JSON report of the new
// validation_status / confidence / promote decision per candidate.
//
// It NEVER writes to Supabase: like validate-open-roles.ts the report is for
// review, and promotion to fetch_enabled=true is performed by a separate,
// audited step. Unvalidated candidates remain source-discovery only.
//
// Usage:
//   npm run validate:source-candidates                                  # default fixture
//   npm run validate:source-candidates -- --file=path.json --format=jobhive
//   npm run validate:source-candidates -- --only=Acme --concurrency=2
//
//   --file=PATH         input dataset (default fixture)
//   --format=FMT        jobhive | openjobs | candidate (default candidate)
//   --out=PATH          write the JSON report (default: stdout summary only)
//   --only=NAME         validate only companies whose name contains NAME
//   --concurrency=N     parallel probes (default 4)
//   --timeout=N         per-probe timeout ms (default 12000)

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  parseSourceFile,
  dedupeCandidates,
  type SourceFormat,
} from "@/lib/feeds/source-candidates";
import {
  validateCandidate,
  type ValidatedCandidate,
} from "@/lib/feeds/source-candidate-validation";

const DEFAULT_FILE = "scripts/data/source-candidates/sample-candidates.json";

type Cli = {
  file: string;
  format: SourceFormat;
  out: string | null;
  only: string | null;
  concurrency: number;
  timeoutMs: number;
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
  const num = (flag: string, fallback: number): number => {
    const raw = flags.get(flag);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    file: flags.get("file") ?? DEFAULT_FILE,
    format,
    out: flags.get("out") ?? null,
    only: flags.get("only") ?? null,
    concurrency: num("concurrency", 4),
    timeoutMs: num("timeout", 12000),
  };
}

async function runPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrency: number
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const total = items.length;
  const runNext = async (): Promise<void> => {
    while (cursor < total) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(concurrency, 1), total || 1) }, runNext)
  );
  return results;
}

function summarize(validated: ValidatedCandidate[]): {
  by_status: Record<string, number>;
  promotable: number;
} {
  const byStatus: Record<string, number> = {};
  let promotable = 0;
  for (const v of validated) {
    byStatus[v.validation_status] = (byStatus[v.validation_status] ?? 0) + 1;
    if (v.promote) promotable += 1;
  }
  return { by_status: byStatus, promotable };
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const resolved = path.resolve(process.cwd(), cli.file);
  const body = readFileSync(resolved, "utf8");

  let normalized = parseSourceFile(body, cli.format);
  if (cli.only) {
    const needle = cli.only.toLowerCase();
    normalized = normalized.filter((c) => c.company_name.toLowerCase().includes(needle));
  }
  // Dedupe first so a duplicate row isn't re-probed and can't be promoted twice.
  const { unique } = dedupeCandidates(normalized);

  console.log(
    `Validating ${unique.length} candidate(s) (format=${cli.format}, ` +
      `concurrency=${cli.concurrency}, timeout=${cli.timeoutMs}ms)`
  );

  const validated = await runPool(
    unique,
    async (candidate, index) => {
      const result = await validateCandidate(candidate, { timeoutMs: cli.timeoutMs });
      console.log(
        `[${index + 1}/${unique.length}] ${result.company_name}: ` +
          `${result.validation_status}` +
          `${result.promote ? " -> PROMOTE (fetch_enabled=true)" : ""}` +
          `${result.active_openings_count != null ? ` count=${result.active_openings_count}${result.count_exact ? " exact" : ""}` : ""}`
      );
      return result;
    },
    cli.concurrency
  );

  const summary = summarize(validated);
  console.log("\nValidation summary:", JSON.stringify(summary, null, 2));

  if (cli.out) {
    const outPath = path.resolve(process.cwd(), cli.out);
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          dataset_name: "ATS source-candidate validation report",
          generated_at: new Date().toISOString(),
          source_file: cli.file,
          format: cli.format,
          summary,
          candidates: validated,
        },
        null,
        2
      )
    );
    console.log(`\nReport written → ${outPath}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
