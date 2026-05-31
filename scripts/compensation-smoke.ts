#!/usr/bin/env tsx
// Offline smoke for the compensation + posting-date normalizers.
//
// normalizeCompensation/normalizePostedDate are pure functions over a raw vendor
// job object, so they are fully testable without network or DB. This guards the
// two product invariants that matter most:
//   1. A value is only ever as precise as the source supports
//      (exact_range > exact_single_value > text_only > unavailable), and
//   2. We NEVER invent a salary or a posting date — absent/ambiguous data yields
//      the explicit "unavailable" state with null fields.
// Fixtures mirror the real Greenhouse / Lever / Ashby board-API shapes the
// careers-portal provider preserves on CareersPortalJob.raw.

import {
  normalizeCompensation,
  normalizePostedDate,
  compensationStatusRank,
} from "@/lib/jobs/compensation";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

// --- Lever ------------------------------------------------------------------
console.log("Lever compensation");
{
  const range = normalizeCompensation(
    {
      text: "Senior Engineer",
      salaryRange: { min: 120000, max: 180000, currency: "USD", interval: "per-year-salary" },
      createdAt: 1714000000000,
    },
    "lever"
  );
  assert(range.compensation_status === "exact_range", "lever salaryRange → exact_range");
  assert(range.compensation_min === 120000 && range.compensation_max === 180000, "lever range bounds preserved");
  assert(range.compensation_currency === "USD", "lever currency USD");
  assert(range.compensation_period === "year", "lever interval → year");
  assert(range.compensation_source === "ats_api", "lever source ats_api");

  const single = normalizeCompensation(
    { salaryRange: { min: 140000, max: 140000, currency: "USD", interval: "per-year-salary" } },
    "lever"
  );
  assert(single.compensation_status === "exact_single_value", "lever equal min/max → exact_single_value");
  assert(single.compensation_min === 140000 && single.compensation_max === 140000, "lever single value set");

  const textOnly = normalizeCompensation(
    { salaryDescription: "Competitive, commensurate with experience" },
    "lever"
  );
  assert(textOnly.compensation_status === "text_only", "lever salaryDescription only → text_only");
  assert(textOnly.compensation_text?.startsWith("Competitive") === true, "lever text preserved");

  const none = normalizeCompensation({ text: "Engineer" }, "lever");
  assert(none.compensation_status === "unavailable", "lever no pay → unavailable");
  assert(none.compensation_min === null && none.compensation_max === null, "lever unavailable nulls");
}

console.log("Lever posted date");
{
  const posted = normalizePostedDate({ createdAt: 1714000000000 }, "lever");
  assert(posted.posted_status === "exact", "lever createdAt → exact");
  assert(posted.posted_at === new Date(1714000000000).toISOString(), "lever epoch → ISO");

  const none = normalizePostedDate({ text: "Engineer" }, "lever");
  assert(none.posted_status === "unavailable", "lever no date → unavailable");
  assert(none.posted_at === null, "lever unavailable posted_at null");
}

// --- Ashby ------------------------------------------------------------------
console.log("Ashby compensation");
{
  const structured = normalizeCompensation(
    {
      compensation: {
        compensationTierSummary: "$120K – $180K • Offers Equity",
        summaryComponents: [
          {
            compensationType: "Salary",
            interval: "1 YEAR",
            currencyCode: "USD",
            minValue: 120000,
            maxValue: 180000,
          },
          { compensationType: "Equity", interval: "ONE_TIME" },
        ],
      },
      publishedAt: "2026-05-01T00:00:00.000Z",
    },
    "ashby"
  );
  assert(structured.compensation_status === "exact_range", "ashby salary component → exact_range");
  assert(structured.compensation_min === 120000 && structured.compensation_max === 180000, "ashby range bounds");
  assert(structured.compensation_period === "year", "ashby interval 1 YEAR → year");
  assert(structured.compensation_text?.includes("$120K") === true, "ashby tier summary kept as text");

  const summaryOnly = normalizeCompensation(
    { compensation: { compensationTierSummary: "Competitive base + equity" } },
    "ashby"
  );
  assert(summaryOnly.compensation_status === "text_only", "ashby summary only → text_only");

  const none = normalizeCompensation({ title: "PM" }, "ashby");
  assert(none.compensation_status === "unavailable", "ashby no comp → unavailable");
}

