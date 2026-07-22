-- Multi-contact access via company_name match.
--
-- Zoho stores each person at a company as a separate cportal_customers
-- row (not as a contact_persons array nested in one row). So Konecranes
-- might have 3 customer rows, each with a different email. A project
-- billed to row #1 isn't reachable by the email on row #2 today —
-- meaning people at the same company can't all see the same data.
--
-- Fix: any customer/project/invoice belonging to a company is visible
-- to anyone whose email appears on ANY customer row at that company.
-- Implemented as a SECURITY DEFINER helper so the lookup bypasses RLS
-- on cportal_customers and avoids recursion.

create or replace function public.cportal_company_peer_customer_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, auth
as $func$
  -- All cportal_customers rows whose company matches the company of any
  -- cportal_customers row whose email is the caller's JWT email.
  select c.id
  from public.cportal_customers c
  where c.company is not null
    and trim(c.company) != ''
    and lower(trim(c.company)) in (
      select lower(trim(c2.company))
      from public.cportal_customers c2
      where c2.company is not null
        and trim(c2.company) != ''
        and lower(c2.email) = lower(auth.jwt() ->> 'email')
    )
$func$;

-- Add company-peer access to cportal_customers_select.
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
    or id in (select public.cportal_company_peer_customer_ids())
  );

-- Same for invoices.
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
    or customer_id in (select public.cportal_company_peer_customer_ids())
  );

-- Same inside cportal_can_access_project (covers projects + files).
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
    or exists (
      select 1 from public.cportal_projects p
      where p.id = pid
        and p.customer_id in (select public.cportal_company_peer_customer_ids())
    )
$func$;
