-- Add shipping and billing address columns synced from Zoho Books contacts.
-- These power the "Ship to" display in each project's Certificates tab so
-- Hydro-Wates knows where physical certs/reports should be mailed when
-- shipping out test documentation.

alter table public.customers
  add column if not exists shipping_address text,
  add column if not exists shipping_city    text,
  add column if not exists shipping_state   text,
  add column if not exists shipping_zip     text,
  add column if not exists shipping_country text,
  add column if not exists billing_address  text,
  add column if not exists billing_city     text,
  add column if not exists billing_state    text,
  add column if not exists billing_zip      text,
  add column if not exists billing_country  text;
