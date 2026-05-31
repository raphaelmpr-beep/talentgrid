// ATS source-candidate validation + promotion logic.
//
// Why this exists
// ---------------
// A row in company_job_sources_candidate is a third-party *discovery* mapping,
// not truth. Before TalentGrid will ever fetch it, the candidate must be probed
// against the live ATS/careers endpoint using the SAME provider the refresh flow
// uses (lib/feeds/providers/careers-portal.ts). Only an EXACT vendor-reported
// total (a public JSON board API) earns validated_fetchable + promotion to
// fetch_enabled=true. An HTML/non-exact source is reachable-but-not-exact: it
// stays fetch_enabled=false and is NEVER promoted to an exact count.
//
// This module is split into:
//   - pure decision functions (validation status transition, promotion gate,
//     manual-overwrite guard) — unit-testable, no I/O, used by the smoke test;
//   - a thin async probe (validateCandidate) that calls the provider and feeds
//     its result into the pure transition.
//
// Hard safety rules implemented here (research §4.5):
//   1. manually_verified=true is never overwritten by a third-party candidate
//      unless the new candidate ALSO validates exactly — and even then a
//      manual row is preferred (see canOverwriteVerified).
//   2. fetch_enabled only flips true via promoteCandidate after an exact
//      validation; it starts and stays false otherwise.
//   3. Non-exact / unsupported sources never reach validated_fetchable.

import {
  fetchCareersPortalJobs,
  type FetchLike,
} from "@/lib/feeds/providers/careers-portal";
import type {
  NormalizedSourceCandidate,
  SupportedFetchStrategy,
  ValidationStatus,
} from "@/lib/feeds/source-candidates";

// ---------------------------------------------------------------------------
// Probe result -> validation status (pure)
// ---------------------------------------------------------------------------

export type ProbeOutcome = {
  // The provider resolved a vendor-exact live total (public JSON board API).
  countExact: boolean;
  // Full inventory the source reported (exact or sample). 0 = none found.
  totalCount: number;
  // The provider's resolved source path ("greenhouse" | "html" | ...), or null.
  source: string | null;
  // Provider non-fatal reason when nothing was extracted (http_404, timeout, …).
  reason: string | null;
  // The vendor the candidate was imported as (for source_changed detection).
  expectedVendor: string | null;
  // The fetch strategy the candidate was imported with.
  strategy: SupportedFetchStrategy;
};

export type ValidationTransition = {
  validation_status: ValidationStatus;
  validation_error: string | null;
  // confidence delta to apply (caller clamps to [0,1]).
  confidence_delta: number;
};

// Map a careers-portal probe result onto the next validation_status. The rules
// reflect the research's promotion table:
//   - exact total + >0 jobs                       -> validated_fetchable (+0.20)
//   - resolved a DIFFERENT vendor than imported    -> source_changed
//   - unsupported strategy                          -> unsupported_source_type
//   - reachable but non-exact (html/json sample)    -> stays not-fetchable; we
//        record validation_failed ONLY on a hard miss (404/0/parse). A non-exact
//        but reachable sample is left as the prior unsupported/imported status so
//        a count is never promoted as exact.
//   - timeouts / 5xx                                -> stale_import (retryable)
//   - 404 / 0 jobs / parse error                    -> validation_failed (-0.30)
export function transitionFromProbe(probe: ProbeOutcome): ValidationTransition {
  // Unsupported sources are never probed for an exact count; keep them parked.
  if (probe.strategy === "unsupported") {
    return {
      validation_status: "unsupported_source_type",
      validation_error: null,
      confidence_delta: 0,
    };
  }

  if (probe.countExact && probe.totalCount > 0) {
    // The provider resolved an exact board; confirm the vendor matches what we
    // imported. A mismatch means the company migrated ATS vendors.
    if (
      probe.expectedVendor &&
      probe.source &&
      !vendorsAlign(probe.expectedVendor, probe.source)
    ) {
      return {
        validation_status: "source_changed",
        validation_error: `imported ${probe.expectedVendor}, resolved ${probe.source}`,
        confidence_delta: 0,
      };
    }
    return {
      validation_status: "validated_fetchable",
      validation_error: null,
      confidence_delta: 0.2,
    };
  }

  // Reachable but non-exact (a scraped HTML/JSON sample). Per the research this
  // must NOT become validated_fetchable — counts from it are a lower bound. We
  // hold it as unsupported_source_type so it is never promoted, but it is not a
  // hard failure either.
  if (probe.totalCount > 0 && !probe.countExact) {
    return {
      validation_status: "unsupported_source_type",
      validation_error: "non_exact_source_not_promotable",
      confidence_delta: 0,
    };
  }

  // No jobs found: classify the failure.
  const reason = probe.reason ?? "no_jobs_extracted";
  if (reason === "timeout" || reason.startsWith("http_5")) {
    return {
      validation_status: "stale_import",
      validation_error: reason,
      confidence_delta: 0,
    };
  }
  return {
    validation_status: "validation_failed",
    validation_error: reason,
    confidence_delta: -0.3,
  };
}