console.log("Ashby posted date");
{
  const posted = normalizePostedDate({ publishedAt: "2026-05-01T00:00:00.000Z" }, "ashby");
  assert(posted.posted_status === "exact", "ashby publishedAt → exact");
  assert(posted.posted_at === "2026-05-01T00:00:00.000Z", "ashby ISO preserved");
}

// --- Greenhouse -------------------------------------------------------------
console.log("Greenhouse compensation");
{
  const cents = normalizeCompensation(
    {
      title: "Staff Engineer",
      pay_input_ranges: [
        { min_cents: 15000000, max_cents: 21000000, currency_type: "USD", title: "Annual" },
      ],
      first_published: "2026-04-15T12:00:00Z",
    },
    "greenhouse"
  );
  assert(cents.compensation_status === "exact_range", "greenhouse pay_input_ranges → exact_range");
  assert(cents.compensation_min === 150000 && cents.compensation_max === 210000, "greenhouse cents → whole units");
  assert(cents.compensation_currency === "USD", "greenhouse currency_type USD");
  assert(cents.compensation_period === "year", "greenhouse 'Annual' title → year");

  const metaText = normalizeCompensation(
    {
      title: "Designer",
      metadata: [
        { name: "Salary Range", value: "$90k–$110k", value_type: "short_text" },
        { name: "Department", value: "Design" },
      ],
    },
    "greenhouse"
  );
  assert(metaText.compensation_status === "text_only", "greenhouse pay metadata field → text_only");
  assert(metaText.compensation_text === "$90k–$110k", "greenhouse metadata text preserved");

  const none = normalizeCompensation({ title: "Designer" }, "greenhouse");
  assert(none.compensation_status === "unavailable", "greenhouse no pay → unavailable");
  // Critical: a description that *mentions* a number must NOT become a salary.
  const descNumber = normalizeCompensation(
    { title: "Engineer", content: "We have raised $50M in funding." },
    "greenhouse"
  );
  assert(descNumber.compensation_status === "unavailable", "greenhouse stray $ in content is NOT parsed as salary");
}

console.log("Greenhouse posted date");
{
  const posted = normalizePostedDate({ first_published: "2026-04-15T12:00:00Z" }, "greenhouse");
  assert(posted.posted_status === "exact", "greenhouse first_published → exact");

  const fallback = normalizePostedDate({ created_at: "2026-04-10T00:00:00Z" }, "greenhouse");
  assert(fallback.posted_status === "exact", "greenhouse created_at fallback → exact");

  const none = normalizePostedDate({ updated_at: "2026-05-30T00:00:00Z" }, "greenhouse");
  assert(none.posted_status === "unavailable", "greenhouse updated_at is NOT used as posting date");
}

// --- Cross-cutting invariants ----------------------------------------------
console.log("Invariants");
{
  assert(normalizeCompensation(null, "lever").compensation_status === "unavailable", "null raw → unavailable");
  assert(normalizeCompensation({ salaryRange: { min: 1 } }, "icims").compensation_status === "unavailable", "unknown vendor → unavailable");
  assert(normalizePostedDate({ createdAt: 1714000000000 }, "icims").posted_status === "unavailable", "unknown vendor date → unavailable");
  assert(
    compensationStatusRank("exact_range") > compensationStatusRank("exact_single_value") &&
      compensationStatusRank("exact_single_value") > compensationStatusRank("text_only") &&
      compensationStatusRank("text_only") > compensationStatusRank("unavailable"),
    "status rank ordering is strict"
  );
}

if (failures > 0) {
  console.error(`\n${failures} compensation smoke assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll compensation smoke assertions passed.");
