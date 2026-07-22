-- @mentions in project notes.
--
-- When someone is mentioned in a project note, we record one row here per
-- mentioned person. This drives two things:
--   1. A targeted email ("X mentioned you in a note on Project HWI-…").
--   2. An in-app unread indicator (the red dot) — unread = read_at IS NULL.
--
-- Rows are created by the notify-project-note edge function (service role).
-- Each mentioned user can see and mark-read their own rows.

create table if not exists public.cportal_note_mentions (
  id                uuid primary key default gen_random_uuid(),
  note_id           uuid not null references public.cportal_project_notes(id) on delete cascade,
  project_id        uuid not null references public.cportal_projects(id) on delete cascade,
  mentioned_user_id uuid not null references auth.users(id) on delete cascade,
  created_at        timestamptz not null default now(),
  read_at           timestamptz,
  unique (note_id, mentioned_user_id)
);

-- Fast "do I have unread mentions, and on which projects?" lookups.
create index if not exists cportal_note_mentions_user_unread_idx
  on public.cportal_note_mentions (mentioned_user_id, read_at);
create index if not exists cportal_note_mentions_project_idx
  on public.cportal_note_mentions (project_id);

alter table public.cportal_note_mentions enable row level security;

-- You can read mentions addressed to you; admins can see all.
drop policy if exists cportal_note_mentions_select on public.cportal_note_mentions;
create policy cportal_note_mentions_select on public.cportal_note_mentions
  for select
  using (mentioned_user_id = auth.uid() or public.cportal_is_admin());

-- You can mark your own mentions as read (set read_at). Inserts and deletes
-- are performed only by the service-role edge function, so no policy grants
-- them to ordinary users.
drop policy if exists cportal_note_mentions_update on public.cportal_note_mentions;
create policy cportal_note_mentions_update on public.cportal_note_mentions
  for update
  using (mentioned_user_id = auth.uid())
  with check (mentioned_user_id = auth.uid());

-- Who can be @mentioned on a project: everyone with access to it (all staff,
-- plus the project's members and customer-side contacts who have a portal
-- account). Runs as SECURITY DEFINER so a customer — who normally can't read
-- other people's profiles (profiles RLS = self only) — can still fetch the
-- list of people to tag, but ONLY for a project they can access. Returns no
-- email, just the user id + display name needed to render and record a tag.
create or replace function public.cportal_mentionable_for_project(p_project uuid)
returns table (user_id uuid, display_name text, role text)
language sql
security definer
stable
set search_path = public
as $$
  select p.id,
         coalesce(nullif(btrim(p.full_name), ''), split_part(p.email, '@', 1)) as display_name,
         p.role
  from public.cportal_profiles p
  where public.cportal_can_access_project(p_project)
    and (
      p.role in ('admin', 'service_tech')
      or p.id in (
        select m.user_id from public.cportal_project_members m where m.project_id = p_project
      )
      or lower(p.email) in (
        select lower(c.email)
        from public.cportal_projects pr
        join public.cportal_customers c on c.id = pr.customer_id
        where pr.id = p_project and c.email is not null
        union
        select lower(cc.email)
        from public.cportal_projects pr2
        join public.cportal_customer_contacts cc on cc.customer_id = pr2.customer_id
        where pr2.id = p_project and cc.email is not null
      )
    );
$$;

grant execute on function public.cportal_mentionable_for_project(uuid) to authenticated;