// Two vendor labels align when they're the same canonical name. The provider
// reports "greenhouse"/"lever"/"workday" for exact boards; named-employer
// adapters report "amazon"/etc which we don't import as candidates, so any exact
// resolution from a named adapter is treated as aligned (no false source_changed).
function vendorsAlign(expected: string, resolved: string): boolean {
  const e = expected.trim().toLowerCase();
  const r = resolved.trim().toLowerCase();
  if (e === r) return true;
  // Named-employer adapters (amazon/microsoft/apple/nvidia) are exact and not a
  // candidate vendor, so don't flag them as a vendor change.
  const NAMED = new Set(["amazon", "microsoft", "apple", "nvidia"]);
  return NAMED.has(r);
}

export function clampConfidence(score: number | null, delta: number): number {
  const base = typeof score === "number" && Number.isFinite(score) ? score : 0.5;
  const next = base + delta;
  return Math.max(0, Math.min(1, Math.round(next * 1000) / 1000));
}

// ---------------------------------------------------------------------------
// Promotion gate (pure)
// ---------------------------------------------------------------------------

export type PromotionDecision = {
  // True when the candidate may be promoted to fetch_enabled=true and its
  // mapping copied onto the company.
  promote: boolean;
  // Stable, secret-free reason a promotion was withheld, or null when promoted.
  reason: string | null;
};

// A candidate is promotable only when it validated exactly AND its validation is
// enabled. fetch_enabled is the OUTPUT of promotion, never an input to it.
export function decidePromotion(candidate: {
  validation_status: ValidationStatus;
  validation_enabled: boolean;
}): PromotionDecision {
  if (!candidate.validation_enabled) {
    return { promote: false, reason: "validation_disabled" };
  }
  if (candidate.validation_status !== "validated_fetchable") {
    return { promote: false, reason: `not_validated_fetchable:${candidate.validation_status}` };
  }
  return { promote: true, reason: null };
}

// ---------------------------------------------------------------------------
// Manual-verified overwrite guard (pure)
// ---------------------------------------------------------------------------

export type ExistingSource = {
  manually_verified: boolean;
  validation_status: ValidationStatus | null;
};

export type IncomingCandidate = {
  manually_verified: boolean;
  validation_status: ValidationStatus;
};

// Decide whether an incoming third-party candidate may overwrite an EXISTING
// confirmed/verified source mapping. Hard rule: a manually verified source is
// never overwritten by a non-manual import, regardless of validation result.
// Only an explicit manual flag on the incoming row (a human action) may replace
// a manual row. This is stricter than "overwrite if it validates" and is the
// safe default the task asks for ("ideally never overwrite manually_verified").
export function canOverwriteVerified(
  existing: ExistingSource,
  incoming: IncomingCandidate
): { overwrite: boolean; reason: string | null } {
  if (!existing.manually_verified) {
    // Not a verified row — normal promotion rules apply elsewhere.
    return { overwrite: true, reason: null };
  }
  // Existing row IS manually verified.
  if (incoming.manually_verified) {
    // A human is explicitly replacing it — allowed.
    return { overwrite: true, reason: null };
  }
  // Third-party import vs a manually verified source: never overwrite.
  return { overwrite: false, reason: "manually_verified_protected" };
}

