# Open Roles Validation Runbook

## Why this exists

Company cards in TalentGrid show an **open roles** count. For large employers
those counts drift away from reality:

- The public careers site shows N live roles.
- TalentGrid carries a stale or duplicated figure.

The canonical case is **Pinterest**: the live Greenhouse board reports **176**
openings, while TalentGrid had carried **178** (a stale/duplicated count). The
same class of drift affects most of the 221 seeded companies, because their
open-role counts were never live-validated — they were seeded `null` on purpose
(null means *not yet validated*, **not** zero).

This workflow re-derives the **current live inventory** for every company by
hitting the same exact public ATS/board sources the app's refresh flow uses
(`lib/feeds/providers/careers-portal.ts`), and optionally diffs that against a
live TalentGrid deployment so drift is caught before it reaches a card.

## What it is

- **Seed dataset** — `scripts/data/open-roles-validation-seed.json` (221
  companies, the validation input).
- **Validator** — `scripts/validate-open-roles.ts`.
- **Smoke test** — `scripts/validate-open-roles-smoke.ts` (offline, no network).

The validator does **not** re-implement ATS adapters. It calls
`fetchCareersPortalJobs`, which already resolves Greenhouse, Lever, Workday CXS,
and the Amazon / Microsoft / Apple named-employer APIs, and already reports an
**exact, uncapped** `totalCount` distinct from the bounded title/URL sample.

### No cap on counts

`active_openings_count` is always the provider's **full inventory total**, never
capped. The stored `sample_job_titles` / `job_listing_urls` are bounded (default
5) only to keep the report small — they are a spot-check sample, not the count.
The smoke test asserts this invariant directly: Pinterest reports 176 with a
5-item sample.

## How to run

### Validate all 221 companies

```bash
npm run validate:open-roles
# → reads  scripts/data/open-roles-validation-seed.json
# → writes scripts/data/open-roles-validation-report.json
```

This makes live network requests to public careers sites and ATS APIs. Use a
modest concurrency to stay polite:

```bash
npm run validate:open-roles -- --concurrency=4 --timeout=12000
```

### Validate a sample (recommended first)

```bash
npm run validate:open-roles:sample          # first 10 companies
npm run validate:open-roles -- --limit=20    # first 20
npm run validate:open-roles -- --only=Pinterest   # name substring match
```

### Custom input / output paths

```bash
npm run validate:open-roles -- ./my-seed.json ./my-report.json --limit=50
```

### CLI flags

| flag | env | default | meaning |
| --- | --- | --- | --- |
| `--limit=N` | — | (all) | validate only the first N companies |
| `--only=Name` | — | (all) | only companies whose name contains `Name` (case-insensitive) |
| `--concurrency=N` | `CONCURRENCY` | 4 | parallel workers |
| `--timeout=N` | `TIMEOUT_MS` | 12000 | per-request timeout (ms) |
| `--sample-jobs=N` | `SAMPLE_SIZE` | 5 | max sample titles/URLs per company |

### Drift comparison against live TalentGrid

Set `TALENTGRID_BASE_URL` to diff the derived live count against the count the
deployment currently serves from `GET /api/companies?q=<name>`:

```bash
TALENTGRID_BASE_URL=https://talentgrid-ebcb5665.vercel.app \
  npm run validate:open-roles -- --limit=10
```

This populates `talentgrid_openings_count`, `count_delta`
(`talentgrid - live`), and `count_match_status` per company.

### Offline smoke test

```bash
npm run smoke:open-roles
```

## Interpreting the report

Each company gains an `open_roles_validation` object:

