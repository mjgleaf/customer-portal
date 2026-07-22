-- Account status for the Customers list: distinguish "invited but hasn't
-- accepted yet" from "signed in / has access". auth.users.last_sign_in_at
-- isn't reachable from the normal REST query, so wrap the join in a
-- SECURITY DEFINER function (same pattern as cportal_get_team). Admin-only —
-- the WHERE clause returns no rows to non-admins.
-- Drop first: Postgres won't let CREATE OR REPLACE change a function's
-- return columns, so re-running an earlier (email-only) version would fail.
drop function if exists public.cportal_account_status();

create function public.cportal_account_status()
returns table (id uuid, email text, has_signed_in boolean)
language sql
stable
security definer
set search_path = public, auth
as $$
  select p.id, lower(p.email), (u.last_sign_in_at is not null)
  from public.cportal_profiles p
  left join auth.users u on u.id = p.id
  where public.cportal_is_admin();
$$;

grant execute on function public.cportal_account_status() to authenticated;
