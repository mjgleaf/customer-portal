-- Notify a Hydro-Wates shared inbox when an invited customer accepts their
-- invitation. "Accepts" = the first time their account's email is confirmed
-- (clicking the invite/signup link sets email_confirmed_at), which is the
-- moment they can actually sign in.
--
-- Mechanism: an AFTER UPDATE trigger on auth.users fires a fire-and-forget
-- HTTP POST (via pg_net) to the notify-invite-accepted edge function, which
-- sends the branded email through our Microsoft Graph pipeline.
--
-- Config lives in Supabase Vault so no URL/secret is hard-coded here. Before
-- this works you must create two vault secrets (Dashboard → Project Settings
-- → Vault, or `select vault.create_secret(...)`):
--   * 'invite_notify_fn_url'  → https://<project-ref>.supabase.co/functions/v1/notify-invite-accepted
--   * 'invite_notify_secret'  → the same value you set as the INVITE_NOTIFY_SECRET
--                               function env var
-- The trigger no-ops quietly if either secret is missing, so it can never
-- block a customer's sign-in.

create extension if not exists pg_net with schema extensions;

create or replace function public.cportal_notify_invite_accepted()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  fn_url text;
  secret text;
begin
  -- Only on the transition to confirmed (acceptance), and only once.
  if new.email_confirmed_at is null or old.email_confirmed_at is not null then
    return new;
  end if;

  begin
    select decrypted_secret into fn_url
      from vault.decrypted_secrets where name = 'invite_notify_fn_url';
    select decrypted_secret into secret
      from vault.decrypted_secrets where name = 'invite_notify_secret';
  exception when others then
    -- Vault unavailable / not set up — skip silently.
    return new;
  end;

  if fn_url is null or secret is null then
    return new;
  end if;

  perform net.http_post(
    url     := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-notify-secret', secret
    ),
    body    := jsonb_build_object(
      'user_id',   new.id,
      'email',     new.email,
      'full_name', new.raw_user_meta_data ->> 'full_name'
    )
  );

  return new;
end;
$$;

drop trigger if exists cportal_on_invite_accepted on auth.users;
create trigger cportal_on_invite_accepted
  after update of email_confirmed_at on auth.users
  for each row
  execute function public.cportal_notify_invite_accepted();
