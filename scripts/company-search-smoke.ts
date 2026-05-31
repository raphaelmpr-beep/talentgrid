#!/usr/bin/env tsx
// Smoke test for company-name search scoping. Runs fully offline against a small
// fixture set — no network, no Supabase. Exits non-zero on any failed assertion
// so it can gate CI / be run ad hoc:
//
//   npm run smoke:company-search
//   tsx scripts/company-search-smoke.ts
//
// This guards the regression where an unrelated query (e.g. "Walmart") surfaced
// Pinterest's opening count: a company-name search must scope to the named
// company only, and rank exact > prefix > substring.

import {
  companyNameMatchStrength,
  computeCompanyNameMatches,
  normalizeCompanyKey,
  type NamedCompany,
} from "@/lib/companies/search-scope";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

const COMPANIES: NamedCompany[] = [
  { id: "pinterest", name: "Pinterest" },
  { id: "walmart", name: "Walmart" },
  { id: "apple", name: "Apple" },
  { id: "nvidia", name: "NVIDIA" },
  { id: "jpmorgan", name: "JPMorgan Chase" },
  { id: "jj", name: "Johnson & Johnson" },
  { id: "paypal", name: "PayPal" },
];

function search(query: string): NamedCompany[] {
  return computeCompanyNameMatches(COMPANIES, normalizeCompanyKey(query)).map((m) => m.company);
}

console.log("normalizeCompanyKey: punctuation and casing");
{
  assert(normalizeCompanyKey("Johnson & Johnson") === "johnson johnson", "collapses punctuation to space");
  assert(normalizeCompanyKey("  NVIDIA  ") === "nvidia", "lowercases and trims");
}

console.log("companyNameMatchStrength: ranking tiers");
{
  assert(companyNameMatchStrength("Walmart", "walmart") === 3, "exact match scores 3");
  assert(companyNameMatchStrength("Johnson & Johnson", "johnson") === 2, "prefix match scores 2");
  assert(companyNameMatchStrength("PayPal", "pal") === 1, "substring match scores 1");
  assert(companyNameMatchStrength("Apple", "walmart") === 0, "no match scores 0");
  assert(companyNameMatchStrength("Walmart", "") === 0, "empty query scores 0");
}

console.log("company search: Pinterest query ranks Pinterest first");
{
  const results = search("Pinterest");
  assert(results.length >= 1, `returns at least one match (got ${results.length})`);
  assert(results[0]?.id === "pinterest", `Pinterest ranks first (got ${results[0]?.id})`);
}

console.log("company search: unrelated queries never surface Pinterest");
{
  for (const query of ["Walmart", "Apple", "NVIDIA", "JPMorgan"]) {
    const ids = search(query).map((c) => c.id);
    assert(!ids.includes("pinterest"), `"${query}" does not surface Pinterest (got [${ids.join(", ")}])`);
    assert(ids.length > 0, `"${query}" still matches its own company (got [${ids.join(", ")}])`);
  }

  const walmart = search("Walmart");
  assert(walmart.length === 1 && walmart[0]?.id === "walmart", "Walmart query scopes to Walmart only");
}

console.log("company search: exact outranks prefix outranks substring");
{
  // "pa" matches PayPal (substring). "paypal" exact should rank above any prefix
  // or substring sibling. Add a constructed set to make the ordering observable.
  const set: NamedCompany[] = [
    { id: "paypal", name: "PayPal" },
    { id: "paysafe", name: "Paysafe" },
    { id: "company-pal", name: "Acme Pal" },
  ];
  const ranked = computeCompanyNameMatches(set, normalizeCompanyKey("pay")).map((m) => m.company.id);
  // "pay" is a prefix of PayPal and Paysafe (strength 2), substring of none else here.
  assert(ranked.includes("paypal") && ranked.includes("paysafe"), "prefix matches included for 'pay'");
  assert(!ranked.includes("company-pal"), "'pay' does not match 'Acme Pal'");

  const exactRanked = computeCompanyNameMatches(set, normalizeCompanyKey("paypal"));
  assert(exactRanked[0]?.company.id === "paypal", "exact 'paypal' ranks PayPal first");
  assert(exactRanked[0]?.strength === 3, "exact match carries strength 3");
}

console.log("company search: empty query is not a company-name search");
{
  assert(search("").length === 0, "empty query yields no name matches");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll company-search smoke assertions passed.");
