// Candidate-source refresh safety helper.
//
// Why this exists
// ---------------
// The mid-market ($100M–$600M) candidate layer imports companies that are
// validation-pending: fetch_enabled=false, validation_enabled=true, and a
// source_status of needs_live_http_validation / needs_source_mapping (see
// lib/feeds/midmarket-seed.ts). For these companies a careers/ATS source has
// NOT been confirmed as exact yet, so a real (mutating) refresh must never:
//
//   - persist source_openings_total / source_openings_exact from a best-effort
//     HTML/JSON scrape sample (countExact=false), or
//   - upsert scraped/non-exact role rows as active openings.
//
// Doing either would fabricate an "active openings" count for a company whose
// source mapping has not been validated — exactly the production bug this guards
// against (Fastly returning a non-exact HTML sample of 1, Sprout Social 12).
//
// A dry-run is always allowed to *exercise* the source for validation visibility
// (so the cron report can show "we tried Fastly's careers portal, got a non-exact
// sample of N"), but a real run only ever PERSISTS exact source totals and exact
// source role rows. When the source is not exact, no counts are written and an
// explicit reason is recorded instead.
//
// This module is intentionally pure (no Supabase / network) so the decision is
// unit-testable and applied identically wherever a candidate refresh is gated.

// The careers-source flags this decision keys off. Sourced from the company's
// metadata (set by the importer) and the careers-portal provider result.
export type CandidateRefreshInput = {
  // companies.metadata.fetch_enabled. A candidate stays false until its source
  // is validated; true means the source has been promoted and may be fetched.
  // Treated as false (gated) when absent so an un-flagged legacy row can't be
  // accidentally promoted.
  fetchEnabled: boolean | null | undefined;
  // companies.metadata.validation_enabled. When true the source may be exercised
  // (dry-run validation, exact-source promotion); defaults to true when absent.
  validationEnabled: boolean | null | undefined;
  // Whether the resolved careers count is the vendor-reported exact live
  // inventory (a public ATS board API) rather than a scraped sample.
  countExact: boolean;
  // The full inventory total the source reported (exact or sample).
  totalCount: number;
};

export type CandidateRefreshDecision = {
  // A validation-pending candidate (fetch_enabled !== true). Used to surface the
  // candidate vs. confirmed-source distinction in the cron report.
  isCandidate: boolean;
  // True when the source may be exercised at all (validation_enabled !== false).
  mayValidate: boolean;
  // Whether a real (mutating) run may PERSIST the source total + role rows. Only
  // an exact source on a fetch-enabled OR exact-validated company qualifies; a
  // candidate's non-exact sample never does.
  mayPersist: boolean;
  // A stable, secret-free reason explaining a withheld persist, or null when the
  // source was persisted. Surfaced in the cron report's careers_portal_reason.
  reason: string | null;
};

const flag = (v: boolean | null | undefined, fallback: boolean): boolean =>
  typeof v === "boolean" ? v : fallback;

// Decide whether a candidate company's resolved careers source may be persisted
// on a real refresh, and why not when it may not. The rules:
//
//   - validation_enabled=false        → never exercise/persist (mayValidate=false)
//   - exact source (countExact=true)   → persist (the live inventory is authoritative)
//   - non-exact sample on a candidate  → withhold; record needs_* reason
//   - non-exact but fetch_enabled=true → withhold persist of a *count* too:
//       a scrape sample is a lower bound, never an authoritative active total
//
// fetch_enabled gates whether the company is still a candidate; the EXACTNESS of
// the source gates whether a count is trustworthy. Both must line up before a
// real run writes a source total.
export function decideCandidateRefresh(
  input: CandidateRefreshInput
): CandidateRefreshDecision {
  const fetchEnabled = flag(input.fetchEnabled, false);
  const validationEnabled = flag(input.validationEnabled, true);
  const isCandidate = !fetchEnabled;

  if (!validationEnabled) {
    return {
      isCandidate,
      mayValidate: false,
      mayPersist: false,
      reason: "validation_disabled",
    };
  }

  // Exact live inventory is authoritative regardless of candidate status — this
  // is precisely the state the validation workflow promotes a candidate into, so
  // persisting it is what flips the company from candidate to confirmed.
  if (input.countExact && input.totalCount > 0) {
    return { isCandidate, mayValidate: true, mayPersist: true, reason: null };
  }

  // Non-exact (scraped) sample. Never persisted as a count: it is a lower bound,
  // not the live total, and promoting it would fabricate an active-openings
  // figure for a company whose source is not yet exact-mapped.
  const reason = isCandidate
    ? "candidate_source_not_exact_needs_live_validation"
    : "source_not_exact_sample_not_promoted";
  return { isCandidate, mayValidate: true, mayPersist: false, reason };
}
