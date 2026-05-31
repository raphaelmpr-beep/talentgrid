#!/usr/bin/env tsx
// Smoke test for the ATS source-candidate enrichment flow. Fully offline (no
// network, no Supabase) so it gates CI / runs ad hoc:
//
//   npm run smoke:source-candidates
//   tsx scripts/source-candidates-smoke.ts
//
// It protects the contract for "feat: add ATS source candidate enrichment":
//
//  1. NORMALISE — jobhive (ats_type/ats_id) and OpenJobs (ats_links[]) records
//     map to canonical vendor/slug with the right fetch strategy; iCIMS/JazzHR
//     are unsupported_source_type up front; manual rows are protected.
//  2. IMPORT GUARDS — fetch_enabled is false on every import; duplicates collide
//     on the dedup key and are flagged duplicate_source, not inserted twice.
//  3. VALIDATION — an exact Greenhouse/Lever board -> validated_fetchable AND
//     promote (fetch_enabled=true). A non-exact Ashby HTML sample is NEVER
//     promoted (stays not-fetchable). validation_failed on a 404.
//  4. MANUAL OVERRIDE — a third-party candidate can never overwrite a
//     manually_verified source; an explicit manual flag can.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseSourceFile,
  dedupeCandidates,
  normalizeJobhiveRecord,
  normalizeOpenJobsRecord,
  fetchStrategyForVendor,
  baseConfidence,
} from "@/lib/feeds/source-candidates";
import {
  validateCandidate,
  transitionFromProbe,
  decidePromotion,
  canOverwriteVerified,
  clampConfidence,
} from "@/lib/feeds/source-candidate-validation";
import type { FetchLike } from "@/lib/feeds/providers/careers-portal";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

const FIXTURE = "scripts/data/source-candidates/sample-candidates.json";

function readJsonText(p: string): string {
  return readFileSync(path.resolve(process.cwd(), p), "utf8");
}

