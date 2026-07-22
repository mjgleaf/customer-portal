-- Fix infinite-recursion error 42P17 in customer_contacts RLS.
--
-- The previous migration (99000004_customer_contacts) had a self-
-- referencing RLS policy on cportal_customer_contacts AND a few other
-- policies that queried cportal_customer_contacts directly. Together
-- they caused Postgres to detect infinite recursion at query plan time
-- and return 500 errors on every query that touched cportal_customers,
-- cportal_invoices, or cportal_projects.
--
-- Fix: wrap the customer_contacts lookup in a SECURITY DEFINER helper
-- function. The helper bypasses RLS on the contacts table when called
-- from inside another policy, breaking the recursion. Same access rules
-- in plain English, no loop in implementation.

-- Helper: returns the set of customer_ids the calling user has access
-- to via a contact email match. Security definer + frozen search_path
-- so RLS on cportal_customer_contacts is bypassed inside.
create or replace function public.cportal_customer_ids_for_caller()
returns setof uuid
language sql
stable
security definer
set search_path = public, auth
as $func$
  select distinct cc.customer_id
  from public.cportal_customer_contacts cc
  where lower(cc.email) = lower(auth.jwt() ->> 'email')
$func$;

-- Drop the self-referencing policy and rewrite with the helper.
drop policy if exists "cportal_customer_contacts_select" on public.cportal_customer_contacts;
create policy "cportal_customer_contacts_select" on public.cportal_customer_contacts
  for select to public
  using (
    public.cportal_is_admin()
    or public.cportal_is_team_member()
    or customer_id in (select public.cportal_customer_ids_for_caller())
    or exists (
      select 1 from public.cportal_customers c
      where c.id = cportal_customer_contacts.customer_id
        and lower(c.email) = lower(auth.jwt() ->> 'email')
    )
  );

-- Swap the inline customer_contacts EXISTS in cportal_customers_select
-- for the helper call.
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
    or id in (select public.cportal_customer_ids_for_caller())
  );

-- Same swap for cportal_invoices_select.
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
    or customer_id in (select public.cportal_customer_ids_for_caller())
  );

-- Same swap inside cportal_can_access_project (used by projects + files).
create or replace function public.cportal_can_access_project(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $func$
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
      where p.id = pid
        and p.customer_id in (select public.cportal_customer_ids_for_caller())
    )
$func$;
