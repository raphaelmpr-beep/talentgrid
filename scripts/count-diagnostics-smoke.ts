#!/usr/bin/env tsx
// Smoke test for /api/companies count diagnostics. Runs fully offline against a
// small fixture set — no network, no Supabase. Exits non-zero on any failed
// assertion so it can gate CI / be run ad hoc:
//
//   npm run smoke:count-diagnostics
//   tsx scripts/count-diagnostics-smoke.ts
//
// Guards the production "counts look broken" reports by asserting that each
// count carries an explicit display mode and filter-impact diagnostics:
//   - Amazon: exact source total present (10000) with a filtered matching subset
//   - Pinterest: exact total 176 caps deduped 178 → exact_source_total
//   - Fastly/Sprout: candidate non-exact sample withheld → withheld/pending modes
//   - applied role/domain filters echoed and filters_affect_counts reflected

import {
  deriveCountDiagnostics,
} from "@/lib/companies/count-diagnostics";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

console.log("exact source total with filtered matching count (Amazon-style)");
{
  // Exact live inventory of 10000; only 3 roles match the active role filter.
  const d = deriveCountDiagnostics({
    resolved: { exactTotal: 10000, nonExactTotal: null },
    matchingCount: 3,
    dedupedActiveCount: 3,
    sourceStatus: "counted_from_public_api_exact",
    fetchEnabled: true,
    validationEnabled: true,
    filtersActive: true,
    appliedRoleFilters: ["engineer"],
    appliedDomainFilters: [],
  });
  assert(d.count_display_mode === "exact_source_total", `mode is exact_source_total (got ${d.count_display_mode})`);
  assert(d.total_source_openings === 10000, `total_source_openings is 10000 (got ${d.total_source_openings})`);
  assert(d.source_openings_exact === true, "source_openings_exact is true");
  assert(d.validation_status === "exact", `validation_status is exact (got ${d.validation_status})`);
  assert(d.filters_affect_counts === true, "filters_affect_counts is true when filters hide openings");
  assert(d.filtered_out_openings_count === 9997, `filtered_out_openings_count is 9997 (got ${d.filtered_out_openings_count})`);
  assert(d.applied_role_filters.join(",") === "engineer", "applied_role_filters echoed");
}

console.log("Pinterest: exact total 176 caps deduped 178, no filters");
{
  const d = deriveCountDiagnostics({
    resolved: { exactTotal: 176, nonExactTotal: 178 },
    matchingCount: 176,
    dedupedActiveCount: 178,
    sourceStatus: "counted_from_public_api_exact",
    fetchEnabled: true,
    validationEnabled: true,
    filtersActive: false,
    appliedRoleFilters: [],
    appliedDomainFilters: [],
  });
  assert(d.count_display_mode === "exact_source_total", `mode is exact_source_total (got ${d.count_display_mode})`);
  assert(d.total_source_openings === 176, `total_source_openings is exactly 176, never 178 (got ${d.total_source_openings})`);
  assert(d.filters_affect_counts === false, "filters_affect_counts is false when no filters active");
  assert(d.filtered_out_openings_count === null, "filtered_out_openings_count is null when no filters hide openings");
}

console.log("validation-pending candidate (no rows, fetch_enabled=false)");
{
  const d = deriveCountDiagnostics({
    resolved: { exactTotal: null, nonExactTotal: null },
    matchingCount: 0,
    dedupedActiveCount: 0,
    sourceStatus: "needs_live_http_validation",
    fetchEnabled: false,
    validationEnabled: true,
    filtersActive: false,
    appliedRoleFilters: [],
    appliedDomainFilters: [],
  });
  assert(d.count_display_mode === "validation_pending", `mode is validation_pending (got ${d.count_display_mode})`);
  assert(d.validation_status === "pending", `validation_status is pending (got ${d.validation_status})`);
  assert(d.total_source_openings === null, "no exact total for a pending candidate");
}

console.log("non-exact HTML sample withheld (Fastly/Sprout-style)");
{
  // The dry-run recovered a non-exact sample but the guard withheld it, so the
  // company has zero ingested rows and a scraped_sample_not_exact status. The
  // diagnostics must say the sample was withheld, NOT surface it as a total.
  const d = deriveCountDiagnostics({
    resolved: { exactTotal: null, nonExactTotal: null },
    matchingCount: 0,
    dedupedActiveCount: 0,
    sourceStatus: "scraped_sample_not_exact",
    fetchEnabled: false,
    validationEnabled: true,
    filtersActive: false,
    appliedRoleFilters: [],
    appliedDomainFilters: [],
  });
  assert(d.count_display_mode === "non_exact_sample_withheld", `mode is non_exact_sample_withheld (got ${d.count_display_mode})`);
  assert(d.validation_status === "non_exact_sample", `validation_status is non_exact_sample (got ${d.validation_status})`);
  assert(d.total_source_openings === null, "non-exact sample never becomes a prominent total");
}

console.log("source blocked / captcha (Sentry/Vercel-style)");
{
  const d = deriveCountDiagnostics({
    resolved: { exactTotal: null, nonExactTotal: null },
    matchingCount: 0,
    dedupedActiveCount: 0,
    sourceStatus: "captcha_or_bot_challenge",
    fetchEnabled: false,
    validationEnabled: true,
    filtersActive: false,
    appliedRoleFilters: [],
    appliedDomainFilters: [],
  });
  assert(d.count_display_mode === "source_blocked", `mode is source_blocked (got ${d.count_display_mode})`);
  assert(d.validation_status === "blocked", `validation_status is blocked (got ${d.validation_status})`);
}

console.log("applied role/domain filters reflected with deduped rows");
{
  // A company with real deduped rows and an active domain filter that narrows
  // the set: mode is filtered_matching_openings and the applied filters echo.
  const d = deriveCountDiagnostics({
    resolved: { exactTotal: null, nonExactTotal: null },
    matchingCount: 4,
    dedupedActiveCount: 12,
    sourceStatus: null,
    fetchEnabled: true,
    validationEnabled: true,
    filtersActive: true,
    appliedRoleFilters: ["backend"],
    appliedDomainFilters: ["finance"],
  });
  assert(d.count_display_mode === "filtered_matching_openings", `mode is filtered_matching_openings (got ${d.count_display_mode})`);
  assert(d.filters_affect_counts === true, "filters_affect_counts is true");
  assert(d.filtered_out_openings_count === 8, `filtered_out_openings_count is 8 (12 - 4) (got ${d.filtered_out_openings_count})`);
  assert(d.applied_role_filters.join(",") === "backend", "applied_role_filters echoed");
  assert(d.applied_domain_filters.join(",") === "finance", "applied_domain_filters echoed");
}

console.log("plain deduped role rows, no source/filters (default mode)");
{
  const d = deriveCountDiagnostics({
    resolved: { exactTotal: null, nonExactTotal: null },
    matchingCount: 7,
    dedupedActiveCount: 7,
    sourceStatus: null,
    fetchEnabled: true,
    validationEnabled: true,
    filtersActive: false,
    appliedRoleFilters: [],
    appliedDomainFilters: [],
  });
  assert(d.count_display_mode === "deduped_role_rows", `mode is deduped_role_rows (got ${d.count_display_mode})`);
  assert(d.filters_affect_counts === false, "no filter impact when no filters active");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll count-diagnostics smoke assertions passed.");
