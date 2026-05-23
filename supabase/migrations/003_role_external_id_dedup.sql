-- Add external_id column to roles for proper deduplication by source provider ID.
-- NULL values are allowed (for manually created roles); the unique constraint only
-- applies to non-null values, which is the natural behaviour of a standard unique
-- index in PostgreSQL (NULL IS DISTINCT FROM NULL).

alter table public.roles
  add column if not exists external_id text;

create unique index if not exists roles_company_external_id_uq
  on public.roles (company_id, external_id);
