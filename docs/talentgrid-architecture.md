# TalentGrid Architecture

TalentGrid is a **company-first, intent-driven job intelligence platform**, not a
traditional job board. Jobs are the source of truth; companies are the
aggregation / UI layer.

## System of record

**Supabase (Postgres) is the system of record.** Final user-facing results are
always derived from Supabase-backed data, never from in-memory datasets.

- `public.roles` — canonical job openings (the source of truth). The
  `public.job_openings` view (migration `004`) exposes the same rows under the
  architecture's vocabulary without a destructive rename.
- `public.companies` — the aggregation layer. Companies are surfaced by
  rolling up their active jobs.

Revenue lives on `companies.metadata` as the canonical keys `annual_revenue`
(USD point estimate) and `revenue_min` / `revenue_max` (range bounds). Migration
`004` adds a denormalised, indexable `companies.revenue_band` label
(`lt_50m | 50m_100m | 100m_600m | 600m_1b | gt_1b`) derived from those values.

## Query flow — `GET /api/companies`

Company results are driven by active, non-ghost jobs joined to companies and
grouped by company. Filters are applied with this semantics:

1. **Revenue** — band (`revenueCategory`) and/or numeric range
   (`minRevenue`/`maxRevenue`) against the company's revenue metadata.
   `includeUnknownRevenue` (default `true`) controls whether companies with no
   revenue metadata pass the range filter — preserving behaviour for already
   imported companies that lack revenue data.
2. **Domain** — across job `domain_category`, company `domain_tags`, and
   `industry`.
3. **Role** — across job `role_category`, job title, and company `role_tags`.
4. **Free text (`q`)** — across company name / industry / domain tags and job
   title / description. A smart-query parser also infers domain/role hints from
   `q`.

Companies are grouped, and each result carries aggregations:

- `active_openings_matching_filters` — jobs matching the current filters
  (the primary card count).
- `active_openings_total` — all active jobs for the company.
- `latest_job_seen_at` — newest `posted_at` / `created_at` among active jobs.
- `top_roles` — most common role labels.

Companies with **0 matching jobs are filtered out** unless an explicit
diagnostic path is used. Results are **never artificially capped**: the API
returns the full grouped set with a `total`, and the UI paginates at **20 per
page** client-side.

### Debug mode

`GET /api/companies?debug=true` adds a `debug` block:

```
{ total_jobs, filtered_jobs, companies_returned, filters_applied,
  fallbacks_triggered, query_time_ms }
```

## Ingestion — `GET|POST /api/cron/refresh-jobs`

Vercel-cron compatible (see `vercel.json`, hourly). For each monitored company
(`companies.monitor = true`):

1. Fetch from **TheirStack** (primary) scoped by company domain.
2. If TheirStack returns **<= 1 job**, trigger the **JobSpy** fallback
   (scaffolded — no-op when `JOBSPY_ENDPOINT` is unset).
3. Merge / dedupe by `external_id` (and company + title).
4. Normalise `role_category` / `domain_category` (`lib/feeds/classify.ts`).
5. Upsert into `public.roles` (`onConflict: company_id,external_id`), mark
   current rows active.
6. Mark previously-active TheirStack rows that disappeared as inactive.

### Cron auth

Real (mutating) runs require `CRON_SECRET` (or `FEED_ADMIN_SECRET` as fallback),
supplied via `Authorization: Bearer …`, `x-cron-secret`, or `?secret=`. With
neither configured, only `?dryRun=true` (no writes) is allowed. Dry-runs are
always safe and return the full would-write report.

## Sources & failsafes

- **TheirStack** — primary ingestion source.
- **JobSpy** — fallback / enrichment when primary coverage is thin. Scaffolded
  behind `JOBSPY_ENDPOINT`; safe no-op when unconfigured.
- **Indeed** — count **validation only** (`validateAgainstIndeed`). Never
  ingested.
- **Wikipedia / Wikidata** — revenue-only fallback when company metadata has no
  revenue. Never hallucinates values; preserves provenance
  (`revenue_source` / `revenue_source_url`).

## Performance

Aggregation is pushed to SQL/Supabase where possible. Indexes (migration `004`)
cover `company_id`, `is_active`, `revenue_band`, `role_category`,
`domain_category`, `monitor`, and GIN indexes on `domain_tags` / `role_tags`,
plus a composite `(company_id, is_active, posted_at desc)` for the hot
aggregation path.
