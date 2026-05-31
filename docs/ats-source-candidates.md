# ATS Source Candidate Enrichment Runbook

## Why this exists

TalentGrid's company cards are only as good as the **source mappings** behind
them — the `(company, ATS vendor, slug)` tuples that tell the refresh flow where
to fetch live openings. Today those mappings are hand-curated. Open-source ATS
datasets (jobhive's 86K companies, OpenJobs' 12K) can seed thousands more, but
they are **enrichment inputs, never final truth**: their slugs go stale, their
vendor guesses are sometimes wrong, and some carry non-commercial licenses.

This workflow imports candidate source mappings into a **quarantine table**
(`public.company_job_sources_candidate`) with `fetch_enabled = false`, then
live-validates each one against the *same* provider the app's refresh flow uses
(`lib/feeds/providers/careers-portal.ts`). Only a candidate that returns an
**exact, uncapped** job count from a supported API is ever promoted to
`fetch_enabled = true`. Everything else stays source-discovery only.

The design follows the research in `ats_source_mapping_research.md` (project
inventory, license risks, URL conventions, and the confidence/priority tables
cited throughout this doc).

## Hard safety rules

These are invariants, not guidelines. The smoke test
(`scripts/source-candidates-smoke.ts`) asserts every one of them.

1. **Imports never promote.** Every imported row is `fetch_enabled = false`.
   The importer (`scripts/import-source-candidates.ts`) cannot set it true.
2. **Only an exact API success promotes.** A candidate is promoted to
   `fetch_enabled = true` *only* when its status is `validated_fetchable` —
   which requires a supported `exact_api` vendor returning a real count
   (`countExact = true`, jobs > 0). HTML / non-exact sources are never promoted.
3. **A manually verified source is never overwritten by a third-party import.**
   `canOverwriteVerified` blocks any non-manual incoming candidate from
   replacing an existing `manually_verified = true` row. Only an explicit manual
   flag on the incoming row may replace it.
4. **No production Supabase writes from this workflow by default.** The importer
   refuses to run a real upsert without explicit service-role env, the validator
   *never* writes to Supabase at all, and the migration is an additive SQL file
   to be applied through normal Supabase review — not on a feature branch.
5. **No live third-party downloads in production.** The importer reads a *local*
   dataset file. Bulk-fetching a third-party dataset into production is out of
   scope and requires separate license clearance (see below).

## What it is

- **Migration** — `supabase/migrations/005_company_job_sources_candidate.sql`
  (the quarantine table; RLS on, no policy = service-role only).
- **Drizzle mirror** — `companyJobSourcesCandidate` in `lib/db/schema.ts`.
- **Normalizer / import library** — `lib/feeds/source-candidates.ts` (pure).
- **Validation / promotion logic** — `lib/feeds/source-candidate-validation.ts`
  (pure decision fns + an async probe through the careers-portal provider).
- **Import CLI** — `scripts/import-source-candidates.ts`.
- **Validate CLI** — `scripts/validate-source-candidates.ts`.
- **Fixture** — `scripts/data/source-candidates/sample-candidates.json`.
- **Smoke test** — `scripts/source-candidates-smoke.ts` (offline, no network).

The validator does **not** re-implement ATS adapters. It calls
`fetchCareersPortalJobs`, which already resolves Greenhouse (`meta.total`), Lever
(array length), Workday CXS, and the named-employer APIs, and reports an exact,
uncapped `totalCount` distinct from the bounded title/URL sample — the same
contract documented in `open-roles-validation.md`.

## Recommended vs. excluded sources

From the research priority ranking (`ats_source_mapping_research.md` §4.1):

