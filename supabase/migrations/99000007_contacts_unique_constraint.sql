-- The functional unique index on (customer_id, lower(email)) handles
-- case-insensitive dedup, but Supabase upsert's onConflict can only
-- match a named unique constraint with literal columns. Replace it
-- with a regular UNIQUE (customer_id, email) constraint — we always
-- insert lowercased emails, so the behavior is identical.

-- Normalize any existing rows (safety net for future re-runs).
update public.cportal_customer_contacts set email = lower(email);

drop index if exists public.cportal_customer_contacts_unique_email;

alter table public.cportal_customer_contacts
  add constraint cportal_customer_contacts_customer_email_unique
  unique (customer_id, email);
