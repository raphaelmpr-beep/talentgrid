// Count diagnostics for /api/companies.
//
// Why this exists
// ---------------
// Production drift made the open-roles counts look "broken" without saying why:
//   - Amazon: an exact source total of 10000 existed in a dry-run but was not
//     persisted/promoted, so the card showed 1.
//   - Pinterest: 178 deduped legacy role rows vs. an exact source total of 176.
//   - Fastly/Sprout/Walmart/NVIDIA: candidate sources returned non-exact HTML
//     samples that are deliberately withheld, so the card showed 0 with no
//     explanation.
//   - Sentry/Vercel/Microsoft: sources blocked/captcha or unmapped → 0/stale.
//
// In every case the count itself is (now) correct per the cap rules in
// search-scope.ts, but the UI had no way to say whether a number was an exact
// source total, a filtered subset, a deduped role-row count, or withheld because
// the source is pending/blocked. This module derives that explanation as a set
// of explicit, stable diagnostic fields so the UI can show *why* a count is what
// it is instead of looking broken.
//
// Kept pure (no Supabase / network / route imports) so the exact branching is
// exercised by a smoke test and produced identically everywhere counts surface.

import type { ResolvedSourceTotal } from "@/lib/companies/search-scope";

// How the displayed count should be interpreted by the UI. One of:
//   exact_source_total          — total is the vendor-reported exact live inventory
//   filtered_matching_openings  — count is the subset matching active role/domain filters
//   deduped_role_rows           — count is the deduped active role rows (no source total)
//   validation_pending          — candidate source not yet validated; count withheld
//   non_exact_sample_withheld   — source returned a non-exact sample; not promoted to a total
//   source_blocked              — source blocked/captcha/unmapped; count stale or 0
export type CountDisplayMode =
  | "exact_source_total"
  | "filtered_matching_openings"
  | "deduped_role_rows"
  | "validation_pending"
  | "non_exact_sample_withheld"
  | "source_blocked";

export type CountDiagnostics = {
  // The exact source total when one is known, else null. Never a non-exact sample.
  total_source_openings: number | null;
  // Whether total_source_openings is the vendor-reported exact live inventory.
  source_openings_exact: boolean;
  // The persisted careers-source status string (needs_live_http_validation,
  // captcha_or_bot_challenge, …) or null when none was recorded.
  source_status: string | null;
  // A coarse rollup of source_status for the UI: "exact" | "pending" |
  // "blocked" | "non_exact_sample" | "unknown".
  validation_status: "exact" | "pending" | "blocked" | "non_exact_sample" | "unknown";
  // The count after active role/domain/search filters (the matching subset).
  matching_openings_count: number;
  // The deduped active role-row count before the source cap (lower bound of truth).
  deduped_role_rows_count: number;
  // How the surfaced count should be read by the UI.
  count_display_mode: CountDisplayMode;
  // True when role/domain/search filters reduce the matching count below a known
  // larger total (exact source total, or the deduped role set).
  filters_affect_counts: boolean;
  // How many openings the active filters hid, when a larger total is known.
  filtered_out_openings_count: number | null;
  // The role/domain filters that were applied to this request (echoed for the UI).
  applied_role_filters: string[];
  applied_domain_filters: string[];
};

// Inputs needed to derive diagnostics for one company.
export type CountDiagnosticsInput = {
  resolved: ResolvedSourceTotal;
  // The matching count the cap rules produced (already capped to an exact total).
  matchingCount: number;
  // The deduped active role-row count before any source cap.
  dedupedActiveCount: number;
  // companies.metadata flags. Absent values default like the importer/cron:
  // fetch_enabled=false, validation_enabled=true.
  sourceStatus: string | null;
  fetchEnabled: boolean;
  validationEnabled: boolean;
  // Whether any role/domain/search filter was active for this request.
  filtersActive: boolean;
  appliedRoleFilters: string[];
  appliedDomainFilters: string[];
};

// Statuses that mean the source is reachable-but-blocked or not yet mapped, so a
// count of 0/stale is *expected* rather than broken.
const BLOCKED_STATUSES = new Set([
  "captcha_or_bot_challenge",
  "needs_source_mapping",
  "no_source_url",
  "validation_failed",
  "portal_accessible_but_roles_not_counted",
]);

const PENDING_STATUSES = new Set([
  "needs_live_http_validation",
]);

const NON_EXACT_STATUSES = new Set([
  "scraped_sample_not_exact",
]);

function classifyValidationStatus(
  exact: boolean,
  status: string | null
): CountDiagnostics["validation_status"] {
  if (exact) return "exact";
  if (!status) return "unknown";
  if (BLOCKED_STATUSES.has(status)) return "blocked";
  if (NON_EXACT_STATUSES.has(status)) return "non_exact_sample";
  if (PENDING_STATUSES.has(status)) return "pending";
  return "unknown";
}

// Derive the diagnostic fields for one company. The display-mode decision tree,
// in priority order:
//   1. exact source total present              → exact_source_total
//   2. filters active and they hid openings     → filtered_matching_openings
//   3. some deduped role rows exist             → deduped_role_rows
//   4. zero rows + blocked/unmapped status      → source_blocked
//   5. zero rows + non-exact sample status       → non_exact_sample_withheld
//   6. zero rows + pending/candidate            → validation_pending
//   7. otherwise                                → deduped_role_rows (0)
export function deriveCountDiagnostics(input: CountDiagnosticsInput): CountDiagnostics {
  const {
    resolved,
    matchingCount,
    dedupedActiveCount,
    sourceStatus,
    fetchEnabled,
    validationEnabled,
    filtersActive,
    appliedRoleFilters,
    appliedDomainFilters,
  } = input;

  const exact = resolved.exactTotal !== null;
  const totalSourceOpenings = resolved.exactTotal;
  const validationStatus = classifyValidationStatus(exact, sourceStatus);

  // The largest "known total" we can compare the matching subset against to tell
  // whether filters hid anything: an exact source total wins, else the deduped
  // active role set.
  const knownTotal = exact ? (resolved.exactTotal as number) : dedupedActiveCount;
  const filtersHidOpenings = filtersActive && knownTotal > matchingCount;
  const filteredOut = filtersHidOpenings ? knownTotal - matchingCount : null;

  let mode: CountDisplayMode;
  if (exact) {
    mode = "exact_source_total";
  } else if (filtersHidOpenings) {
    mode = "filtered_matching_openings";
  } else if (dedupedActiveCount > 0 || matchingCount > 0) {
    mode = "deduped_role_rows";
  } else if (validationStatus === "blocked") {
    mode = "source_blocked";
  } else if (validationStatus === "non_exact_sample") {
    mode = "non_exact_sample_withheld";
  } else if (
    validationStatus === "pending" ||
    (!fetchEnabled && validationEnabled)
  ) {
    mode = "validation_pending";
  } else {
    mode = "deduped_role_rows";
  }

  return {
    total_source_openings: totalSourceOpenings,
    source_openings_exact: exact,
    source_status: sourceStatus,
    validation_status: validationStatus,
    matching_openings_count: matchingCount,
    deduped_role_rows_count: dedupedActiveCount,
    count_display_mode: mode,
    filters_affect_counts: filtersHidOpenings,
    filtered_out_openings_count: filteredOut,
    applied_role_filters: appliedRoleFilters,
    applied_domain_filters: appliedDomainFilters,
  };
}
