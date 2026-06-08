-- Parity fixes after the personal→company project migration.
--
-- Brings the destination's cportal_* tables back in line with the schema
-- the frontend + edge functions assume. The consolidation migration that
-- ran during cutover drifted in a few places:
--   * cportal_app_settings was hardcoded as (id, emails_paused) instead
--     of the generic (key, value) shape every caller expects.
--   * cportal_reminders dropped `document_key` and renamed `sent_at`,
--     breaking the "Reminded Xd ago" pill + the send-reminder insert.
--   * cportal_quote_requests dropped `webhook_status`, breaking the
--     Quote Requests admin page + the submit-quote-request update.
--   * Several columns silently lost NOT NULL constraints + defaults.
--   * cportal_invoices SELECT policy lost the project_members fallback
--     so manually-added members can't see invoices.

-- ============================================================
-- 1. cportal_app_settings — restore key/value shape
-- ============================================================
-- Verified before this migration that the existing row was
-- emails_paused=false, so reseeding with 'false' preserves behavior.
drop policy if exists "cportal_app_settings_read"  on public.cportal_app_settings;
drop policy if exists "cportal_app_settings_write" on public.cportal_app_settings;
drop table if exists public.cportal_app_settings cascade;

create table public.cportal_app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.cportal_app_settings enable row level security;

create policy "cportal_app_settings_read" on public.cportal_app_settings
  for select to authenticated using (true);

create policy "cportal_app_settings_write" on public.cportal_app_settings
  for all to authenticated
  using (public.cportal_is_admin())
  with check (public.cportal_is_admin());

insert into public.cportal_app_settings (key, value)
values ('emails_paused', 'false')
on conflict (key) do nothing;

-- ============================================================
-- 2. cportal_reminders — restore document_key + rename to sent_at
-- ============================================================
alter table public.cportal_reminders
  add column if not exists document_key text;

-- Backfill any existing rows (currently zero) from document_label so the
-- NOT NULL add below doesn't fail.
update public.cportal_reminders
   set document_key = document_label
 where document_key is null;

alter table public.cportal_reminders alter column document_key set not null;

-- Match source naming so the frontend's .select('document_key, sent_at')
-- works as-is.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'cportal_reminders'
      and column_name  = 'last_reminded_at'
  ) then
    alter table public.cportal_reminders rename column last_reminded_at to sent_at;
  end if;
end $$;

-- ============================================================
-- 3. cportal_quote_requests — restore webhook_status
-- ============================================================
alter table public.cportal_quote_requests
  add column if not exists webhook_status text;

-- ============================================================
-- 4. Restore NOT NULL + DEFAULT on columns that lost them
-- ============================================================
-- (Audited: no existing rows violate any of these.)

-- files.kind
update public.cportal_files set kind = 'general' where kind is null;
alter table public.cportal_files alter column kind set default 'general';
alter table public.cportal_files alter column kind set not null;
alter table public.cportal_files alter column created_at set not null;

-- po_reviews.concerns
update public.cportal_po_reviews set concerns = '{}'::text[] where concerns is null;
alter table public.cportal_po_reviews alter column concerns set default '{}'::text[];
alter table public.cportal_po_reviews alter column concerns set not null;
alter table public.cportal_po_reviews alter column reviewed_at set not null;

-- project_notes
alter table public.cportal_project_notes alter column author_id  set not null;
alter table public.cportal_project_notes alter column created_at set not null;
alter table public.cportal_project_notes alter column updated_at set not null;

-- customers / projects
alter table public.cportal_customers alter column zoho_contact_id set not null;
alter table public.cportal_projects  alter column status          set not null;

-- quote_requests timestamps
alter table public.cportal_quote_requests alter column created_at set not null;
alter table public.cportal_quote_requests alter column updated_at set not null;

-- ============================================================
-- 5. cportal_invoices_select — restore project_members fallback
-- ============================================================
-- Source allowed members of the invoice's project to see it. Dest only
-- allowed admin or matching customer email, which silently locks out
-- manually-added project members.
drop policy if exists "cportal_invoices_select" on public.cportal_invoices;
create policy "cportal_invoices_select" on public.cportal_invoices
  for select to public
  using (
    public.cportal_is_admin()
    or exists (
      select 1 from public.cportal_customers c
      where c.id = cportal_invoices.customer_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
    or exists (
      select 1 from public.cportal_project_members pm
      where pm.project_id = cportal_invoices.project_id
        and pm.user_id = auth.uid()
    )
  );
