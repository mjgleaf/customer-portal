-- Company-wide project access.
--
-- Lets an admin give one person access to ALL of a company's projects — both
-- the projects that exist now (a one-time bulk add) and, optionally, every
-- future project for that company (a standing grant).
--
-- Design: access is delivered through the EXISTING project-membership path
-- (cportal_project_members), which already grants a user a project's files,
-- notes, certificates, and invoices. So there are NO row-level-security
-- policy changes here — we just (a) bulk-insert memberships for current
-- projects, and (b) use a trigger to auto-add memberships for the granted
-- person whenever a new project for that company is created (e.g. by sync-zoho).
--
-- "company_key" is the company name normalized to lowercase alphanumerics, the
-- same basis used elsewhere, so spelling/punctuation differences don't matter.

create table if not exists public.cportal_company_access (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  company_key  text not null,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (user_id, company_key)
);
create index if not exists cportal_company_access_company_idx
  on public.cportal_company_access (company_key);

alter table public.cportal_company_access enable row level security;

-- Admins manage grants; a user may see their own.
drop policy if exists cportal_company_access_select on public.cportal_company_access;
create policy cportal_company_access_select on public.cportal_company_access
  for select using (public.cportal_is_admin() or user_id = auth.uid());
drop policy if exists cportal_company_access_admin on public.cportal_company_access;
create policy cportal_company_access_admin on public.cportal_company_access
  for all using (public.cportal_is_admin()) with check (public.cportal_is_admin());

-- Normalize a company name to a stable matching key.
create or replace function public.cportal_company_key(name text)
returns text language sql immutable
as $$ select lower(regexp_replace(coalesce(name, ''), '[^a-zA-Z0-9]', '', 'g')); $$;

-- New project → auto-add any standing-grant users for that company as members.
create or replace function public.cportal_apply_company_access_to_new_project()
returns trigger language plpgsql security definer
set search_path = public
as $$
declare
  ckey text;
begin
  if new.customer_id is null then return new; end if;
  select cportal_company_key(c.company) into ckey
    from public.cportal_customers c where c.id = new.customer_id;
  if ckey is null or ckey = '' then return new; end if;

  insert into public.cportal_project_members (project_id, user_id)
  select new.id, ca.user_id
    from public.cportal_company_access ca
    where ca.company_key = ckey
  on conflict (project_id, user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists cportal_on_project_insert_company_access on public.cportal_projects;
create trigger cportal_on_project_insert_company_access
  after insert on public.cportal_projects
  for each row execute function public.cportal_apply_company_access_to_new_project();

-- ---- Admin RPCs the portal calls -----------------------------------------

-- Standing grant: record it AND add the user to every CURRENT company project.
create or replace function public.cportal_grant_company_access(p_user uuid, p_company text)
returns void language plpgsql security definer
set search_path = public
as $$
declare ckey text;
begin
  if not public.cportal_is_admin() then raise exception 'admin only'; end if;
  ckey := cportal_company_key(p_company);
  if ckey = '' then raise exception 'empty company'; end if;

  insert into public.cportal_company_access (user_id, company_key, created_by)
  values (p_user, ckey, auth.uid())
  on conflict (user_id, company_key) do nothing;

  insert into public.cportal_project_members (project_id, user_id)
  select pr.id, p_user
    from public.cportal_projects pr
    join public.cportal_customers c on c.id = pr.customer_id
    where cportal_company_key(c.company) = ckey
  on conflict (project_id, user_id) do nothing;
end;
$$;

-- One-time bulk add (no standing grant): add the user to every CURRENT project.
create or replace function public.cportal_add_to_all_company_projects(p_user uuid, p_company text)
returns integer language plpgsql security definer
set search_path = public
as $$
declare ckey text; n integer;
begin
  if not public.cportal_is_admin() then raise exception 'admin only'; end if;
  ckey := cportal_company_key(p_company);
  insert into public.cportal_project_members (project_id, user_id)
  select pr.id, p_user
    from public.cportal_projects pr
    join public.cportal_customers c on c.id = pr.customer_id
    where cportal_company_key(c.company) = ckey
  on conflict (project_id, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Revoke standing access: remove the grant AND the user's memberships on that
-- company's projects.
create or replace function public.cportal_revoke_company_access(p_user uuid, p_company text)
returns void language plpgsql security definer
set search_path = public
as $$
declare ckey text;
begin
  if not public.cportal_is_admin() then raise exception 'admin only'; end if;
  ckey := cportal_company_key(p_company);
  delete from public.cportal_company_access where user_id = p_user and company_key = ckey;
  delete from public.cportal_project_members pm
    using public.cportal_projects pr, public.cportal_customers c
    where pm.project_id = pr.id
      and pr.customer_id = c.id
      and pm.user_id = p_user
      and cportal_company_key(c.company) = ckey;
end;
$$;

grant execute on function public.cportal_company_key(text) to authenticated;
grant execute on function public.cportal_grant_company_access(uuid, text) to authenticated;
grant execute on function public.cportal_add_to_all_company_projects(uuid, text) to authenticated;
grant execute on function public.cportal_revoke_company_access(uuid, text) to authenticated;
