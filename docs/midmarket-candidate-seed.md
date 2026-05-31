# Mid-market ($100M–$600M) Candidate Company Seed

## Why this exists

TalentGrid's company universe was seeded mostly with large-cap employers. This
adds a **candidate layer** of 121 lower-annual-revenue companies in the
**$100M–$600M** band (e.g. Fastly, HashiCorp, Sprout Social) so the company-first
views can grow downmarket.

These are **candidate** companies — lower-confidence, **not audited exact data**.
Every record is stored validation-pending and must flow through the full
pipeline before any count is trusted:

```
company -> careers page -> ATS/source mapping -> active jobs -> count exactness -> drift report
```

Nothing in this layer is ever assigned a fabricated active-role count.

## Files

| File | Purpose |
| --- | --- |
| `scripts/data/midmarket/midmarket-company-seed.json` | Raw candidate company seed (121 records, as authored). |
| `scripts/data/midmarket/midmarket-job-sources-seed.json` | Raw job-source seed (121 records: careers URL / ATS slug / source status). |
| `scripts/data/midmarket/midmarket-open-roles-validation-seed.json` | Generated validator input (open-roles `SeedDataset` shape). |
| `lib/feeds/midmarket-seed.ts` | Single mapping authority: raw seed → import input + validation seed. |
| `scripts/import-midmarket-candidates.ts` | Upserts candidates into Supabase (idempotent, dry-run-capable). |
| `scripts/build-midmarket-validation-seed.ts` | Regenerates the validator seed from the raw files. |
| `scripts/midmarket-candidates-smoke.ts` | Offline smoke test (mapping + uncapped-count invariant). |

## How candidates are stored

Each candidate maps to the importer's `CompanyImportInput`
(`lib/feeds/import-companies.ts`) so it dedupes and merges metadata like every
other company. Key fields:

- `revenue_band = "100m_600m"` — so the `/api/companies` **100M–600M** filter
  (`revenueCategory=100m_600m`) matches even when no numeric revenue is present.
- `metadata.revenue_min` / `metadata.revenue_max` — the MUSD band converted to
  **USD** (e.g. $400M–$600M → `400000000` / `600000000`). This is what the
  revenue *range* filter (`minRevenue`/`maxRevenue`) reads. No fake point
  estimate (`annual_revenue`) is invented.
- `metadata.estimated_revenue_band`, `metadata.annual_revenue_min_musd`,
  `metadata.annual_revenue_max_musd`, `metadata.revenue_verification_level`.
- `metadata.candidate_seed = true`, `metadata.seed_layer = "midmarket_100m_600m"`.
- `metadata.validation_enabled = true`, `metadata.fetch_enabled = false`.
- `careers_url`, `job_portal_url`, `country`, `domain_tags`, `role_tags`,
  `industry`.
- `metadata.job_source` — the resolved source path (source name/type, careers
  URL, api_url, ats_slug, status) for the validation workflow to follow.
- `source_status = needs_live_http_validation | needs_source_mapping`.
- `is_hiring = false` — candidates are validation-pending, not asserted-hiring.

These companies surface via `/api/companies` with `includeZeroOpenings=true` and
the 100M–600M revenue filter, as **zero-opening cards** (count `0`) until the
validation workflow resolves a live source. `source_openings_total` /
`source_openings_exact` are **never written by the importer** — they are
promotable only after validation resolves an exact source.

## Importing (Supabase)

**Production writes are gated — run a dry-run first and get confirmation.**

```bash
# Preview the full batch without writing (no Supabase env needed):
npm run import:midmarket:dry-run

# Preview a single company:
npm run import:midmarket -- --dry-run --only=Fastly

# Real upsert (requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY):
npm run import:midmarket
```

The import is **idempotent**: re-running merges metadata and never destroys
existing enrichment data.

## Validating open roles (source resolution + drift)

The candidate validation seed is consumed by the existing open-roles validator
(`scripts/validate-open-roles.ts`), which resolves each company's source
(Greenhouse / Lever / Workday CXS / named-employer APIs, or an HTML scrape) and
reports an **uncapped** `active_openings_count` plus `count_exact`. Counts are
never capped — only the stored title/URL **sample** is bounded.

```bash
# Regenerate the validator seed from the raw files (after editing them):
npm run build:midmarket-validation-seed

# Validate a small sample (Fastly, HashiCorp, Sprout Social):
npm run validate:midmarket:sample

# Validate the whole candidate layer:
npm run validate:midmarket

# Compare live counts against a deployed TalentGrid (drift report):
TALENTGRID_BASE_URL=https://<deployment>.vercel.app npm run validate:midmarket
```

A company whose source resolves to an exact public ATS/board API lands in
`count_status = counted_from_public_api_exact` with `count_exact = true`; only
those totals are safe to promote to `source_openings_total` /
`source_openings_exact`. See `docs/open-roles-validation.md` for the promotion
runbook and the full `count_status` vocabulary.

## Smoke test

```bash
npm run smoke:midmarket
```

Runs fully offline and asserts: all 121 records parse and join; every import
input is validation-pending with no fabricated count (`fetch_enabled=false`,
`is_hiring=false`, no `source_openings_total`); revenue bounds convert MUSD→USD
inside the 100M–600M window; and an ATS-backed candidate reports its **full**
inventory total even though the sample is bounded (the no-cap invariant).