```jsonc
{
  "live_checked": true,
  "checked_at": "2026-05-31T07:32:30.528Z",
  "active_openings_count": 176,        // full, uncapped live inventory (null = not counted)
  "count_exact": true,                 // true only for a vendor-reported exact total
  "count_status": "counted_from_public_api_exact",
  "validation_method": "greenhouse",   // greenhouse|lever|workday|amazon|microsoft|apple|html|json
  "source_url": "https://boards-api.greenhouse.io/v1/boards/pinterest/jobs",
  "api_url": "https://boards-api.greenhouse.io/v1/boards/pinterest/jobs",
  "sample_job_titles": ["..."],        // bounded spot-check sample, NOT the count
  "job_listing_urls": ["..."],
  "http_status": null,
  "error": null,
  "talentgrid_openings_count": 178,    // only set when TALENTGRID_BASE_URL is provided
  "count_delta": 2,                    // talentgrid - live
  "count_match_status": "drift"        // match | drift | talentgrid_missing | not_compared
}
```

### `count_status` values

| status | meaning | trust the count? |
| --- | --- | --- |
| `counted_from_public_api_exact` | exact live total from a public ATS/board JSON API | **Yes** — authoritative |
| `scraped_sample_not_exact` | HTML/JSON scrape recovered a sample | No — treat as a **lower bound** |
| `portal_accessible_but_roles_not_counted` | careers page reachable, no countable source (JS-only SPA, no recognised board) | No count |
| `captcha_or_bot_challenge` | blocked by a human-verification wall | No count |
| `no_source_url` | nothing to fetch | No count |
| `validation_failed` | network/parse error | No count |

### Exact vs non-exact

- **Exact** (`count_exact: true`): the count came from a public, key-less JSON
  board API that reports the whole inventory (Greenhouse `meta.total`, Lever
  array length, Workday CXS `total`, or a named-employer search API). This is the
  number a candidate sees on the live site. **Safe to publish.**
- **Non-exact** (`count_exact: false`): the count is a best-effort sample scraped
  from HTML/JSON. A JS-rendered board may expose only a few anchors, so the count
  is a **lower bound**, not the live total. **Do not publish as an exact count.**

`null` for `active_openings_count` always means *not counted this run*. Never
interpret it as zero.

## Using the report to update source metadata safely

The validator **never writes to the database** — it only emits a JSON report.
Promote results deliberately:

1. **Only promote exact counts.** Filter the report to
   `count_status == "counted_from_public_api_exact"`. Non-exact scrapes are lower
   bounds and must not overwrite a published figure.
2. **Record the source, not just the number.** Store the exact total alongside an
   `exact` flag on `companies.metadata` (the app already reads
   `source_openings_total` / `source_openings_exact` via `resolveSourceTotal` in
   `lib/companies/search-scope.ts`). An exact total wins over any non-exact
   sibling row, which is what prevents the Pinterest 178 duplicate from winning.
3. **Investigate drift before acting.** A `drift` row means TalentGrid and the
   live source disagree. Confirm the live count (open `source_url`) before
   changing anything — the live source is authoritative for exact rows.
4. **Re-validate after any import.** Run the sample mode against the deployment
   with `TALENTGRID_BASE_URL` set and confirm `count_match_status == "match"` for
   the rows you promoted.

## Limitations

- **Scraped counts are lower bounds.** Many enterprise careers pages are
  JS-rendered SPAs with no public board API and no server-rendered job links, so
  they land in `portal_accessible_but_roles_not_counted` or
  `scraped_sample_not_exact`. Only employers on a recognised ATS (Greenhouse /
  Lever / Workday) or with a named-employer adapter get an exact count.
- **Named-employer adapters** (Amazon / Microsoft / Apple) report the API's own
  total. Amazon caps its public `hits` at 10000, so very large boards read as
  exactly 10000 — that is the API's reported ceiling, still uncapped on our side.
- **Drift comparison depends on the live API shape.** `fetchTalentGridCount`
  reads the count defensively from the common `/api/companies` response shapes;
  if the field names change, the drift fields fall back to `talentgrid_missing`.
- Validation is **best-effort and non-fatal per company**: one company's failure
  never aborts the run.
