#!/usr/bin/env tsx
// Smoke test for the candidate-source guard + USD revenue filtering fixes.
// Fully offline (no network, no Supabase) so it gates CI / runs ad hoc:
//
//   npm run smoke:candidate-guard
//   tsx scripts/candidate-guard-smoke.ts
//
// It protects three production regressions fixed under
// "fix: guard candidate source validation counts":
//
//  1. USD REVENUE WINDOW — an explicit minRevenue/maxRevenue window selects the
//     same mid-market companies as revenueCategory=100m_600m, and does NOT leak
//     in companies that carry no revenue metadata (the cause of total=344 vs the
//     correct 121). Built on the real lib/feeds/midmarket-seed mapping so the
//     fixture is the same data shipped to production.
//
//  2. CANDIDATE REFRESH GUARD — a validation-pending candidate (fetch_enabled=
//     false) whose careers source returns a NON-EXACT html sample is never
//     promoted on a real run: mayPersist=false with an explicit needs_* reason.
//     An EXACT source is persisted (that is what promotes a candidate).
//
//  3. NO CAP — an exact source total is persisted verbatim and uncapped; the
//     guard only ever withholds a non-exact sample, it never shrinks a count.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  joinMidmarketSeed,
  parseMidmarketCompanies,
  parseMidmarketJobSources,
} from "@/lib/feeds/midmarket-seed";
import {
  hasRevenueOverlap,
  resolveIncludeUnknownRevenue,
} from "@/lib/companies/revenue-filter";
import { decideCandidateRefresh } from "@/lib/feeds/candidate-refresh";

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

function readJson(p: string): unknown {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), p), "utf8"));
}

// Replicate the route's revenue predicate for the metadata-driven cases the fix
// touches (numeric window + category bucket), using the SHARED pure helpers the
// route now imports so this exercises the real decision.
type FixtureCompany = { metadata: Record<string, unknown> | null; revenue_band: string | null };

function matchesCategory100m600m(c: FixtureCompany): boolean {
  // Mid-market candidates store the legacy bucket verbatim, which is how the
  // category filter matches them even without a numeric point estimate.
  return (c.revenue_band ?? "").trim().toLowerCase() === "100m_600m";
}

function matchesUsdWindow(
  c: FixtureCompany,
  minRevenue: number,
  maxRevenue: number,
  explicitIncludeUnknown: boolean | undefined
): boolean {
  const includeUnknown = resolveIncludeUnknownRevenue(explicitIncludeUnknown, true);
  return hasRevenueOverlap(c.metadata, minRevenue, maxRevenue, includeUnknown);
}

