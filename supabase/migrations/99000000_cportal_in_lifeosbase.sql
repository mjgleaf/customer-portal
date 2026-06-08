-- =============================================================================
-- Customer-portal schema for the LifeOSBase project.
-- All tables, helper functions, and triggers prefixed with `cportal_` so the
-- portal coexists with the destination project's pm_*, shopmaster_*,
-- cashflow_*, and unprefixed root tables without collisions.
--
-- This is a single consolidated migration that replaces the per-day migration
-- files in supabase/migrations/2026*.sql for the destination project.
-- Apply via Supabase SQL editor or the management API.
-- =============================================================================

-- ----- Helper functions -----------------------------------------------------

create or replace function public.cportal_is_admin()
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.cportal_profiles
    where id = auth.uid() and role = 'admin'
  )
$$;

create or replace function public.cportal_can_access_project(pid uuid)
returns boolean
language sql
stable
security definer
as $$
  select
    public.cportal_is_admin()
    or exists (
      select 1 from public.cportal_project_members pm
      where pm.project_id = pid and pm.user_id = auth.uid()
    )
    or exists (
      select 1 from public.cportal_projects p
      left join public.cportal_customers c on c.id = p.customer_id
      where p.id = pid
        and c.email is not null
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
$$;

-- ----- Tables ---------------------------------------------------------------

create table if not exists public.cportal_profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text,
  full_name       text,
  company         text,
  role            text not null default 'customer' check (role in ('customer','admin')),
  created_at      timestamptz default now(),
  email_notifications boolean default true
);

