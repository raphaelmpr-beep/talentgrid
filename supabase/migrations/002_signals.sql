-- Adds persisted signal events that back components/signal-feed and the
-- /api/feeds/signals API. Forward-compatible with the realtime subscriber:
-- the realtime feed listens on `public.signals` INSERTs and renders them.

create table if not exists public.signals (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  title       text not null,
  detail      text,
  href        text,
  company_id  uuid references public.companies(id) on delete cascade,
  role_id     uuid references public.roles(id) on delete cascade,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists signals_created_at_idx
  on public.signals (created_at desc);
create index if not exists signals_company_id_idx
  on public.signals (company_id);
create index if not exists signals_kind_idx
  on public.signals (kind);

alter table public.signals enable row level security;

-- Signals are public-readable (mirrors the read-everywhere policy used by
-- companies/roles). Writes go through the service role only, so no insert
-- policy is exposed to authenticated users.
drop policy if exists "signals are readable by everyone" on public.signals;
create policy "signals are readable by everyone"
  on public.signals for select using (true);
