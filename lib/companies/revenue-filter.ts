// Pure revenue-window matching used by /api/companies.
//
// Why this exists
// ---------------
// The companies API supports two ways to scope by revenue:
//   - a category bucket (revenueCategory=100m_600m), and
//   - an explicit USD window (minRevenue=100000000 & maxRevenue=600000000).
//
// Both must select the same set for companies whose USD revenue bounds sit inside
// the window. The bug this guards against: an explicit USD window was leaking in
// every company that carries NO revenue metadata, because includeUnknownRevenue
// defaulted to true. The result was minRevenue/maxRevenue returning a far larger
// set (344) than the equivalent category (121).
//
// The rule, isolated here so it is unit-testable without standing up the route:
//   - includeUnknownRevenue defaults to true for a category/band filter (legacy),
//     but false for an explicit numeric window unless the caller opts in.
//   - A company with numeric revenue (annual_revenue, or revenue_min/revenue_max
//     bounds) matches a window by overlap; whole-dollar USD, no million scaling.

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

// Whether the company's metadata revenue overlaps [minRevenue, maxRevenue] (USD).
// A point estimate (annual_revenue) must fall inside the window; a band
// (revenue_min/revenue_max) must overlap it. With no numeric revenue at all the
// company's inclusion is governed by includeUnknownRevenue.
export function hasRevenueOverlap(
  metadata: Record<string, unknown> | null | undefined,
  minRevenue: number,
  maxRevenue: number,
  includeUnknownRevenue: boolean
): boolean {
  const m = metadata ?? {};
  const annual = parseNumericValue(m["annual_revenue"]);
  const min = parseNumericValue(m["revenue_min"]);
  const max = parseNumericValue(m["revenue_max"]);

  if (annual !== null) return annual >= minRevenue && annual <= maxRevenue;
  if (min !== null || max !== null) {
    const effectiveMin = min !== null ? min : Number.MIN_SAFE_INTEGER;
    const effectiveMax = max !== null ? max : Number.MAX_SAFE_INTEGER;
    return effectiveMax >= minRevenue && effectiveMin <= maxRevenue;
  }
  return includeUnknownRevenue;
}

// Resolve the effective includeUnknownRevenue given the caller's explicit value
// (undefined when not passed) and whether a numeric USD window is in play.
// Unknown-revenue companies are included by default for a category/band filter
// but excluded from an explicit numeric window, so a metadata-less set can no
// longer pollute a precise USD range query. An explicit includeUnknownRevenue
// always wins.
export function resolveIncludeUnknownRevenue(
  explicit: boolean | undefined,
  hasExplicitRevenueRange: boolean
): boolean {
  return explicit ?? !hasExplicitRevenueRange;
}
