-- ============================================================================
-- Customer Portal — Database Baseline (captured 2026-06-03)
-- ============================================================================
-- Source-of-truth for the schema in production at the moment this file was
-- written. Recreates the full database from scratch on a fresh Supabase
-- project (auth schema is provisioned automatically by Supabase).
--
-- Function bodies, trigger definitions, and policy expressions were pulled
-- VERBATIM from production via the Management API (pg_get_functiondef,
-- pg_get_triggerdef, and pg_policies) — not reconstructed from memory.
--
-- Order matters here: helper functions before tables (so policy expressions
-- can reference them), tables before triggers/policies, storage at the end.
-- ============================================================================


-- ============================================================================
-- 1. Helper functions (used by RLS policies)
-- ============================================================================

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  )
$$;

create or replace function public.can_access_project(pid uuid)
returns boolean
language sql
stable
security definer
as $$
  select
    public.is_admin()
    or exists (
      select 1 from public.project_members pm
      where pm.project_id = pid and pm.user_id = auth.uid()
    )
    or exists (
      select 1 from public.projects pr
      join public.customers c on c.id = pr.customer_id
      where pr.id = pid
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
$$;

-- Auto-create a profiles row whenever a new Supabase Auth user is created.
-- Pulls full_name from the Auth admin invite metadata if present.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data ->> 'full_name');
  return new;
end;
$$;

-- Block non-admins from changing their own role to 'admin' on update.
-- RLS WITH CHECK can't compare OLD vs NEW, so we use a BEFORE UPDATE trigger.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Only admins can change a profile role'
      using errcode = '42501';  -- insufficient_privilege
  end if;
  return new;
end;
$$;


-- ============================================================================
-- 2. Tables (dependency order)
-- ============================================================================

-- profiles: shadow table for auth.users; default role is 'customer'.
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text,
  full_name           text,
  company             text,
  role                text not null default 'customer',
  email_notifications boolean default true,
  created_at          timestamptz default now()
);

-- customers: synced from Zoho Books contacts (contact_type='customer' only).
create table if not exists public.customers (
  id              uuid primary key default gen_random_uuid(),
  zoho_contact_id text not null unique,
  name            text,
  email           text,
  company         text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- projects: synced from Zoho Books projects, linked to a customer.
create table if not exists public.projects (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  description     text,
  status          text not null default 'active',
  created_at      timestamptz default now(),
  updated_at      timestamptz default now(),
  zoho_project_id text,
  customer_id     uuid references public.customers(id) on delete set null,
  started_on      timestamptz,
  lead_comments   text
);

-- project_members: explicit membership for customer-side portal users.
create table if not exists public.project_members (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz default now(),
  constraint project_members_project_user_unique unique (project_id, user_id)
);

-- document_requests: admin-defined required documents per project.
create table if not exists public.document_requests (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  label      text not null,
  created_at timestamptz default now()
);

-- files: uploaded documents (POs, drawings, certificates, generic).
-- storage_path is the path inside the 'project-files' bucket. First folder
-- segment is the project UUID, enforced by the storage RLS policies.
create table if not exists public.files (
  id                  uuid primary key default gen_random_uuid(),
  project_id          uuid not null references public.projects(id) on delete cascade,
  name                text not null,
  storage_path        text not null,
  size                bigint,
  mime_type           text,
  uploaded_by         uuid references auth.users(id) on delete set null,
  created_at          timestamptz default now(),
  kind                text not null default 'general',
  document_request_id uuid references public.document_requests(id) on delete set null,
  retest_due          date
);

-- invoices: synced from Zoho Books, linked to a customer + optionally a project.
create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),
  zoho_invoice_id text not null unique,
  customer_id     uuid references public.customers(id) on delete set null,
  project_id      uuid references public.projects(id) on delete set null,
  invoice_number  text,
  status          text,
  total           numeric,
  balance         numeric,
  currency_code   text,
  invoice_date    date,
  due_date        date,
  created_at      timestamptz default now()
);

