-- TalentGrid architecture alignment (additive, non-destructive).
--
-- TalentGrid is a company-first, intent-driven job intelligence platform.
-- Jobs (stored in public.roles) are the source of truth; companies are the
-- aggregation/UI layer. This migration adds the explicit, indexable columns
-- the architecture calls for WITHOUT renaming existing tables or dropping
-- data. The existing metadata-jsonb revenue convention
-- (metadata.annual_revenue / revenue_min / revenue_max) is preserved; the new
-- companies.revenue_band column is a denormalised, indexable label derived
-- from it during ingestion and is purely additive.

-- ---------------------------------------------------------------------------
-- Companies: revenue band + tag/monitor metadata for company-first querying.
-- ---------------------------------------------------------------------------
alter table public.companies
  add column if not exists revenue_band  text,
  add column if not exists domain_tags   text[] not null default '{}',
  add column if not exists role_tags     text[] not null default '{}',
  add column if not exists monitor       boolean not null default false;

-- revenue_band uses the same buckets the API exposes:
--   lt_50m | 50m_100m | 100m_600m | 600m_1b | gt_1b  (null = unknown)
create index if not exists companies_revenue_band_idx
  on public.companies (revenue_band)
  where revenue_band is not null;

-- monitored companies are the input set for the ingestion cron.
create index if not exists companies_monitor_idx
  on public.companies (monitor)
  where monitor = true;

-- GIN indexes so domain/industry tag overlap filters stay in SQL.
create index if not exists companies_domain_tags_gin_idx
  on public.companies using gin (domain_tags);
create index if not exists companies_role_tags_gin_idx
  on public.companies using gin (role_tags);

-- ---------------------------------------------------------------------------
-- Compatibility: external_id.
-- The canonical schema (001/003) and all app + Drizzle code key roles by
-- external_id. Some production databases were provisioned from an earlier
-- schema that named this column external_job_id instead. Guarantee the
-- canonical column exists and, when the legacy column is present, backfill it
-- once so dedup keys and the job_openings view below resolve correctly. Both
-- steps are additive and idempotent; the legacy column is left in place.
-- ---------------------------------------------------------------------------
alter table public.roles
  add column if not exists external_id text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'roles'
      and column_name = 'external_job_id'
  ) then
    execute 'update public.roles
               set external_id = external_job_id
             where external_id is null
               and external_job_id is not null';
  end if;
end
$$;

create unique index if not exists roles_company_external_id_uq
  on public.roles (company_id, external_id);

-- ---------------------------------------------------------------------------
-- Roles (job openings): normalised role/domain categories.
-- These mirror the classifier families the API already infers at read time
-- (role_family / domain keys) so ingestion can persist them once and the
-- query path can filter on them in SQL instead of recomputing per request.
-- ---------------------------------------------------------------------------
alter table public.roles
  add column if not exists role_category   text,
  add column if not exists domain_category text;

create index if not exists roles_role_category_idx
  on public.roles (role_category)
  where role_category is not null;

create index if not exists roles_domain_category_idx
  on public.roles (domain_category)
  where domain_category is not null;

-- Composite index supporting the hot company-aggregation path:
-- "active, non-ghost roles for a company, newest first".
create index if not exists roles_company_active_posted_idx
  on public.roles (company_id, is_active, posted_at desc);

-- ---------------------------------------------------------------------------
-- Compatibility view: job_openings.
-- The architecture brief refers to a `job_openings` concept; this project's
-- system of record is `public.roles`. Rather than a destructive rename we
-- expose an additive, read-only view so external tooling can query the
-- architecture's vocabulary while `roles` remains canonical.
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
    url,
    source,
    role_category,
    domain_category,
    is_active,
    ghost_score,
    posted_at,
    last_checked_at,
    metadata,
    created_at,
    updated_at
  from public.roles;
