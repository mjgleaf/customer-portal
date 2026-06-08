-- Team directory + internal notes
--
-- Two additions:
--   1. cportal_profiles.phone — so admins/techs can publish a contact
--      number that other team members can tap-to-call from the Team page.
--   2. cportal_project_notes.internal — boolean flag that hides a note
--      from customers; techs and admins can both write and read these.
--
-- Plus an RLS helper (cportal_is_team_member) and updated SELECT/INSERT
-- policies so the right people see the right rows.

-- ---------- 1. Phone column on profiles ----------
alter table public.cportal_profiles
  add column if not exists phone text;

-- ---------- 2. Team-member helper ----------
-- Returns true if the calling user has role admin or service_tech.
-- security definer + a frozen search_path keeps RLS recursion at bay.
create or replace function public.cportal_is_team_member()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from public.cportal_profiles
    where id = auth.uid()
      and role in ('admin', 'service_tech')
  )
$$;

-- ---------- 3. Profiles SELECT: techs need to see other team members ----------
-- Customers still only see themselves. Team members (admins or techs) can
-- see every other team-member row so they have phone + email to contact
-- each other. Customer profile rows stay private to the customer.
drop policy if exists "cportal_profiles_select" on public.cportal_profiles;
create policy "cportal_profiles_select" on public.cportal_profiles
  for select to public
  using (
    id = auth.uid()
    or public.cportal_is_admin()
    or (public.cportal_is_team_member() and role in ('admin', 'service_tech'))
  );

-- ---------- 4. Internal flag on project_notes ----------
alter table public.cportal_project_notes
  add column if not exists internal boolean not null default false;

-- ---------- 5. Project_notes RLS: hide internal notes from customers ----------
-- A customer sees only non-internal notes on projects they can access.
-- Team members (admins + techs) see every note, internal or not.
drop policy if exists "cportal_project_notes_select" on public.cportal_project_notes;
create policy "cportal_project_notes_select" on public.cportal_project_notes
  for select to authenticated
  using (
    public.cportal_can_access_project(project_id)
    and (not internal or public.cportal_is_team_member())
  );

-- Insert: only team members can mark a note internal.
drop policy if exists "cportal_project_notes_insert" on public.cportal_project_notes;
create policy "cportal_project_notes_insert" on public.cportal_project_notes
  for insert to authenticated
  with check (
    public.cportal_can_access_project(project_id)
    and author_id = auth.uid()
    and (not internal or public.cportal_is_team_member())
  );
