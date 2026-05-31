#!/usr/bin/env tsx
// Offline smoke for the job-fetch write path's gating decision.
//
// fetchCompanyJobs() itself hits Supabase + the live ATS boards, so it is not
// unit-testable offline without mock injection we don't want to bolt on. The
// decision that actually governs Requirement C — "fetch only sources with
// fetch_enabled=true OR validation_status=validated_fetchable, and only for a
// vendor we can fetch exactly" — lives in isFetchableSource(), which is pure.
// This guards that gate so a future edit can't silently start fetching
// unvalidated or unsupported sources.

import {
  isFetchableSource,
  type CompanyJobSource,
} from "@/lib/jobs/fetch-pipeline";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

function source(over: Partial<CompanyJobSource>): CompanyJobSource {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    company_id: "11111111-1111-1111-1111-111111111111",
    company_name: "Test Co",
    source_name: "greenhouse",
    ats_slug: "testco",
    careers_url: "https://boards.greenhouse.io/testco",
    api_url: null,
    validation_status: "imported_unvalidated",
    fetch_enabled: false,
    ...over,
  };
}

console.log("isFetchableSource: promotion gate");

// Not promoted: imported but neither flag set.
assert(
  isFetchableSource(source({})) === false,
  "imported_unvalidated + fetch_enabled=false is NOT fetchable"
);

// Promoted via fetch_enabled.
assert(
  isFetchableSource(source({ fetch_enabled: true })) === true,
  "fetch_enabled=true greenhouse is fetchable"
);

// Promoted via validation_status.
assert(
  isFetchableSource(
    source({ validation_status: "validated_fetchable" })
  ) === true,
  "validation_status=validated_fetchable greenhouse is fetchable"
);

console.log("isFetchableSource: vendor gate");

// Promoted but unsupported vendor → still not fetchable (no exact path).
assert(
  isFetchableSource(
    source({ fetch_enabled: true, source_name: "icims" })
  ) === false,
  "promoted but unsupported vendor (icims) is NOT fetchable"
);

// Promoted but no vendor (bare careers_url) → informational only.
assert(
  isFetchableSource(
    source({ validation_status: "validated_fetchable", source_name: null })
  ) === false,
  "promoted but vendorless (careers_url only) is NOT fetchable"
);

// All four supported vendors, when promoted, are fetchable.
for (const vendor of ["greenhouse", "lever", "ashby", "workday"]) {
  assert(
    isFetchableSource(source({ fetch_enabled: true, source_name: vendor })) ===
      true,
    `supported vendor ${vendor} is fetchable when promoted`
  );
}

// Vendor matching is case-insensitive and trims whitespace.
assert(
  isFetchableSource(
    source({ fetch_enabled: true, source_name: "  Lever " })
  ) === true,
  "vendor match is case-insensitive and trimmed"
);

if (failures > 0) {
  console.error(`\n${failures} fetch-pipeline smoke assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll fetch-pipeline smoke assertions passed.");
