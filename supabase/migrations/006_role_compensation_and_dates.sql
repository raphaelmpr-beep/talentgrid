-- Compensation + posting-date ingestion (additive, non-destructive, idempotent).
--
-- TalentGrid's system of record for a job opening is public.roles (the
-- job_openings view is a read-only projection over it — see migration 004).
-- This migration adds the explicit, queryable columns the compensation/date
-- feature needs so ingestion can persist what an ATS/API source provides and
-- the read path can return it verbatim. Nothing here is ever guessed: a missing
-- value stays NULL and surfaces as an em dash in the UI.
--
-- Every statement is additive and re-runnable (add column if not exists / drop
-- + recreate the constraint and view). No existing column is removed.

-- ---------------------------------------------------------------------------
-- Roles: compensation.
-- compensation_min/max are numeric (not the legacy integer salary_min/max) so a
-- source's exact figures survive without lossy truncation. compensation_text
-- preserves the source's own human string ("$120k–$180k", "Competitive") when
-- there is no clean structured range. compensation_source records where the
-- value came from; compensation_status records how precise it is.
-- ---------------------------------------------------------------------------
alter table public.roles
  add column if not exists compensation_min      numeric,
  add column if not exists compensation_max      numeric,
  add column if not exists compensation_currency text default 'USD',
  add column if not exists compensation_period   text,
  add column if not exists compensation_text     text,
  add column if not exists compensation_source   text,
  add column if not exists compensation_status   text not null default 'unavailable';

-- ---------------------------------------------------------------------------
-- Roles: posting dates + freshness.
-- posted_at is the source's own posting date when a clear ATS field provides it.
-- posted_status records whether that date is exact, inferred from when we first
-- discovered the posting, or unavailable. discovered_at / last_seen_at bound the
-- window TalentGrid itself observed the posting (last_seen_at mirrors the
-- existing last_checked_at write the pipeline already performs).
-- ---------------------------------------------------------------------------
alter table public.roles
  add column if not exists posted_status text not null default 'unavailable',
  add column if not exists discovered_at timestamptz not null default now(),
  add column if not exists last_seen_at  timestamptz not null default now();
-- posted_at already exists on roles (migrations 001/004); ensure it for DBs
-- provisioned from an older schema.
alter table public.roles
  add column if not exists posted_at timestamptz;

-- ---------------------------------------------------------------------------
-- Value guards. Dropped + recreated so a re-run lands the current definition.
-- compensation_period: year | hour | month | week | contract | unknown (null ok)
-- compensation_source: ats_api | job_description_parsed | unavailable (null ok)
-- compensation_status: exact_range | exact_single_value | text_only |
--                      parsed_from_description | unavailable
-- posted_status: exact | inferred_from_discovered_at | unavailable
-- ---------------------------------------------------------------------------
alter table public.roles
  drop constraint if exists roles_compensation_period_check;
alter table public.roles
  add constraint roles_compensation_period_check
  check (
    compensation_period is null
    or compensation_period in ('year','hour','month','week','contract','unknown')
  );

alter table public.roles
  drop constraint if exists roles_compensation_source_check;
alter table public.roles
  add constraint roles_compensation_source_check
  check (
    compensation_source is null
    or compensation_source in ('ats_api','job_description_parsed','unavailable')
  );

alter table public.roles
  drop constraint if exists roles_compensation_status_check;
alter table public.roles
  add constraint roles_compensation_status_check
  check (
    compensation_status in (
      'exact_range','exact_single_value','text_only',
      'parsed_from_description','unavailable'
    )
  );

alter table public.roles
  drop constraint if exists roles_posted_status_check;
alter table public.roles
  add constraint roles_posted_status_check
  check (posted_status in ('exact','inferred_from_discovered_at','unavailable'));

-- ---------------------------------------------------------------------------
-- Compatibility view: job_openings. Recreated to expose the new columns. Column
-- list mirrors migration 004 plus the compensation/date fields appended.
-- ---------------------------------------------------------------------------
create or replace view public.job_openings as
  select
    id,
    company_id,
    external_id,
    title,
    description,
    location,
    remote,
    employment_type,
    seniority,
    salary_min,
    salary_max,
    compensation_min,
    compensation_max,
    compensation_currency,
    compensation_period,
    compensation_text,
    compensation_source,
    compensation_status,
    url,
    source,
    role_category,
    domain_category,
    is_active,
    ghost_score,
    posted_at,
    posted_status,
    discovered_at,
    last_seen_at,
    last_checked_at,
    metadata,
    created_at,
    updated_at
  from public.roles;
