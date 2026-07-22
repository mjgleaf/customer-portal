-- Team page enrichment: surface whether each invited admin / service
-- tech has ever signed in (vs. just been invited and not yet accepted).
-- auth.users.last_sign_in_at isn't reachable via the regular REST query,
-- so wrap the join in a SECURITY DEFINER function.

create or replace function public.cportal_get_team()
returns table (
  id            uuid,
  email         text,
  full_name     text,
  phone         text,
  role          text,
  created_at    timestamptz,
  has_signed_in boolean,
  last_sign_in_at timestamptz
)
language sql
stable
security definer
set search_path = public, auth
as $func$
  select
    p.id,
    p.email,
    p.full_name,
    p.phone,
    p.role,
    p.created_at,
    (u.last_sign_in_at is not null) as has_signed_in,
    u.last_sign_in_at
  from public.cportal_profiles p
  left join auth.users u on u.id = p.id
  where p.role in ('admin', 'service_tech')
    -- Authorization: admin OR existing team member can see the team.
    and (public.cportal_is_admin() or public.cportal_is_team_member())
  order by
    case p.role when 'admin' then 0 else 1 end,
    p.created_at asc
$func$;

-- Anyone authenticated may call the function; the where-clause inside
-- handles whether they get rows back.
grant execute on function public.cportal_get_team() to authenticated;
