-- Recruiter Intel: extend rolodex_entries (additive, non-destructive, idempotent).
--
-- The Recruiter Intel "Find Contact" flow saves a likely recruiting contact for
-- a job opening into the existing rolodex. Rather than create a parallel table,
-- we extend public.rolodex_entries with the few fields the feature needs. The
-- existing "name" column already stores the contact's full name, so no rename is
-- performed (renaming would break the live /api/rolodex read/write path).
--
-- COMPLIANCE: nothing here scrapes or enriches. Saved rows are user-entered and
-- default to verification_status = 'manual_review_required'; source_type defaults
-- to 'manual_user_entry'. We never assert an exact, verified recruiter.
--
-- Every statement is additive and re-runnable (add column if not exists).

alter table public.rolodex_entries
  add column if not exists company_name        text,
  add column if not exists job_opening_id       uuid,
  add column if not exists job_title            text,
  add column if not exists contact_path_label   text,
  add column if not exists source_type          text not null default 'manual_user_entry',
  add column if not exists verification_status  text not null default 'manual_review_required',
  add column if not exists confidence_level     text,
  add column if not exists updated_at           timestamptz not null default now();

-- job_opening_id points at a role when the contact was saved from a job card.
-- ON DELETE SET NULL so removing a role never deletes a saved contact.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rolodex_entries_job_opening_fk'
  ) then
    alter table public.rolodex_entries
      add constraint rolodex_entries_job_opening_fk
      foreign key (job_opening_id) references public.roles(id) on delete set null;
  end if;
end $$;

-- Value guards. Dropped + recreated so a re-run lands the current definition.
alter table public.rolodex_entries
  drop constraint if exists rolodex_entries_verification_status_check;
alter table public.rolodex_entries
  add constraint rolodex_entries_verification_status_check
  check (
    verification_status in ('manual_review_required','manually_verified','unverified')
  );

alter table public.rolodex_entries
  drop constraint if exists rolodex_entries_confidence_level_check;
alter table public.rolodex_entries
  add constraint rolodex_entries_confidence_level_check
  check (confidence_level is null or confidence_level in ('high','medium','low'));

create index if not exists rolodex_entries_job_opening_idx
  on public.rolodex_entries (job_opening_id)
  where job_opening_id is not null;