// A stubbed fetch resolving the exact-board endpoints used in this fixture.
//   Greenhouse acmegh   -> 142 exact jobs
//   Lever betalever     -> 7 exact jobs (array)
//   Ashby GammaAshby    -> careers HTML with anchors (non-exact sample)
//   anything else       -> 404
function makeStubFetch(): FetchLike {
  const ghJobs = Array.from({ length: 142 }, (_, i) => ({
    id: 1000 + i,
    title: `Greenhouse Engineer ${i}`,
    absolute_url: `https://boards.greenhouse.io/acmegh/jobs/${1000 + i}`,
    location: { name: "Remote" },
  }));
  const leverJobs = Array.from({ length: 7 }, (_, i) => ({
    text: `Lever Role ${i}`,
    hostedUrl: `https://jobs.lever.co/betalever/${i}`,
    categories: { location: "NYC" },
  }));
  const ashbyHtml =
    "<html><body>" +
    Array.from(
      { length: 4 },
      (_, i) =>
        `<a href="https://jobs.ashbyhq.com/GammaAshby/job/${i}">Ashby Role ${i}</a>`
    ).join("") +
    "</body></html>";

  return async (url) => {
    const u = String(url);
    if (u === "https://boards-api.greenhouse.io/v1/boards/acmegh") {
      return new Response(JSON.stringify({ name: "Acme Greenhouse Co" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u === "https://boards-api.greenhouse.io/v1/boards/acmegh/jobs") {
      return new Response(JSON.stringify({ jobs: ghJobs, meta: { total: 142 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.startsWith("https://api.lever.co/v0/postings/betalever")) {
      return new Response(JSON.stringify(leverJobs), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.startsWith("https://jobs.ashbyhq.com/GammaAshby")) {
      return new Response(ashbyHtml, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
}

async function main(): Promise<void> {
  console.log("normalise: jobhive ats_type/ats_id maps to canonical vendor/slug");
  {
    const c = normalizeJobhiveRecord({
      company: "Stripe",
      ats_type: "greenhouse",
      ats_id: "stripe",
      url: "https://boards.greenhouse.io/stripe",
    });
    assert(c !== null, "jobhive record normalises");
    assert(c?.source_name === "greenhouse", `vendor is greenhouse (got ${c?.source_name})`);
    assert(c?.ats_slug === "stripe", `slug is stripe (got ${c?.ats_slug})`);
    assert(c?.supported_fetch_strategy === "exact_api", "greenhouse is exact_api");
    assert(c?.fetch_enabled === false, "fetch_enabled is false on import");
    assert(
      c?.validation_status === "imported_unvalidated",
      `status is imported_unvalidated (got ${c?.validation_status})`
    );
  }

  console.log("normalise: OpenJobs ats_links[] becomes one candidate per link");
  {
    const cs = normalizeOpenJobsRecord({
      name: "Notion",
      website: "https://notion.so",
      ats_links: [
        "https://jobs.lever.co/notion",
        { type: "ashby", url: "https://jobs.ashbyhq.com/notion" },
      ],
    });
    assert(cs.length === 2, `two ats_links -> two candidates (got ${cs.length})`);
    assert(cs[0].source_name === "lever", "first link is lever");
    assert(cs[1].source_name === "ashby", "second link is ashby (from type hint)");
    assert(cs.every((c) => c.source_origin === "openjobs"), "origin is openjobs");
  }

  console.log("normalise: iCIMS/JazzHR are unsupported_source_type up front");
  {
    assert(fetchStrategyForVendor("icims") === "unsupported", "icims is unsupported");
    assert(fetchStrategyForVendor("jazzhr") === "unsupported", "jazzhr is unsupported");
    assert(fetchStrategyForVendor("greenhouse") === "exact_api", "greenhouse is exact_api");
    assert(fetchStrategyForVendor("ashby") === "html_only", "ashby is html_only");
  }

  console.log("confidence: jobhive primary seed outranks openjobs; manual is 1.0");
  {
    assert(baseConfidence("ats_scrapers", "exact_api", true) === 0.75, "jobhive+slug = 0.75");
    assert(baseConfidence("openjobs", "exact_api", true) === 0.6, "openjobs+slug = 0.6");
    assert(baseConfidence("manual", "exact_api", true) === 1.0, "manual = 1.0");
    assert(baseConfidence("ats_scrapers", "unsupported", true) <= 0.4, "unsupported capped <=0.4");
  }

  console.log("import: fixture parses, dedupes, and flags the duplicate");
  {
    const normalized = parseSourceFile(readJsonText(FIXTURE), "candidate");
    // 6 fixture rows -> the 2nd Acme row collides with the 1st.
    assert(normalized.length === 6, `6 fixture rows parsed (got ${normalized.length})`);
    const { unique, duplicates } = dedupeCandidates(normalized);
    assert(unique.length === 5, `5 unique after dedupe (got ${unique.length})`);
    assert(duplicates.length === 1, `1 duplicate flagged (got ${duplicates.length})`);
    assert(
      duplicates[0].validation_status === "duplicate_source",
      "duplicate is flagged duplicate_source"
    );
    assert(unique.every((c) => c.fetch_enabled === false), "no imported row is fetch_enabled");
    const icims = unique.find((c) => c.source_name === "icims");
    assert(
      icims?.validation_status === "unsupported_source_type",
      "iCIMS row is unsupported_source_type on import"
    );
    const manual = unique.find((c) => c.manually_verified);
    assert(manual?.source_origin === "manual", "manual row keeps manual origin");
    assert(manual?.confidence_score === 1.0, "manual row confidence is 1.0");
  }

  console.log("validate: an exact Greenhouse board -> validated_fetchable AND promote");
  {
    const stub = makeStubFetch();
    const normalized = parseSourceFile(readJsonText(FIXTURE), "candidate");
    const { unique } = dedupeCandidates(normalized);
    const acme = unique.find((c) => c.company_name === "Acme Greenhouse Co")!;
    const before = acme.confidence_score;
    const v = await validateCandidate(acme, { fetch: stub });
    assert(v.validation_status === "validated_fetchable", `status validated_fetchable (got ${v.validation_status})`);
    assert(v.promote === true, "promote=true");
    assert(v.fetch_enabled === true, "fetch_enabled flipped true on promotion");
    assert(v.active_openings_count === 142, `count is exact 142 (got ${v.active_openings_count})`);
    assert(v.count_exact === true, "count_exact=true");
    assert(v.confidence_score > before, `confidence increased (+0.20) ${before} -> ${v.confidence_score}`);
  }

  console.log("validate: an exact Lever board also promotes (imported_unvalidated -> validated_fetchable)");
  {
    const stub = makeStubFetch();
    const normalized = parseSourceFile(readJsonText(FIXTURE), "candidate");
    const { unique } = dedupeCandidates(normalized);
    const beta = unique.find((c) => c.company_name === "Beta Lever Inc")!;
    assert(beta.validation_status === "imported_unvalidated", "starts imported_unvalidated");
    const v = await validateCandidate(beta, { fetch: stub });
    assert(v.validation_status === "validated_fetchable", "lever board validated_fetchable");
    assert(v.promote === true && v.fetch_enabled === true, "lever promoted");
    assert(v.active_openings_count === 7, `lever count 7 (got ${v.active_openings_count})`);
  }

  console.log("validate: a non-exact Ashby HTML sample is NEVER promoted");
  {
    const stub = makeStubFetch();
    const normalized = parseSourceFile(readJsonText(FIXTURE), "candidate");
    const { unique } = dedupeCandidates(normalized);
    const gamma = unique.find((c) => c.company_name === "Gamma Ashby LLC")!;
    const v = await validateCandidate(gamma, { fetch: stub });
    assert(v.promote === false, "non-exact source is NOT promoted");
    assert(v.fetch_enabled === false, "fetch_enabled stays false for a non-exact source");
    assert(
      v.validation_status !== "validated_fetchable",
      `non-exact never validated_fetchable (got ${v.validation_status})`
    );
  }

  console.log("validate: an unsupported (iCIMS) source is parked, never probed/promoted");
  {
    const stub = makeStubFetch();
    const normalized = parseSourceFile(readJsonText(FIXTURE), "candidate");
    const { unique } = dedupeCandidates(normalized);
    const delta = unique.find((c) => c.source_name === "icims")!;
    const v = await validateCandidate(delta, { fetch: stub });
    assert(v.validation_status === "unsupported_source_type", "iCIMS stays unsupported_source_type");
    assert(v.promote === false && v.fetch_enabled === false, "iCIMS never promoted");
  }

  console.log("validate: a 404 board -> validation_failed with a recorded error and -0.30");
  {
    const stub = makeStubFetch();
    const transition = transitionFromProbe({
      countExact: false,
      totalCount: 0,
      source: null,
      reason: "http_404",
      expectedVendor: "greenhouse",
      strategy: "exact_api",
    });
    assert(transition.validation_status === "validation_failed", "404 -> validation_failed");
    assert(transition.validation_error === "http_404", "error records http_404");
    assert(transition.confidence_delta === -0.3, "confidence delta is -0.30");
    assert(clampConfidence(0.2, -0.3) === 0, "confidence clamps at 0");
    // Make sure the stub is actually unused here (pure path) — silence lints.
    void stub;
  }

  console.log("validate: a 5xx/timeout -> stale_import (retryable, no confidence drop)");
  {
    const t = transitionFromProbe({
      countExact: false,
      totalCount: 0,
      source: null,
      reason: "timeout",
      expectedVendor: "lever",
      strategy: "exact_api",
    });
    assert(t.validation_status === "stale_import", "timeout -> stale_import");
    assert(t.confidence_delta === 0, "stale_import does not drop confidence");
  }

  console.log("validate: a vendor change at the live endpoint -> source_changed");
  {
    const t = transitionFromProbe({
      countExact: true,
      totalCount: 10,
      source: "lever",
      reason: null,
      expectedVendor: "greenhouse",
      strategy: "exact_api",
    });
    assert(t.validation_status === "source_changed", "greenhouse->lever flagged source_changed");
  }

  console.log("promotion gate: only validated_fetchable + validation_enabled promotes");
  {
    assert(decidePromotion({ validation_status: "validated_fetchable", validation_enabled: true }).promote, "validated+enabled promotes");
    assert(!decidePromotion({ validation_status: "imported_unvalidated", validation_enabled: true }).promote, "unvalidated does not promote");
    assert(!decidePromotion({ validation_status: "validated_fetchable", validation_enabled: false }).promote, "validation_disabled blocks promotion");
  }

  console.log("manual-override guard: a third-party candidate never overwrites a verified source");
  {
    const blocked = canOverwriteVerified(
      { manually_verified: true, validation_status: "validated_fetchable" },
      { manually_verified: false, validation_status: "validated_fetchable" }
    );
    assert(blocked.overwrite === false, "non-manual import cannot overwrite a verified source");
    assert(blocked.reason === "manually_verified_protected", "reason is manually_verified_protected");

    const explicitManual = canOverwriteVerified(
      { manually_verified: true, validation_status: "validated_fetchable" },
      { manually_verified: true, validation_status: "imported_unvalidated" }
    );
    assert(explicitManual.overwrite === true, "an explicit manual flag may replace a verified source");

    const unverified = canOverwriteVerified(
      { manually_verified: false, validation_status: "imported_unvalidated" },
      { manually_verified: false, validation_status: "validated_fetchable" }
    );
    assert(unverified.overwrite === true, "an unverified existing row follows normal rules");
  }

  console.log("validate: a manually_verified candidate is kept and promotable, never demoted");
  {
    const stub = makeStubFetch();
    const normalized = parseSourceFile(readJsonText(FIXTURE), "candidate");
    const { unique } = dedupeCandidates(normalized);
    const manual = unique.find((c) => c.manually_verified)!;
    const v = await validateCandidate(manual, { fetch: stub });
    assert(v.validation_status === "validated_fetchable", "manual row stays validated_fetchable");
    assert(v.promote === true, "manual row is promotable");
    assert(v.validation_error === null, "manual row has no validation error");
  }

  if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll source-candidate smoke assertions passed.");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