-- app_settings: simple key/value store for runtime config (e.g. kill switch).
create table if not exists public.app_settings (
  key        text not null primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- reminders: admin-action log used to show "Reminded Xd ago" in the UI.
create table if not exists public.reminders (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  document_key   text not null,
  document_label text not null,
  sent_at        timestamptz not null default now(),
  sent_by        uuid references auth.users(id) on delete set null
);

create index if not exists reminders_project_doc_idx
  on public.reminders (project_id, document_key, sent_at desc);

-- quote_requests: customer-submitted RFQs from the in-portal form.
create table if not exists public.quote_requests (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete set null,
  name             text not null,
  company          text,
  phone            text,
  email            text not null,
  address          text,
  city             text,
  state            text,
  zip              text,
  request_types    text[] not null default '{}'::text[],
  comments         text not null,
  attachment_paths text[] not null default '{}'::text[],
  status           text not null default 'new'
    check (status in ('new', 'in_review', 'quoted', 'closed')),
  admin_notes      text,
  webhook_status   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists quote_requests_user_idx
  on public.quote_requests (user_id, created_at desc);
create index if not exists quote_requests_status_idx
  on public.quote_requests (status, created_at desc);

-- project_notes: shared per-project comment thread, customer + admin.
create table if not exists public.project_notes (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  author_id  uuid not null references auth.users(id) on delete cascade,
  content    text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_notes_project_idx
  on public.project_notes (project_id, created_at desc);


-- ============================================================================
-- 3. Triggers
-- ============================================================================

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop trigger if exists prevent_role_escalation_trigger on public.profiles;
create trigger prevent_role_escalation_trigger
  before update on public.profiles
  for each row execute function public.prevent_role_escalation();


-- ============================================================================
-- 4. Row-Level Security: enable + policies (extracted verbatim from prod)
-- ============================================================================

alter table public.app_settings       enable row level security;
alter table public.customers          enable row level security;
alter table public.document_requests  enable row level security;
alter table public.files              enable row level security;
alter table public.invoices           enable row level security;
alter table public.profiles           enable row level security;
alter table public.project_members    enable row level security;
alter table public.project_notes      enable row level security;
alter table public.projects           enable row level security;
alter table public.quote_requests     enable row level security;
alter table public.reminders          enable row level security;

-- ---- app_settings ----------------------------------------------------------
drop policy if exists "Read app_settings" on public.app_settings;
create policy "Read app_settings" on public.app_settings
  for select to authenticated using (true);

drop policy if exists "Admins write app_settings" on public.app_settings;
create policy "Admins write app_settings" on public.app_settings
  for all to authenticated using (is_admin()) with check (is_admin());

-- ---- customers -------------------------------------------------------------
drop policy if exists "customers_select" on public.customers;
create policy "customers_select" on public.customers
  for select to public
  using (is_admin() or (lower(email) = lower(auth.jwt() ->> 'email')));

-- ---- document_requests -----------------------------------------------------
drop policy if exists "docreq_select" on public.document_requests;
create policy "docreq_select" on public.document_requests
  for select to public using (can_access_project(project_id));

drop policy if exists "docreq_insert" on public.document_requests;
create policy "docreq_insert" on public.document_requests
  for insert to public with check (is_admin());

drop policy if exists "docreq_update" on public.document_requests;
create policy "docreq_update" on public.document_requests
  for update to public using (is_admin());

drop policy if exists "docreq_delete" on public.document_requests;
create policy "docreq_delete" on public.document_requests
  for delete to public using (is_admin());

-- ---- files -----------------------------------------------------------------
drop policy if exists "files_select" on public.files;
create policy "files_select" on public.files
  for select to public using (can_access_project(project_id));

drop policy if exists "files_insert" on public.files;
create policy "files_insert" on public.files
  for insert to public with check (can_access_project(project_id));

drop policy if exists "files_update" on public.files;
create policy "files_update" on public.files
  for update to public using (is_admin()) with check (is_admin());

drop policy if exists "files_delete" on public.files;
create policy "files_delete" on public.files
  for delete to public
  using (is_admin() or (uploaded_by = auth.uid() and can_access_project(project_id)));

-- ---- invoices --------------------------------------------------------------
drop policy if exists "invoices_select" on public.invoices;
create policy "invoices_select" on public.invoices
  for select to public
  using (
    is_admin()
    or exists (
      select 1 from public.customers c
      where c.id = invoices.customer_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
    or exists (
      select 1 from public.project_members pm
      where pm.project_id = invoices.project_id
        and pm.user_id = auth.uid()
    )
  );

-- ---- profiles --------------------------------------------------------------
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to public using ((auth.uid() = id) or is_admin());

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update to authenticated
  using ((auth.uid() = id) or is_admin())
  with check ((auth.uid() = id) or is_admin());

-- ---- project_members -------------------------------------------------------
drop policy if exists "members_select" on public.project_members;
create policy "members_select" on public.project_members
  for select to public using ((user_id = auth.uid()) or is_admin());

drop policy if exists "members_insert" on public.project_members;
create policy "members_insert" on public.project_members
  for insert to public with check (is_admin());

drop policy if exists "members_delete" on public.project_members;
create policy "members_delete" on public.project_members
  for delete to public using (is_admin());

-- ---- project_notes ---------------------------------------------------------
drop policy if exists "project_notes_select" on public.project_notes;
create policy "project_notes_select" on public.project_notes
  for select to authenticated using (can_access_project(project_id));

drop policy if exists "project_notes_insert" on public.project_notes;
create policy "project_notes_insert" on public.project_notes
  for insert to authenticated
  with check (can_access_project(project_id) and author_id = auth.uid());

drop policy if exists "project_notes_update" on public.project_notes;
create policy "project_notes_update" on public.project_notes
  for update to authenticated using ((author_id = auth.uid()) or is_admin());

drop policy if exists "project_notes_delete" on public.project_notes;
create policy "project_notes_delete" on public.project_notes
  for delete to authenticated using ((author_id = auth.uid()) or is_admin());

-- ---- projects --------------------------------------------------------------
drop policy if exists "projects_select" on public.projects;
create policy "projects_select" on public.projects
  for select to public
  using (
    is_admin()
    or exists (
      select 1 from public.project_members
      where project_members.project_id = projects.id
        and project_members.user_id = auth.uid()
    )
    or exists (
      select 1 from public.customers c
      where c.id = projects.customer_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
  );

drop policy if exists "projects_insert" on public.projects;
create policy "projects_insert" on public.projects
  for insert to public with check (is_admin());

drop policy if exists "projects_update" on public.projects;
create policy "projects_update" on public.projects
  for update to public using (is_admin());

drop policy if exists "projects_delete" on public.projects;
create policy "projects_delete" on public.projects
  for delete to public using (is_admin());

-- ---- quote_requests --------------------------------------------------------
drop policy if exists "quote_requests_select_own_or_admin" on public.quote_requests;
create policy "quote_requests_select_own_or_admin" on public.quote_requests
  for select to authenticated using ((user_id = auth.uid()) or is_admin());

-- Insert via edge function (service-role key bypasses RLS); locking
-- direct-frontend insert to admin-only as defense-in-depth.
drop policy if exists "quote_requests_insert_admin_only" on public.quote_requests;
create policy "quote_requests_insert_admin_only" on public.quote_requests
  for insert to authenticated with check (is_admin());

drop policy if exists "quote_requests_update_admin_only" on public.quote_requests;
create policy "quote_requests_update_admin_only" on public.quote_requests
  for update to authenticated using (is_admin());

-- ---- reminders -------------------------------------------------------------
drop policy if exists "reminders_select_admin" on public.reminders;
create policy "reminders_select_admin" on public.reminders
  for select to authenticated using (is_admin());

drop policy if exists "reminders_insert_admin" on public.reminders;
create policy "reminders_insert_admin" on public.reminders
  for insert to authenticated with check (is_admin());


-- ============================================================================
-- 5. Storage buckets + policies
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('project-files', 'project-files', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('quote-attachments', 'quote-attachments', false)
on conflict (id) do nothing;

-- project-files: scoped by the first folder of the path (the project UUID).
drop policy if exists "project_files_read"   on storage.objects;
create policy "project_files_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'project-files'
    and public.can_access_project(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "project_files_upload" on storage.objects;
create policy "project_files_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'project-files'
    and public.can_access_project(((storage.foldername(name))[1])::uuid)
  );

drop policy if exists "project_files_delete" on storage.objects;
create policy "project_files_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'project-files'
    and (
      public.is_admin()
      or (owner = auth.uid()
          and public.can_access_project(((storage.foldername(name))[1])::uuid))
    )
  );

-- quote-attachments: scoped per-user-folder (folder = auth.uid()::text).
drop policy if exists "quote_attachments_read"   on storage.objects;
create policy "quote_attachments_read" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'quote-attachments'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_admin()
    )
  );

drop policy if exists "quote_attachments_upload" on storage.objects;
create policy "quote_attachments_upload" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'quote-attachments'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ============================================================================
-- End of baseline.
-- ============================================================================
