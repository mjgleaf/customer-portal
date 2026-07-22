-- Multi-contact-per-customer feature.
--
-- Lets us track several people at each customer company (admin, PM,
-- billing, site contact, etc.). Pulls from Zoho's contact_persons array
-- via sync-zoho; admins can also add manual entries from the Customer
-- Detail page. Any matching email grants the matching user access to the
-- customer's projects, invoices, and files (same RLS path as the
-- customer's primary email today).

create table if not exists public.cportal_customer_contacts (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.cportal_customers(id) on delete cascade,
  name        text,
  email       text not null,
  role        text,                                              -- 'admin' / 'pm' / 'billing' / 'site' / 'other'
  phone       text,
  source      text not null default 'manual',                    -- 'zoho' | 'sharepoint' | 'manual'
  zoho_contact_person_id text,                                   -- so sync can diff/delete
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Case-insensitive uniqueness per (customer, email). Postgres needs this
-- as a functional unique index because UNIQUE constraints don't support
-- expressions.
create unique index if not exists cportal_customer_contacts_unique_email
  on public.cportal_customer_contacts (customer_id, lower(email));

-- Fast lookup by email (used by the cportal_can_access_project check below).
create index if not exists cportal_customer_contacts_email_idx
  on public.cportal_customer_contacts (lower(email));

-- Sync diff helper: each Zoho contact_person row has a stable id.
create unique index if not exists cportal_customer_contacts_zoho_id_unique
  on public.cportal_customer_contacts (zoho_contact_person_id)
  where zoho_contact_person_id is not null;

alter table public.cportal_customer_contacts enable row level security;

-- Admins manage everything. Team members (admins + service techs) can read
-- so the directory is useful in the field. A logged-in user can also read
-- the contact rows for their own company — meaning if my email matches a
-- contact, I can see the other contacts at my company too.
drop policy if exists "cportal_customer_contacts_select" on public.cportal_customer_contacts;
create policy "cportal_customer_contacts_select" on public.cportal_customer_contacts
  for select to public
  using (
    public.cportal_is_admin()
    or public.cportal_is_team_member()
    or exists (
      select 1 from public.cportal_customer_contacts cc2
      where cc2.customer_id = cportal_customer_contacts.customer_id
        and lower(cc2.email) = lower(auth.jwt() ->> 'email')
    )
    or exists (
      select 1 from public.cportal_customers c
      where c.id = cportal_customer_contacts.customer_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
  );

drop policy if exists "cportal_customer_contacts_write" on public.cportal_customer_contacts;
create policy "cportal_customer_contacts_write" on public.cportal_customer_contacts
  for all to authenticated
  using (public.cportal_is_admin())
  with check (public.cportal_is_admin());

-- ---------- Wire the new table into cportal_can_access_project --------
-- Replace the existing function so that any matching contact email grants
-- the same access the customer's primary email already grants. Keep all
-- the existing checks (admin, service tech on Service jobs, project
-- members, primary customer email) so nothing currently working breaks.
create or replace function public.cportal_can_access_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    public.cportal_is_admin()
    or (
      exists (
        select 1 from public.cportal_profiles
        where id = auth.uid() and role = 'service_tech'
      )
      and exists (
        select 1 from public.cportal_projects
        where id = pid and project_type = 'Service'
      )
    )
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
    or exists (
      select 1 from public.cportal_projects p
      join public.cportal_customer_contacts cc on cc.customer_id = p.customer_id
      where p.id = pid
        and lower(cc.email) = lower(auth.jwt() ->> 'email')
    )
$$;

-- ---------- And extend cportal_customers SELECT + cportal_invoices SELECT
-- Customers table: any matching contact email also gets to see the
-- customer row (without that you'd see your projects but not the company
-- name/address they belong to).
drop policy if exists "cportal_customers_select" on public.cportal_customers;
create policy "cportal_customers_select" on public.cportal_customers
  for select to public
  using (
    public.cportal_is_admin()
    or exists (
      select 1 from public.cportal_profiles
      where id = auth.uid() and role = 'service_tech'
    )
    or lower(email) = lower(auth.jwt() ->> 'email')
    or exists (
      select 1 from public.cportal_customer_contacts cc
      where cc.customer_id = cportal_customers.id
        and lower(cc.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- Invoices: same extension.
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
    or exists (
      select 1 from public.cportal_customer_contacts cc
      where cc.customer_id = cportal_invoices.customer_id
        and lower(cc.email) = lower(auth.jwt() ->> 'email')
    )
  );
