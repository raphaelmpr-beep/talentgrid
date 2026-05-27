-- TalentGrid initial schema
-- Tables: companies, roles, favorites, rolodex_entries
-- Uses Supabase auth.users for user identity.

create extension if not exists "pgcrypto";

-- Companies
create table if not exists public.companies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  domain        text unique,
  description   text,
  industry      text,
  size          text,
  location      text,
  logo_url      text,
  website       text,
  is_hiring     boolean not null default false,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists companies_is_hiring_idx on public.companies (is_hiring);
create index if not exists companies_name_idx on public.companies (name);

-- Revenue convention (lives on companies.metadata jsonb):
--   metadata.annual_revenue : integer USD point estimate (canonical)
--   metadata.revenue_min    : integer USD lower bound when a range is known
--   metadata.revenue_max    : integer USD upper bound when a range is known
-- GET /api/companies filters with minRevenue / maxRevenue against these keys.
create index if not exists companies_annual_revenue_idx
  on public.companies (((metadata->>'annual_revenue')::bigint))
  where metadata ? 'annual_revenue';

-- Roles (job postings)
create table if not exists public.roles (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  external_id     text,
  title           text not null,
  description     text,
  location        text,
  remote          boolean not null default false,
  employment_type text,
  seniority       text,
  salary_min      integer,
  salary_max      integer,
  url             text,
  source          text,
  is_active       boolean not null default true,
  ghost_score     integer not null default 0,
  posted_at       timestamptz,
  last_checked_at timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists roles_company_id_idx on public.roles (company_id);
create index if not exists roles_is_active_idx on public.roles (is_active);
create index if not exists roles_ghost_score_idx on public.roles (ghost_score);
create unique index if not exists roles_company_external_id_uq
  on public.roles (company_id, external_id);

-- Favorites (user-scoped)
create table if not exists public.favorites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  company_id  uuid references public.companies(id) on delete cascade,
  role_id     uuid references public.roles(id) on delete cascade,
  notes       text,
  created_at  timestamptz not null default now(),
  constraint favorites_target_check check (
    (company_id is not null) or (role_id is not null)
  )
);

create unique index if not exists favorites_user_company_uq
  on public.favorites (user_id, company_id) where company_id is not null;
create unique index if not exists favorites_user_role_uq
  on public.favorites (user_id, role_id) where role_id is not null;

-- Rolodex entries (user-scoped contacts)
create table if not exists public.rolodex_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  company_id  uuid references public.companies(id) on delete set null,
  name        text not null,
  title       text,
  email       text,
  linkedin    text,
  phone       text,
  notes       text,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists rolodex_user_idx on public.rolodex_entries (user_id);

-- Row Level Security
alter table public.companies enable row level security;
alter table public.roles enable row level security;
alter table public.favorites enable row level security;
alter table public.rolodex_entries enable row level security;

-- Companies / roles are public-readable
drop policy if exists "companies are readable by everyone" on public.companies;
create policy "companies are readable by everyone"
  on public.companies for select using (true);

drop policy if exists "roles are readable by everyone" on public.roles;
create policy "roles are readable by everyone"
  on public.roles for select using (true);

-- Favorites: user-scoped
drop policy if exists "favorites select own" on public.favorites;
create policy "favorites select own"
  on public.favorites for select using (auth.uid() = user_id);

drop policy if exists "favorites insert own" on public.favorites;
create policy "favorites insert own"
  on public.favorites for insert with check (auth.uid() = user_id);

drop policy if exists "favorites update own" on public.favorites;
create policy "favorites update own"
  on public.favorites for update using (auth.uid() = user_id);

drop policy if exists "favorites delete own" on public.favorites;
create policy "favorites delete own"
  on public.favorites for delete using (auth.uid() = user_id);

-- Rolodex: user-scoped
drop policy if exists "rolodex select own" on public.rolodex_entries;
create policy "rolodex select own"
  on public.rolodex_entries for select using (auth.uid() = user_id);

drop policy if exists "rolodex insert own" on public.rolodex_entries;
create policy "rolodex insert own"
  on public.rolodex_entries for insert with check (auth.uid() = user_id);

drop policy if exists "rolodex update own" on public.rolodex_entries;
create policy "rolodex update own"
  on public.rolodex_entries for update using (auth.uid() = user_id);

drop policy if exists "rolodex delete own" on public.rolodex_entries;
create policy "rolodex delete own"
  on public.rolodex_entries for delete using (auth.uid() = user_id);
