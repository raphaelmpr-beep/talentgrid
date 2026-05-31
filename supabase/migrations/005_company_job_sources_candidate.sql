-- ATS source-candidate enrichment layer (additive, non-destructive).
--
-- Why this exists
-- ---------------
-- TalentGrid resolves a company's open-role count from the company's own
-- careers page / ATS board API (see lib/feeds/providers/careers-portal.ts). To
-- grow coverage we want to seed candidate ATS source mappings discovered from
-- open-source job-source datasets (stapply-ai/jobhive, outscal/OpenJobs, etc.)
-- WITHOUT trusting them as truth: a third-party mapping is *source discovery
-- only* until TalentGrid's own provider validates it against the live endpoint.
--
-- This table is that staging/quarantine layer. Rows here are NEVER fetched by
-- the refresh cron until they are validated and promoted (fetch_enabled=true).
-- Manually verified rows are authoritative and are never auto-overwritten.
--
-- It is intentionally separate from public.companies.metadata (where confirmed
-- source mappings live) so unvalidated third-party imports cannot pollute the
-- company-facing source path. Promotion copies a validated candidate's mapping
-- onto the company; demotion/failure leaves it quarantined here.
--
-- DO NOT APPLY TO PRODUCTION as part of the feature branch. This file is the
-- migration of record; apply it through the normal Supabase migration review.

create table if not exists public.company_job_sources_candidate (
  id uuid primary key default gen_random_uuid(),

  -- Optional link to a resolved company. Null until the candidate is matched to
  -- a public.companies row (matching is name/domain based and done at import or
  -- promotion time). on delete set null so deleting a company never drops the
  -- discovery record.
  company_id uuid references public.companies (id) on delete set null,

  -- The company name as it appeared in the source dataset, kept verbatim so a
  -- candidate is identifiable before it is matched to a companies row.
  company_name text not null,

  -- ---- Provenance ---------------------------------------------------------
  -- Which OSS project / channel the mapping came from. Free text, but the
  -- importer normalises to the documented set:
  --   manual | openjobs | levergreen | ats_scrapers | jobber | other
  -- (internal dataset aliases jobhive/outscal_openjobs map onto these.)
  source_origin text not null default 'other',
  source_origin_url text,
  imported_at timestamptz not null default now(),

  -- ---- Resolved ATS mapping ----------------------------------------------
  source_name text,            -- canonical ATS vendor: greenhouse | lever | ashby | workday ...
  ats_slug text,               -- vendor board slug / company identifier
  careers_url text,            -- human-facing careers page
  api_url text,                -- resolved public JSON board API endpoint (when known)
  source_type text,            -- api_json | api_json_post | api_graphql | api_xml | html_scrape | api_gated
  -- How TalentGrid would fetch this source if promoted:
  --   exact_api  -> careers-portal provider returns a vendor-exact total
  --   html_only  -> best-effort sample only, never an exact count
  --   unsupported -> no fetch path yet (iCIMS official API, JazzHR, etc.)
  supported_fetch_strategy text not null default 'unsupported',

  -- ---- Validation lifecycle ----------------------------------------------
  validation_status text not null default 'imported_unvalidated',
  -- VALUES:
  --   imported_unvalidated   -- inserted from a third-party source, not yet probed
  --   validated_fetchable    -- provider returned an EXACT live total -> promotable
  --   validation_failed      -- probe 404 / 0 jobs / parse error
  --   stale_import           -- repeated timeouts / 5xx; may recover
  --   source_changed         -- endpoint resolves but ATS vendor changed
  --   duplicate_source       -- identical to an existing candidate/company mapping
  --   unsupported_source_type -- ATS type TalentGrid cannot fetch exactly yet
  validated_at timestamptz,
  validation_error text,
  confidence_score numeric(4, 3),   -- 0.000 .. 1.000

  -- ---- Trust / fetch gating ----------------------------------------------
  -- fetch_enabled starts false for every third-party import; flipped true ONLY
  -- by the promotion path after validation_status='validated_fetchable'.
  fetch_enabled boolean not null default false,
  -- validation_enabled gates whether the probe may run at all (true by default).
  validation_enabled boolean not null default true,
  -- manually_verified rows are human-asserted truth: never auto-overwritten and
  -- never demoted by a third-party re-import.
  manually_verified boolean not null default false,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint company_job_sources_candidate_validation_status_check check (
    validation_status in (
      'imported_unvalidated',
      'validated_fetchable',
      'validation_failed',
      'stale_import',
      'source_changed',
      'duplicate_source',
      'unsupported_source_type'
    )
  ),
  constraint company_job_sources_candidate_fetch_strategy_check check (
    supported_fetch_strategy in ('exact_api', 'html_only', 'unsupported')
  ),
  constraint company_job_sources_candidate_confidence_range check (
    confidence_score is null or (confidence_score >= 0 and confidence_score <= 1)
  )
);

-- Dedup key: a company + vendor + slug + api_url tuple is unique. coalesce so
-- NULL slug/api_url rows still collide deterministically (Postgres treats NULLs
-- as distinct in a plain unique index, which would let duplicates through).
create unique index if not exists company_job_sources_candidate_dedup_uq
  on public.company_job_sources_candidate (
    lower(company_name),
    coalesce(lower(source_name), ''),
    coalesce(lower(ats_slug), ''),
    coalesce(lower(api_url), '')
  );

-- The promotion cron selects validated, fetch-enabled candidates.
create index if not exists company_job_sources_candidate_fetchable_idx
  on public.company_job_sources_candidate (validation_status)
  where fetch_enabled = true;

-- The validation cron selects un-probed / retryable candidates.
create index if not exists company_job_sources_candidate_pending_idx
  on public.company_job_sources_candidate (validation_status, validated_at);

create index if not exists company_job_sources_candidate_company_idx
  on public.company_job_sources_candidate (company_id)
  where company_id is not null;

-- Row Level Security: this is service-role-only enrichment plumbing — there is
-- no user-facing read/write path. Enable RLS with no permissive policy so only
-- the service role (which bypasses RLS) can touch it, matching the project rule
-- that user-facing routes never read enrichment-staging data directly.
alter table public.company_job_sources_candidate enable row level security;
