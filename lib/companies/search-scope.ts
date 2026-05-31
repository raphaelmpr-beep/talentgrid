// Pure company-name search-scoping helpers for /api/companies.
//
// These decide, for a free-text query, whether it is a *company name* search
// (e.g. "Walmart") and, if so, which companies it scopes to and how they rank.
// Keeping them pure and dependency-free lets the route import them and a smoke
// test exercise the exact logic that prevents one company's count (Pinterest's
// 176) from leaking into an unrelated company's search.

// Normalise a string to a comparable key: lowercase, punctuation → space,
// whitespace collapsed. "Johnson & Johnson" → "johnson johnson".
export function normalizeCompanyKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strength of a free-text query as a company-name match against a company name.
//   3 = exact normalised match            ("walmart" → "Walmart")
//   2 = name starts with the query        ("john"    → "Johnson & Johnson")
//   1 = name contains the query substring  ("pal"     → "PayPal")
//   0 = no match
// Intentionally distinct from job-level keyword matching: a search for "Walmart"
// must surface Walmart, not every company whose job descriptions mention it.
export function companyNameMatchStrength(companyName: string, normalizedQuery: string): number {
  if (!normalizedQuery) return 0;
  const name = normalizeCompanyKey(companyName);
  if (!name) return 0;
  if (name === normalizedQuery) return 3;
  if (name.startsWith(`${normalizedQuery} `) || name.startsWith(normalizedQuery)) return 2;
  if (name.includes(normalizedQuery)) return 1;
  return 0;
}

export type NamedCompany = { id: string; name: string };

export type CompanyNameMatch<T extends NamedCompany> = {
  company: T;
  strength: number;
};

// Compute the name-match scope for a query against a set of companies. Returns
// the matches (strength > 0) sorted strongest-first. An empty result means the
// query is not a company-name search and the caller should treat it as a
// keyword/domain/role search instead.
export function computeCompanyNameMatches<T extends NamedCompany>(
  companies: T[],
  normalizedQuery: string
): CompanyNameMatch<T>[] {
  if (!normalizedQuery) return [];
  return companies
    .map((company) => ({ company, strength: companyNameMatchStrength(company.name, normalizedQuery) }))
    .filter((entry) => entry.strength > 0)
    .sort((a, b) => b.strength - a.strength);
}
