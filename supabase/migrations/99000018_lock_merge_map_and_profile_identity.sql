-- 99000018 — close two cross-tenant holes found in the 2026-11-06 review.
--
-- 1. cportal_merged_zoho_contacts (99000009) was created in the repo without
--    RLS. sync-zoho trusts this table to re-home a Zoho contact's projects and
--    invoices onto `merged_into_customer_id`, so writable rows would let a
--    caller move another company's data onto their own customer record.
--    Production already had RLS on with no anon/authenticated grants (applied
--    out-of-band); this records that state so a rebuild can't reopen it.
--    Only the service role (sync-zoho, merge migrations) uses the table.
--
-- 2. cportal_profiles_update lets a user update every column of their own
--    row; the trigger only blocked `role`. `email` feeds authorization
--    (get-sharepoint-download-url's customer-email match, mention lists), so
--    a customer could set their profile email to another company's address
--    and gain access to its files. Signed-in non-admins may no longer change
--    `email`, `company` or `id`; admins and the service role still can.
--    The role check keeps the live service_role exemption (prod drift that
--    the repo copy in 99000000 never had).
--
-- Idempotent: safe to re-run.

-- ---- 1. merged-contacts map ------------------------------------------------
alter table public.cportal_merged_zoho_contacts enable row level security;
revoke all on public.cportal_merged_zoho_contacts from anon, authenticated;

-- ---- 2. profile identity columns ------------------------------------------
create or replace function public.cportal_prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if new.role is distinct from old.role
     and coalesce(auth.role(), '') != 'service_role'
     and not public.cportal_is_admin() then
    raise exception 'Only admins can change profile role';
  end if;

  -- Identity columns feed access checks; a signed-in non-admin must not be
  -- able to rewrite them.
  if coalesce(auth.role(), '') = 'authenticated'
     and not public.cportal_is_admin()
     and (new.email   is distinct from old.email
       or new.company is distinct from old.company
       or new.id      is distinct from old.id) then
    raise exception 'Only admins can change profile email or company';
  end if;

  return new;
end;
$$;
