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
  companyNameMatchStrengthWithAliases,
  computeCompanyNameMatches,
  normalizeCompanyKey,
  resolveCompanyNameAliases,
  resolveSourceTotal,
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

console.log("company-name aliases: short name resolves to legal name");
{
  // "Google" must surface the "Alphabet" row (and vice versa); "Meta" must
  // surface "Meta Platforms". Without aliases, a Google search would miss the
  // company stored under its legal name.
  assert(
    companyNameMatchStrengthWithAliases("Alphabet", normalizeCompanyKey("Google")) === 3,
    "Google matches Alphabet at exact strength"
  );
  assert(
    companyNameMatchStrengthWithAliases("Alphabet Inc", normalizeCompanyKey("Alphabet")) === 2,
    "Alphabet matches 'Alphabet Inc' at prefix strength"
  );
  assert(
    companyNameMatchStrengthWithAliases("Meta Platforms", normalizeCompanyKey("Meta")) === 3,
    "Meta matches 'Meta Platforms' at exact strength"
  );
  assert(
    companyNameMatchStrengthWithAliases("Meta Platforms", normalizeCompanyKey("Meta Platforms")) === 3,
    "'Meta Platforms' matches 'Meta Platforms' at exact strength"
  );
  // Aliases must not bleed into unrelated companies.
  assert(
    companyNameMatchStrengthWithAliases("Apple", normalizeCompanyKey("Google")) === 0,
    "Google does not match Apple via aliases"
  );

  const aliased = computeCompanyNameMatches(
    [
      { id: "alphabet", name: "Alphabet" },
      { id: "meta", name: "Meta Platforms" },
      { id: "apple", name: "Apple" },
    ],
    normalizeCompanyKey("Google")
  );
  // computeCompanyNameMatches uses the non-alias strength; the alias resolution
  // happens in the route via companyNameMatchStrengthWithAliases, but the alias
  // set itself must include the legal name.
  assert(
    resolveCompanyNameAliases(normalizeCompanyKey("Google")).includes("alphabet"),
    "Google alias set includes 'alphabet'"
  );
  assert(
    resolveCompanyNameAliases(normalizeCompanyKey("Meta")).includes("meta platforms"),
    "Meta alias set includes 'meta platforms'"
  );
  void aliased;
}

console.log("source total: exact wins across duplicate legacy rows (Pinterest 176)");
{
  // The displayed row carries no source metadata; a legacy duplicate carries the
  // exact total. The exact total must win for the whole name group so the count
  // is 176, not the inflated row count.
  const rows = [
    { metadata: {} },
    { metadata: { source_openings_total: 176, source_openings_exact: true } },
    { metadata: { source_openings_total: 178, source_openings_exact: false } },
  ];
  const resolved = resolveSourceTotal(rows);
  assert(resolved.exactTotal === 176, `exact total resolves to 176 (got ${resolved.exactTotal})`);
  assert(
    resolved.nonExactTotal === 178,
    `non-exact lower bound resolves to 178 (got ${resolved.nonExactTotal})`
  );

  // With no exact total anywhere, only the non-exact lower bound is known.
  const noExact = resolveSourceTotal([
    { metadata: { source_openings_total: 50, source_openings_exact: false } },
    { metadata: {} },
  ]);
  assert(noExact.exactTotal === null, "no exact total when no duplicate reports one");
  assert(noExact.nonExactTotal === 50, "non-exact total falls back to the max sample");
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll company-search smoke assertions passed.");