| Priority | Source | License | Use |
|---|---|---|---|
| 1 — Primary seed | stapply-ai/ats-scrapers (**jobhive**) | MIT ✅ | Import via `--format=jobhive`. 86K companies, canonical `ats_type:ats_id` key. |
| 2 — Supplement | outscal/**OpenJobs** | MIT ✅ | Import via `--format=openjobs`. `ats_links[]` → one candidate per link. |
| 3 — Slug lists | Feashliaa/job-board-aggregator | **CC BY-NC 4.0** ⚠️ | **Do NOT enable by default.** Datasets are non-commercial; requires explicit maintainer permission before any commercial TalentGrid import. |
| 4 — Reference only | ever-jobs/ever-jobs | MIT ✅ | Vendor vocabulary reference; not imported as data. |
| 5 — Pattern only | adgramigna/Levergreen | MIT ✅ | Pipeline architecture reference; do not import its dataset. |
| Exclude | plibither8/jobber | MIT | Dormant, 3-field output, no dataset. |
| Exclude | speedyapply/JobSpy | MIT | Targets aggregator sites (LinkedIn/Indeed), not ATS endpoints. |

### License risk callout

`Feashliaa/job-board-aggregator` ships its curated company datasets under
**CC BY-NC 4.0**. Commercial use is *not* granted by the license. The default
`source_origin` enum and importer do not include it; importing it requires
written permission from the maintainer and an explicit, audited decision. Do not
add it to any default import path.

## Fetch strategies

Each vendor maps to one of three strategies (`fetchStrategyForVendor`):

- **`exact_api`** — Greenhouse, Lever, Workday. Public API returns an exact
  count. **Only these can be promoted to `fetch_enabled = true`.**
- **`html_only`** — Ashby, SmartRecruiters, Workable, Teamtailor, Recruitee,
  BambooHR, Personio, etc. Reachable but non-exact. Validation may confirm the
  source is *alive*, but it is never promoted to an exact count.
- **`unsupported`** — iCIMS (partner-gated API), JazzHR (no stable public API),
  Taleo, SuccessFactors, Oracle. Parked as `unsupported_source_type`; never
  probed, never promoted.

## Validation statuses

The full lifecycle vocabulary (`validation_status`):

| Status | Meaning |
|---|---|
| `imported_unvalidated` | Inserted from a third-party source; not yet probed. |
| `validated_fetchable` | Exact-API probe succeeded (200 + jobs > 0, vendor aligns). **Promotable.** |
| `validation_failed` | Probe returned 404, 0 jobs, or a parse error. Confidence −0.30. |
| `stale_import` | Repeated timeout / 5xx. Retryable; no confidence drop. |
| `source_changed` | Slug resolves but the live ATS vendor differs from the recorded one. |
| `duplicate_source` | Collides with an earlier row on the dedup key; not inserted twice. |
| `unsupported_source_type` | Vendor TalentGrid's fetch engine can't exactly count. Never promoted. |

## Confidence scoring

Initial base scores (`baseConfidence`, from research §4.3):

- jobhive (`ats_scrapers`) + slug → **0.75**
- OpenJobs + slug → **0.60**
- manual → **1.00**
- unsupported vendor → capped **≤ 0.40**

Validation adjusts: **+0.20** on a successful exact probe, **−0.30** on a
failure. Scores clamp to `[0, 1]`.

## The flow

```
local dataset file (jobhive | openjobs | candidate)
        │  parseSourceFile → normalize → dedupeCandidates
        ▼
import-source-candidates.ts  ──►  company_job_sources_candidate
   fetch_enabled = false             (quarantine; RLS service-role only)
   validation_status = imported_unvalidated
   ignoreDuplicates: re-import never clobbers a promoted row
        │
        ▼
validate-source-candidates.ts        (read-only; NEVER writes Supabase)
   probe each candidate via fetchCareersPortalJobs
   transitionFromProbe → validation_status + confidence delta
   decidePromotion → promote?  (validated_fetchable && validation_enabled)
        │
        ▼
PROMOTION (separate, audited step — not done by these scripts)
   canOverwriteVerified guards manually_verified rows
   only then: set fetch_enabled = true on the canonical mapping
```

A promoted candidate becomes eligible for the existing refresh cron exactly as a
hand-curated mapping is; an unpromoted candidate remains source-discovery only.

## How to run

All commands are offline-safe. The default file is the bundled fixture.

```bash
# Smoke test (offline; gates CI) — proves every safety rule above
npm run smoke:source-candidates

# Import preview — no writes, default-safe
npm run import:source-candidates:dry-run
npm run import:source-candidates -- --dry-run --file=path/to/jobhive.json --format=jobhive

# Real import (needs Supabase env; inserts fetch_enabled=false rows only)
#   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run import:source-candidates -- --file=path/to/openjobs.json --format=openjobs

# Validate candidates against live endpoints (read-only; optional JSON report)
npm run validate:source-candidates
npm run validate:source-candidates -- --file=path.json --format=jobhive --out=report.json --concurrency=2
```

Input formats (`--format`): `jobhive` (`{company, ats_type, ats_id, url}`),
`openjobs` (`{name, website, ats_links[]}`), `candidate` (directly-authored
rows). Each accepts a JSON array, `{records|companies|data:[...]}`, NDJSON, or
CSV.

## Deployment / production migration

1. **Apply the migration through normal Supabase review**, not from this feature
   branch: `supabase/migrations/005_company_job_sources_candidate.sql`. It is
   additive (a new table + indexes + RLS-enabled-no-policy); it touches no
   existing table.
2. The Drizzle mirror in `lib/db/schema.ts` matches the SQL exactly — no
   `drizzle-kit push` against production is required or intended.
3. After the table exists, run an **import** (with cleared dataset license) to
   populate quarantine rows, then **validate** to produce a promotion report.
4. **Promotion to `fetch_enabled = true` is a separate, audited step.** These
   scripts never flip it in production; review the validation report first.
5. Never bulk-download a third-party dataset directly into production, and never
   import a CC BY-NC source (Feashliaa) without written permission.
