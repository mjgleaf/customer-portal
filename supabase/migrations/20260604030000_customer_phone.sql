-- Zoho Books contacts have a phone number, but our customers table didn't
-- track it. Used to auto-fill the Request Quote form so customers don't
-- retype info we already have on file.
alter table public.customers
  add column if not exists phone text;
