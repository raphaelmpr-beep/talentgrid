#!/usr/bin/env tsx
// Smoke test for the CompanyCard count-label renderer. Renders the component to
// static markup for representative diagnostics-backed states and asserts the
// rendered output never contains the legacy all-caps `OPEN ROLES` label, while
// showing the backend-owned wording ("open roles", "matching roles", etc).
//
//   tsx scripts/company-card-label-smoke.ts
//
// Guards the regression where the label paragraph forced an `uppercase` CSS
// class, so backend wording rendered visually as `OPEN ROLES`.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanyCard } from "@/components/CompanyCard";
import type { CompanyResult } from "@/components/company-results/types";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

const base: CompanyResult = {
  id: "co_1",
  name: "Acme Corp",
  is_hiring: true,
  jobCount: 42,
  domains: ["Engineering"],
  rolesSummary: [],
  jobs: [],
  companyMeta: { company: "Acme Corp", revenueCategory: "Mid-market" },
  revenueCategory: "Mid-market",
  created_at: new Date().toISOString(),
};

function render(company: CompanyResult, filtersActive = false): string {
  return renderToStaticMarkup(createElement(CompanyCard, { company, filtersActive }));
}

// Every state that the count-label renderer can produce a number for.
const cases: Array<{ name: string; company: CompanyResult; expect: string }> = [
  {
    name: "unfiltered confirmed exact_api_count",
    company: {
      ...base,
      source_inventory_status: "exact_api_count",
      display_count: 42,
      display_count_type: "total_active_openings",
    },
    expect: "open roles",
  },
  {
    name: "unfiltered confirmed exact_stored_jobs_count",
    company: {
      ...base,
      source_inventory_status: "exact_stored_jobs_count",
      display_count: 17,
      display_count_type: "total_active_openings",
    },
    expect: "open roles",
  },
  {
    name: "legacy cached total_active_openings (no status)",
    company: {
      ...base,
      display_count: 9,
      display_count_type: "total_active_openings",
    },
    expect: "open roles",
  },
  {
    name: "filtered confirmed view",
    company: {
      ...base,
      source_inventory_status: "exact_api_count",
      display_count: 5,
      display_count_type: "filtered_matching_openings",
      active_openings_total: 42,
      filter_diagnostics: {
        has_active_filters: true,
        role_filter_applied: true,
        domain_filter_applied: false,
        revenue_filter_applied: false,
        search_filter_applied: false,
        matching_job_count: 5,
        total_active_job_count: 42,
        count_is_filtered: true,
        filtered_out_openings_count: 37,
        ignored_filters: [],
      },
    },
    expect: "matching roles",
  },
];

for (const c of cases) {
  const html = render(c.company);
  assert(!html.includes("OPEN ROLES"), `${c.name}: no literal OPEN ROLES text`);
  // The legacy bug forced uppercasing via CSS on the label paragraph. Assert the
  // label paragraph is not styled with the `uppercase` utility.
  assert(
    !/class="[^"]*\buppercase\b[^"]*"[^>]*>\s*(open roles|matching roles)/i.test(html),
    `${c.name}: label is not CSS-uppercased`
  );
  assert(html.includes(c.expect), `${c.name}: renders backend wording "${c.expect}"`);
}

// Withheld/unvalidated states must not show a count label at all.
const withheld = render({ ...base, source_inventory_status: "non_exact_html_withheld" });
assert(withheld.includes("Careers page available"), "withheld: shows careers-page wording");
assert(!withheld.includes("OPEN ROLES"), "withheld: no OPEN ROLES");

const needsValidation = render({ ...base, source_inventory_status: "source_not_validated" });
assert(
  needsValidation.includes("Job source needs validation"),
  "unvalidated: shows validation wording"
);
assert(!needsValidation.includes("OPEN ROLES"), "unvalidated: no OPEN ROLES");

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll CompanyCard label smoke assertions passed");