create table if not exists public.cportal_customers (
  id                uuid primary key default gen_random_uuid(),
  zoho_contact_id   text unique,
  name              text,
  email             text,
  company           text,
  phone             text,
  shipping_address  text,
  shipping_city     text,
  shipping_state    text,
  shipping_zip      text,
  shipping_country  text,
  billing_address   text,
  billing_city      text,
  billing_state     text,
  billing_zip       text,
  billing_country   text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists public.cportal_projects (
  id              uuid primary key default gen_random_uuid(),
  zoho_project_id text unique,
  customer_id     uuid references public.cportal_customers(id) on delete set null,
  name            text not null,
  description     text,
  status          text default 'active' check (status in ('active','completed','on-hold')),
  started_on      timestamptz,
  lead_comments   text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists public.cportal_project_members (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.cportal_projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  constraint cportal_project_members_unique unique (project_id, user_id)
);

create table if not exists public.cportal_document_requests (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.cportal_projects(id) on delete cascade,
  label      text not null,
  created_at timestamptz default now()
);

create table if not exists public.cportal_files (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.cportal_projects(id) on delete cascade,
  name                  text not null,
  storage_path          text,                            -- nullable: reference-only files have no portal copy
  size                  bigint,
  mime_type             text,
  uploaded_by           uuid references auth.users(id) on delete set null,
  kind                  text,
  document_request_id   uuid references public.cportal_document_requests(id) on delete set null,
  retest_due            date,
  sharepoint_synced_at  timestamptz,
  sharepoint_path       text,
  sharepoint_error      text,
  sharepoint_source_id  text,
  source_created_at     timestamptz,
  created_at            timestamptz default now()
);

create index if not exists cportal_files_project_idx on public.cportal_files (project_id);
create index if not exists cportal_files_sharepoint_source_idx
  on public.cportal_files (project_id, sharepoint_source_id)
  where sharepoint_source_id is not null;
create index if not exists cportal_files_source_created_idx
  on public.cportal_files (project_id, source_created_at desc)
  where source_created_at is not null;

create table if not exists public.cportal_invoices (
  id              uuid primary key default gen_random_uuid(),
  zoho_invoice_id text unique,
  customer_id     uuid references public.cportal_customers(id) on delete set null,
  project_id      uuid references public.cportal_projects(id) on delete set null,
  invoice_number  text,
  status          text,
  total           numeric,
  balance         numeric,
  currency_code   text,
  invoice_date    date,
  due_date        date,
  created_at      timestamptz default now()
);

create table if not exists public.cportal_quote_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  name              text not null,
  company           text,
  phone             text,
  email             text not null,
  address           text,
  city              text,
  state             text,
  zip               text,
  request_types     text[] not null default '{}',
  comments          text not null,
  attachment_paths  text[] not null default '{}',
  admin_notes       text,
  status            text not null default 'new' check (status in ('new','in_review','quoted','closed')),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

create table if not exists public.cportal_project_notes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.cportal_projects(id) on delete cascade,
  author_id  uuid references auth.users(id) on delete set null,
  content    text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.cportal_reminders (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.cportal_projects(id) on delete cascade,
  document_label  text not null,
  last_reminded_at timestamptz not null default now(),
  sent_by         uuid references auth.users(id) on delete set null
);

create table if not exists public.cportal_po_reviews (
  id                uuid primary key default gen_random_uuid(),
  file_id           uuid not null references public.cportal_files(id) on delete cascade,
  summary           text,
  concerns          text[],
  extracted_fields  jsonb,
  model             text,
  reviewed_at       timestamptz default now(),
  reviewed_by       uuid references auth.users(id) on delete set null
);

create table if not exists public.cportal_app_settings (
  id              int primary key default 1 check (id = 1),
  emails_paused   boolean not null default false,
  updated_at      timestamptz default now()
);
insert into public.cportal_app_settings (id) values (1) on conflict do nothing;

-- ----- Triggers -------------------------------------------------------------

-- Auto-create a cportal_profiles row when a new auth.users row is inserted.
-- Uses a unique trigger name so it coexists with whatever other triggers
-- the destination project's own apps have on auth.users.
create or replace function public.cportal_handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.cportal_profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists cportal_on_auth_user_created on auth.users;
create trigger cportal_on_auth_user_created
  after insert on auth.users
  for each row execute function public.cportal_handle_new_user();

-- Prevent customers from escalating their own role to admin.
create or replace function public.cportal_prevent_role_escalation()
returns trigger
language plpgsql
security definer
as $$
begin
  if new.role is distinct from old.role and not public.cportal_is_admin() then
    raise exception 'Only admins can change profile role';
  end if;
  return new;
end;
$$;

drop trigger if exists cportal_prevent_role_escalation on public.cportal_profiles;
create trigger cportal_prevent_role_escalation
  before update on public.cportal_profiles
  for each row execute function public.cportal_prevent_role_escalation();

-- ----- Row Level Security ---------------------------------------------------

alter table public.cportal_profiles          enable row level security;
alter table public.cportal_customers         enable row level security;
alter table public.cportal_projects          enable row level security;
alter table public.cportal_project_members   enable row level security;
alter table public.cportal_document_requests enable row level security;
alter table public.cportal_files             enable row level security;
alter table public.cportal_invoices          enable row level security;
alter table public.cportal_quote_requests    enable row level security;
alter table public.cportal_project_notes     enable row level security;
alter table public.cportal_reminders         enable row level security;
alter table public.cportal_po_reviews        enable row level security;
alter table public.cportal_app_settings      enable row level security;

-- ---- profiles ----
drop policy if exists "cportal_profiles_select" on public.cportal_profiles;
create policy "cportal_profiles_select" on public.cportal_profiles
  for select to public
  using (id = auth.uid() or public.cportal_is_admin());

drop policy if exists "cportal_profiles_update" on public.cportal_profiles;
create policy "cportal_profiles_update" on public.cportal_profiles
  for update to public
  using (id = auth.uid() or public.cportal_is_admin())
  with check (id = auth.uid() or public.cportal_is_admin());

-- ---- app_settings ----
drop policy if exists "cportal_app_settings_read" on public.cportal_app_settings;
create policy "cportal_app_settings_read" on public.cportal_app_settings
  for select to authenticated using (true);

drop policy if exists "cportal_app_settings_write" on public.cportal_app_settings;
create policy "cportal_app_settings_write" on public.cportal_app_settings
  for all to authenticated using (public.cportal_is_admin()) with check (public.cportal_is_admin());

-- ---- customers ----
drop policy if exists "cportal_customers_select" on public.cportal_customers;
create policy "cportal_customers_select" on public.cportal_customers
  for select to public
  using (public.cportal_is_admin() or (lower(email) = lower(auth.jwt() ->> 'email')));

-- ---- document_requests ----
drop policy if exists "cportal_docreq_select" on public.cportal_document_requests;
create policy "cportal_docreq_select" on public.cportal_document_requests
  for select to public using (public.cportal_can_access_project(project_id));

drop policy if exists "cportal_docreq_insert" on public.cportal_document_requests;
create policy "cportal_docreq_insert" on public.cportal_document_requests
  for insert to public with check (public.cportal_is_admin());

drop policy if exists "cportal_docreq_update" on public.cportal_document_requests;
create policy "cportal_docreq_update" on public.cportal_document_requests
  for update to public using (public.cportal_is_admin());

drop policy if exists "cportal_docreq_delete" on public.cportal_document_requests;
create policy "cportal_docreq_delete" on public.cportal_document_requests
  for delete to public using (public.cportal_is_admin());

-- ---- files ----
drop policy if exists "cportal_files_select" on public.cportal_files;
create policy "cportal_files_select" on public.cportal_files
  for select to public using (public.cportal_can_access_project(project_id));

drop policy if exists "cportal_files_insert" on public.cportal_files;
create policy "cportal_files_insert" on public.cportal_files
  for insert to public with check (public.cportal_can_access_project(project_id));

drop policy if exists "cportal_files_update" on public.cportal_files;
create policy "cportal_files_update" on public.cportal_files
  for update to public using (public.cportal_is_admin()) with check (public.cportal_is_admin());

drop policy if exists "cportal_files_delete" on public.cportal_files;
create policy "cportal_files_delete" on public.cportal_files
  for delete to public
  using (public.cportal_is_admin() or (uploaded_by = auth.uid() and public.cportal_can_access_project(project_id)));

-- ---- invoices ----
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
  );

-- ---- project_members ----
drop policy if exists "cportal_members_select" on public.cportal_project_members;
create policy "cportal_members_select" on public.cportal_project_members
  for select to public using (public.cportal_can_access_project(project_id));

drop policy if exists "cportal_members_insert" on public.cportal_project_members;
create policy "cportal_members_insert" on public.cportal_project_members
  for insert to public with check (public.cportal_is_admin());

drop policy if exists "cportal_members_delete" on public.cportal_project_members;
create policy "cportal_members_delete" on public.cportal_project_members
  for delete to public using (public.cportal_is_admin());

-- ---- project_notes ----
drop policy if exists "cportal_project_notes_select" on public.cportal_project_notes;
create policy "cportal_project_notes_select" on public.cportal_project_notes
  for select to authenticated using (public.cportal_can_access_project(project_id));

drop policy if exists "cportal_project_notes_insert" on public.cportal_project_notes;
create policy "cportal_project_notes_insert" on public.cportal_project_notes
  for insert to authenticated
  with check (public.cportal_can_access_project(project_id) and author_id = auth.uid());

drop policy if exists "cportal_project_notes_update" on public.cportal_project_notes;
create policy "cportal_project_notes_update" on public.cportal_project_notes
  for update to authenticated using ((author_id = auth.uid()) or public.cportal_is_admin());

drop policy if exists "cportal_project_notes_delete" on public.cportal_project_notes;
create policy "cportal_project_notes_delete" on public.cportal_project_notes
  for delete to authenticated using ((author_id = auth.uid()) or public.cportal_is_admin());

-- ---- projects ----
drop policy if exists "cportal_projects_select" on public.cportal_projects;
create policy "cportal_projects_select" on public.cportal_projects
  for select to public using (public.cportal_can_access_project(id));

drop policy if exists "cportal_projects_insert" on public.cportal_projects;
create policy "cportal_projects_insert" on public.cportal_projects
  for insert to public with check (public.cportal_is_admin());

drop policy if exists "cportal_projects_update" on public.cportal_projects;
create policy "cportal_projects_update" on public.cportal_projects
  for update to public using (public.cportal_is_admin());

drop policy if exists "cportal_projects_delete" on public.cportal_projects;
create policy "cportal_projects_delete" on public.cportal_projects
  for delete to public using (public.cportal_is_admin());

-- ---- reminders ----
drop policy if exists "cportal_reminders_select" on public.cportal_reminders;
create policy "cportal_reminders_select" on public.cportal_reminders
  for select to public using (public.cportal_is_admin());

drop policy if exists "cportal_reminders_write" on public.cportal_reminders;
create policy "cportal_reminders_write" on public.cportal_reminders
  for all to public using (public.cportal_is_admin()) with check (public.cportal_is_admin());

-- ---- po_reviews ----
drop policy if exists "cportal_po_reviews_select" on public.cportal_po_reviews;
create policy "cportal_po_reviews_select" on public.cportal_po_reviews
  for select to public using (public.cportal_is_admin());

drop policy if exists "cportal_po_reviews_write" on public.cportal_po_reviews;
create policy "cportal_po_reviews_write" on public.cportal_po_reviews
  for all to public using (public.cportal_is_admin()) with check (public.cportal_is_admin());

-- ---- quote_requests ----
drop policy if exists "cportal_quote_requests_select" on public.cportal_quote_requests;
create policy "cportal_quote_requests_select" on public.cportal_quote_requests
  for select to public using (public.cportal_is_admin() or user_id = auth.uid());

drop policy if exists "cportal_quote_requests_insert" on public.cportal_quote_requests;
create policy "cportal_quote_requests_insert" on public.cportal_quote_requests
  for insert to public with check (user_id = auth.uid());

drop policy if exists "cportal_quote_requests_update" on public.cportal_quote_requests;
create policy "cportal_quote_requests_update" on public.cportal_quote_requests
  for update to public using (public.cportal_is_admin());

-- ----- Storage buckets ------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('cportal-project-files', 'cportal-project-files', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('cportal-quote-attachments', 'cportal-quote-attachments', false)
on conflict (id) do nothing;

-- cportal-project-files: scoped by the first folder of the path (the project UUID).
drop policy if exists "cportal_project_files_read"   on storage.objects;
create policy "cportal_project_files_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'cportal-project-files'
    and public.cportal_can_access_project(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "cportal_project_files_upload" on storage.objects;
create policy "cportal_project_files_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'cportal-project-files'
    and public.cportal_can_access_project(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "cportal_project_files_delete" on storage.objects;
create policy "cportal_project_files_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'cportal-project-files'
    and (
      public.cportal_is_admin()
      or (owner = auth.uid()
          and public.cportal_can_access_project(((storage.foldername(name))[1])::uuid))
    )
  );

-- cportal-quote-attachments: scoped per-user-folder (folder = auth.uid()::text).
drop policy if exists "cportal_quote_attachments_read"   on storage.objects;
create policy "cportal_quote_attachments_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'cportal-quote-attachments'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.cportal_is_admin()
    )
  );

drop policy if exists "cportal_quote_attachments_upload" on storage.objects;
create policy "cportal_quote_attachments_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'cportal-quote-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
