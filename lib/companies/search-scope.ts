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

// Common short-name → legal/registered-name aliases. A user searching "Google"
// means Alphabet (the row TalentGrid stores under its legal name / ats_slug
// "google"); "Meta" means "Meta Platforms" (ats_slug "meta"). Keyed by the
// normalised query so casing/punctuation don't matter. Each alias lists the
// normalised company names it should also match, so a query for the short name
// finds the company stored under its legal name. ats_slug hints are matched
// separately by the caller.
const COMPANY_NAME_ALIASES: Record<string, string[]> = {
  google: ["alphabet", "google"],
  alphabet: ["alphabet", "google"],
  meta: ["meta platforms", "meta"],
  "meta platforms": ["meta platforms", "meta"],
};

// Resolve a normalised query into the set of normalised company names it should
// match, including the query itself. A query that is not a known alias resolves
// to just itself. Returned names are normalised (see normalizeCompanyKey).
export function resolveCompanyNameAliases(normalizedQuery: string): string[] {
  if (!normalizedQuery) return [];
  const aliases = COMPANY_NAME_ALIASES[normalizedQuery];
  const set = new Set<string>([normalizedQuery]);
  if (aliases) for (const a of aliases) set.add(a);
  return [...set];
}

// Strength of a free-text query as a company-name match, accounting for known
// short-name → legal-name aliases (Google→Alphabet, Meta→Meta Platforms). The
// best strength across the query and any aliases wins, so "Google" matches an
// "Alphabet" row at exact strength. Returns 0 when nothing matches.
export function companyNameMatchStrengthWithAliases(
  companyName: string,
  normalizedQuery: string
): number {
  let best = 0;
  for (const candidate of resolveCompanyNameAliases(normalizedQuery)) {
    best = Math.max(best, companyNameMatchStrength(companyName, candidate));
  }
  return best;
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

// The authoritative source inventory for a normalised company name, resolved
// across however many duplicate company rows carry (or fail to carry) the
// persisted careers-source metadata. Legacy duplicates that survived past
// refreshes often hold stale/empty metadata, so the exact total — when *any*
// duplicate reports it — must win for the whole name group, not just the row
// that happens to be displayed.
export type ResolvedSourceTotal = {
  // The vendor-reported exact live inventory (a public ATS board API), or null
  // when no duplicate reports an exact total.
  exactTotal: number | null;
  // The largest non-exact (scraped sample) total across duplicates, used only as
  // a lower bound when no exact total exists.
  nonExactTotal: number | null;
};

function readSourceTotal(metadata: Record<string, unknown> | null | undefined): number | null {
  const raw = metadata?.["source_openings_total"];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function readSourceExact(metadata: Record<string, unknown> | null | undefined): boolean {
  return metadata?.["source_openings_exact"] === true;
}

// Resolve the source inventory for one normalised company name across all rows
// sharing it. The exact total wins outright (the smallest exact total is the
// most current authoritative cap when several exist — but in practice there is
// one; we keep the max-seen exact for resilience to a partially-refreshed dup).
export function resolveSourceTotal(
  rows: Array<{ metadata?: Record<string, unknown> | null }>
): ResolvedSourceTotal {
  let exactTotal: number | null = null;
  let nonExactTotal: number | null = null;
  for (const row of rows) {
    const total = readSourceTotal(row.metadata);
    if (total === null) continue;
    if (readSourceExact(row.metadata)) {
      if (exactTotal === null || total > exactTotal) exactTotal = total;
    } else if (nonExactTotal === null || total > nonExactTotal) {
      nonExactTotal = total;
    }
  }
  return { exactTotal, nonExactTotal };
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
