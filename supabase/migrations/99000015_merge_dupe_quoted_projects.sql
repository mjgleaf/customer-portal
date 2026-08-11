-- Merge duplicate quoted-project rows.
--
-- On 2026-08-03, sync-projects-from-sharepoint's first backfill created a
-- status='quoted' row for every current-year Commercial Proposals folder —
-- including ~85 jobs that were already awarded and living in the portal as
-- Zoho-synced rows. Its "which job codes already exist?" select read
-- cportal_projects through PostgREST's 1000-row response cap (the table has
-- ~1480 rows), so a third of the existing projects were invisible to the
-- dedup pass. The edge functions now page those reads; this migration cleans
-- up the pairs the truncated reads left behind.
--
-- For every job code that has BOTH a Zoho-linked row and a quoted row
-- (zoho_project_id is null), the Zoho row survives:
--   * child rows (files, members, notes, invoices, reminders, document
--     requests, note mentions) are repointed to the survivor — skipping any
--     that would duplicate a file already synced there (same
--     sharepoint_source_id) or a membership that already exists;
--   * the survivor keeps the EARLIER started_on — the proposal folder
--     predates the award, matching sync-zoho's claim pass, which
--     deliberately preserves the proposal date when it claims a quoted row;
--   * the quoted row is deleted.
--
-- Legitimate quoted rows (no awarded twin) are untouched. Idempotent: a
-- re-run finds no pairs and does nothing. Deleted rows are copied to
-- zz_backup_dupe_quoted_projects_20260811 first (RLS enabled, no policies =
-- service-role only); drop that table once the portal looks right.

do $$
declare
  n_pairs int;
  n int;
begin
  create temp table dupe_pairs on commit drop as
  with t as (
    select id, name, zoho_project_id, started_on,
           upper(coalesce(substring(name from '^[Hh][Ww][Ii]-[0-9]{2}-[0-9]+'),
                          substring(name from '^[Qq][0-9]{5}'))) as code
    from public.cportal_projects
  ),
  quoted as (
    select code, id, started_on
    from t where code is not null and zoho_project_id is null
  ),
  zoho as (
    -- If a code has several Zoho rows (R1/R2 revisions), the bare-named row
    -- is the proposal's true twin; fall back to the oldest id.
    select distinct on (code) code, id
    from t
    where code is not null and zoho_project_id is not null
    order by code, (upper(trim(name)) = code) desc, id
  )
  select q.id as quoted_id, z.id as zoho_id, q.started_on as quoted_started
  from quoted q
  join zoho z using (code);

  select count(*) into n_pairs from dupe_pairs;
  raise notice 'dupe quoted/zoho pairs found: %', n_pairs;
  if n_pairs = 0 then
    return;
  end if;

  -- Keep a copy of the rows we are about to delete.
  create table if not exists public.zz_backup_dupe_quoted_projects_20260811
    (like public.cportal_projects including all);
  alter table public.zz_backup_dupe_quoted_projects_20260811 enable row level security;
  insert into public.zz_backup_dupe_quoted_projects_20260811
    select p.* from public.cportal_projects p
    join dupe_pairs d on d.quoted_id = p.id
    on conflict (id) do nothing;

  -- Files: move to the survivor unless it already has the same SharePoint
  -- item (both writers stamp sharepoint_source_id); leftovers are those
  -- exact duplicates and can go.
  update public.cportal_files f
     set project_id = d.zoho_id
    from dupe_pairs d
   where f.project_id = d.quoted_id
     and not exists (
       select 1 from public.cportal_files g
        where g.project_id = d.zoho_id
          and g.sharepoint_source_id = f.sharepoint_source_id
     );
  get diagnostics n = row_count;
  raise notice 'files moved: %', n;
  delete from public.cportal_files f using dupe_pairs d where f.project_id = d.quoted_id;
  get diagnostics n = row_count;
  raise notice 'duplicate files dropped: %', n;

  -- Members: same move-unless-present dance (unique on project_id, user_id).
  update public.cportal_project_members m
     set project_id = d.zoho_id
    from dupe_pairs d
   where m.project_id = d.quoted_id
     and not exists (
       select 1 from public.cportal_project_members x
        where x.project_id = d.zoho_id and x.user_id = m.user_id
     );
  get diagnostics n = row_count;
  raise notice 'members moved: %', n;
  delete from public.cportal_project_members m using dupe_pairs d where m.project_id = d.quoted_id;

  -- Remaining children have no natural dedupe key; plain repoint.
  update public.cportal_invoices          set project_id = d.zoho_id from dupe_pairs d where project_id = d.quoted_id;
  update public.cportal_document_requests set project_id = d.zoho_id from dupe_pairs d where project_id = d.quoted_id;
  update public.cportal_project_notes     set project_id = d.zoho_id from dupe_pairs d where project_id = d.quoted_id;
  update public.cportal_reminders         set project_id = d.zoho_id from dupe_pairs d where project_id = d.quoted_id;
  update public.cportal_note_mentions     set project_id = d.zoho_id from dupe_pairs d where project_id = d.quoted_id;

  -- Survivor keeps the proposal-era start date (claim-pass convention).
  update public.cportal_projects p
     set started_on = d.quoted_started,
         updated_at = now()
    from dupe_pairs d
   where p.id = d.zoho_id
     and d.quoted_started is not null
     and (p.started_on is null or d.quoted_started < p.started_on);
  get diagnostics n = row_count;
  raise notice 'started_on backdated to proposal date: %', n;

  delete from public.cportal_projects p using dupe_pairs d where p.id = d.quoted_id;
  get diagnostics n = row_count;
  raise notice 'duplicate quoted rows deleted: %', n;
end $$;