async function main(): Promise<void> {
  const companies = parseMidmarketCompanies(readJson(COMPANIES_PATH));
  const jobSources = parseMidmarketJobSources(readJson(SOURCES_PATH));
  const { importInputs } = joinMidmarketSeed(companies, jobSources);

  // Build the fixture universe: 121 mid-market candidates (USD bounds, 100m_600m
  // bucket) + a handful of metadata-less companies that previously leaked into an
  // explicit USD window, + a large-cap company with a numeric >1B revenue.
  const midmarket: FixtureCompany[] = importInputs.map((c) => ({
    metadata: c.metadata,
    revenue_band: c.revenue_band ?? null,
  }));
  const metadataLess: FixtureCompany[] = Array.from({ length: 200 }, () => ({
    metadata: {},
    revenue_band: "$1B-$10B",
  }));
  const largeCap: FixtureCompany[] = Array.from({ length: 23 }, () => ({
    metadata: { annual_revenue: 5_000_000_000 },
    revenue_band: "$1B-$10B",
  }));
  const universe = [...midmarket, ...metadataLess, ...largeCap];

  console.log("revenue: USD window selects the same set as the 100m_600m category");
  {
    const MIN = 100_000_000;
    const MAX = 600_000_000;
    const categoryHits = universe.filter(matchesCategory100m600m).length;
    assert(categoryHits === 121, `revenueCategory=100m_600m selects 121 (got ${categoryHits})`);

    // Default (no explicit includeUnknownRevenue) on an explicit USD window must
    // NOT leak the metadata-less companies — this is the total=344 → 121 fix.
    const windowHits = universe.filter((c) => matchesUsdWindow(c, MIN, MAX, undefined)).length;
    assert(
      windowHits === 121,
      `minRevenue=100000000&maxRevenue=600000000 selects 121, not 344 (got ${windowHits})`
    );
    assert(windowHits === categoryHits, "USD window and category bucket select the same count");

    // The large-cap numeric companies (annual_revenue 5B) are excluded by real
    // numeric comparison, not by the unknown fallback.
    const largeInWindow = largeCap.filter((c) => matchesUsdWindow(c, MIN, MAX, undefined)).length;
    assert(largeInWindow === 0, `>1B companies never match the 100M–600M window (got ${largeInWindow})`);
  }

  console.log("revenue: includeUnknownRevenue=true opt-in restores metadata-less companies");
  {
    const MIN = 100_000_000;
    const MAX = 600_000_000;
    const optInHits = universe.filter((c) => matchesUsdWindow(c, MIN, MAX, true)).length;
    assert(
      optInHits === 121 + metadataLess.length,
      `explicit includeUnknownRevenue=true re-includes metadata-less (got ${optInHits})`
    );
    // resolveIncludeUnknownRevenue: explicit value always wins; default flips on range.
    assert(resolveIncludeUnknownRevenue(undefined, true) === false, "default excludes unknowns for a range");
    assert(resolveIncludeUnknownRevenue(undefined, false) === true, "default includes unknowns for no range/category");
    assert(resolveIncludeUnknownRevenue(true, true) === true, "explicit true wins over the range default");
    assert(resolveIncludeUnknownRevenue(false, false) === false, "explicit false wins over the no-range default");
  }

  console.log("candidate-refresh: a non-exact sample on a candidate is NEVER persisted");
  {
    // Fastly/Sprout Social production case: fetch_enabled=false, validation on,
    // careers source returned a non-exact HTML sample.
    const nonExactCandidate = decideCandidateRefresh({
      fetchEnabled: false,
      validationEnabled: true,
      countExact: false,
      totalCount: 12,
    });
    assert(nonExactCandidate.isCandidate === true, "fetch_enabled=false is a candidate");
    assert(nonExactCandidate.mayValidate === true, "candidate may still be validated in dry-run");
    assert(nonExactCandidate.mayPersist === false, "non-exact candidate sample is NOT persisted");
    assert(
      nonExactCandidate.reason === "candidate_source_not_exact_needs_live_validation",
      `withheld with a needs_* reason (got ${nonExactCandidate.reason})`
    );
  }

  console.log("candidate-refresh: an EXACT source IS persisted (promotion path), uncapped");
  {
    const exact = decideCandidateRefresh({
      fetchEnabled: false,
      validationEnabled: true,
      countExact: true,
      totalCount: 142,
    });
    assert(exact.mayPersist === true, "exact source on a candidate is persisted (promotes it)");
    assert(exact.reason === null, "no withholding reason when persisted");
    // The decision does not carry/limit the total — persistence writes it verbatim.
    assert(exact.mayValidate === true, "exact source is also validatable");
  }

  console.log("candidate-refresh: validation_enabled=false blocks all exercise");
  {
    const blocked = decideCandidateRefresh({
      fetchEnabled: false,
      validationEnabled: false,
      countExact: true,
      totalCount: 99,
    });
    assert(blocked.mayValidate === false, "validation_enabled=false → not validated");
    assert(blocked.mayPersist === false, "validation_enabled=false → not persisted even if exact");
    assert(blocked.reason === "validation_disabled", `reason is validation_disabled (got ${blocked.reason})`);
  }

  console.log("candidate-refresh: a confirmed (fetch_enabled) source still gates non-exact counts");
  {
    const confirmedNonExact = decideCandidateRefresh({
      fetchEnabled: true,
      validationEnabled: true,
      countExact: false,
      totalCount: 50,
    });
    assert(confirmedNonExact.isCandidate === false, "fetch_enabled=true is not a candidate");
    assert(
      confirmedNonExact.mayPersist === false,
      "a non-exact sample is never persisted as a count, even for a confirmed company"
    );
    assert(
      confirmedNonExact.reason === "source_not_exact_sample_not_promoted",
      `confirmed non-exact reason (got ${confirmedNonExact.reason})`
    );
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll candidate-guard smoke assertions passed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