// ---------------------------------------------------------------------------
// Async probe (thin I/O wrapper around the provider)
// ---------------------------------------------------------------------------

export type ValidatedCandidate = Omit<NormalizedSourceCandidate, "fetch_enabled"> & {
  // Widened from the import-time `false` literal: promotion is the only thing
  // that can flip this true, and that decision is made here.
  fetch_enabled: boolean;
  validated_at: string;
  validation_error: string | null;
  // Whether this run promotes the candidate (exact + validation enabled).
  promote: boolean;
  promotion_reason: string | null;
  active_openings_count: number | null;
  count_exact: boolean;
};

// Validate one candidate by probing its source through the careers-portal
// provider, then applying the pure transition + promotion gate. Best-effort and
// non-fatal: a provider throw is captured as validation_failed. An optional
// fetch override lets the smoke test exercise this path fully offline.
export async function validateCandidate(
  candidate: NormalizedSourceCandidate,
  opts: { timeoutMs?: number; fetch?: FetchLike } = {}
): Promise<ValidatedCandidate> {
  const validatedAt = new Date().toISOString();

  // validation_enabled=false: do not exercise the source at all.
  if (!candidate.validation_enabled) {
    return {
      ...candidate,
      validated_at: validatedAt,
      validation_status: candidate.validation_status,
      validation_error: "validation_disabled",
      promote: false,
      promotion_reason: "validation_disabled",
      active_openings_count: null,
      count_exact: false,
      fetch_enabled: false,
    };
  }

  // A manually verified candidate is already truth — keep it, never re-probe to
  // demote it. It remains validated_fetchable and promotable.
  if (candidate.manually_verified) {
    const promo = decidePromotion(candidate);
    return {
      ...candidate,
      validated_at: validatedAt,
      validation_error: null,
      promote: promo.promote,
      promotion_reason: promo.reason,
      active_openings_count: null,
      count_exact: false,
      fetch_enabled: false,
    };
  }

  // Unsupported sources are not probed (research safety rule 5).
  if (candidate.supported_fetch_strategy === "unsupported") {
    return {
      ...candidate,
      validated_at: validatedAt,
      validation_status: "unsupported_source_type",
      validation_error: null,
      promote: false,
      promotion_reason: "unsupported_source_type",
      active_openings_count: null,
      count_exact: false,
      fetch_enabled: false,
    };
  }

  let probe: ProbeOutcome;
  try {
    const result = await fetchCareersPortalJobs(
      {
        companyName: candidate.company_name,
        careersUrl: candidate.careers_url,
        jobPortalUrl: candidate.api_url,
        atsType: candidate.source_name,
        atsSlug: candidate.ats_slug,
        maxJobs: 5,
      },
      {
        timeoutMs: opts.timeoutMs ?? 12000,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      }
    );
    probe = {
      countExact: result.countExact === true,
      totalCount: result.totalCount,
      source: result.source ?? null,
      reason: result.reason ?? null,
      expectedVendor: candidate.source_name,
      strategy: candidate.supported_fetch_strategy,
    };
  } catch (err) {
    probe = {
      countExact: false,
      totalCount: 0,
      source: null,
      reason: err instanceof Error ? err.message : String(err),
      expectedVendor: candidate.source_name,
      strategy: candidate.supported_fetch_strategy,
    };
  }

  const transition = transitionFromProbe(probe);
  const nextStatus = transition.validation_status;
  const promo = decidePromotion({
    validation_status: nextStatus,
    validation_enabled: candidate.validation_enabled,
  });

  return {
    ...candidate,
    validation_status: nextStatus,
    validation_error: transition.validation_error,
    confidence_score: clampConfidence(candidate.confidence_score, transition.confidence_delta),
    validated_at: validatedAt,
    promote: promo.promote,
    promotion_reason: promo.reason,
    active_openings_count: probe.totalCount > 0 ? probe.totalCount : null,
    count_exact: probe.countExact,
    // fetch_enabled is the OUTPUT of promotion: true only when we promote.
    fetch_enabled: promo.promote,
  };
}
