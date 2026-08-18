-- Merge customer rows whose company name is the SAME name written differently.
--
-- Background: cportal_customers is keyed 1:1 on zoho_contact_id, and the admin
-- dashboard groups projects by customer_id. So every extra Zoho contact for a
-- company shows up as its own collapsible header — "Hoist & Crane Service
-- Group" appeared three times (two Zoho contacts spelled with "&", one with
-- "and"). 99000009 fixed a batch of these but its group list was hardcoded;
-- this migration derives the groups instead, so it also covers the ones Zoho
-- has spawned since.
--
-- Grouping rule is deliberately conservative: names must be IDENTICAL after
-- normalization (case, punctuation, whitespace, and "and" vs "&"). That is
-- strictly narrower than 99000009's hand-picked prefix groups — it cannot pull
-- "Consolidated Industrial" in with "Consolidated Pipe" the way a prefix match
-- would. Genuinely distinct companies that share an exact name still need a
-- manual call, hence the notices below.
--
-- Per group: survivor = most projects + invoices (tie-break by id), then
-- re-point projects/invoices/contacts, preserve every dying row's email as a
-- contact so no portal access is lost, and record the dying zoho_contact_id in
-- cportal_merged_zoho_contacts so sync-zoho won't recreate it.

-- Shared normalizer. sync-zoho has a TypeScript twin of this (normalizeCompany)
-- for the same purpose at insert time — keep the two in step.
create or replace function public.cportal_normalize_company(raw text)
returns text
language sql
immutable
as $$
  select regexp_replace(
           lower(regexp_replace(coalesce(raw, ''), '(^| )and( |$)', ' & ', 'gi')),
           '[^a-z0-9]', '', 'g'
         )
$$;

comment on function public.cportal_normalize_company(text) is
  'Normalizes a company name for duplicate detection: lowercased, "and" folded to "&", all non-alphanumerics stripped. Mirrored in sync-zoho as normalizeCompany().';

do $migrate$
declare
  grp        record;
  primary_id uuid;
  dupe_row   record;
  merged     int := 0;
  groups     int := 0;
begin
  for grp in
    select public.cportal_normalize_company(
             coalesce(nullif(trim(company), ''), name)
           ) as norm,
           array_agg(id) as ids
      from public.cportal_customers
     where public.cportal_normalize_company(
             coalesce(nullif(trim(company), ''), name)
           ) <> ''
     group by 1
    having count(*) > 1
  loop
    -- Survivor: the row carrying the most portal data. Same rule as 99000009.
    select c.id
      into primary_id
      from public.cportal_customers c
     where c.id = any(grp.ids)
     order by (
       (select count(*) from public.cportal_projects p where p.customer_id = c.id) +
       (select count(*) from public.cportal_invoices i where i.customer_id = c.id)
     ) desc, c.id asc
     limit 1;

    groups := groups + 1;
    raise notice 'Group "%": survivor %, folding in % row(s)',
      grp.norm, primary_id, array_length(grp.ids, 1) - 1;

    for dupe_row in
      select * from public.cportal_customers
       where id = any(grp.ids) and id <> primary_id
    loop
      -- Fill in contact details the survivor is missing.
      update public.cportal_customers c
         set email = coalesce(nullif(trim(c.email), ''), dupe_row.email),
             phone = coalesce(c.phone, dupe_row.phone)
       where c.id = primary_id;

      -- Re-point everything that references the dying row.
      update public.cportal_projects set customer_id = primary_id where customer_id = dupe_row.id;
      update public.cportal_invoices set customer_id = primary_id where customer_id = dupe_row.id;

      insert into public.cportal_customer_contacts
        (customer_id, name, email, role, phone, source)
      select primary_id, name, email, role, phone, source
        from public.cportal_customer_contacts where customer_id = dupe_row.id
      on conflict (customer_id, email) do nothing;
      delete from public.cportal_customer_contacts where customer_id = dupe_row.id;

      -- Keep the dying row's own email as a contact — it may be what grants
      -- someone portal access (RLS matches customers by Zoho contact email).
      if dupe_row.email is not null and trim(dupe_row.email) != '' then
        insert into public.cportal_customer_contacts
          (customer_id, name, email, role, phone, source)
        values (
          primary_id, dupe_row.name, lower(trim(dupe_row.email)),
          'primary', dupe_row.phone, 'zoho'
        )
        on conflict (customer_id, email) do nothing;
      end if;

      -- Earlier merges may point at the row we're about to delete. The FK is
      -- ON DELETE CASCADE, so without this re-point those records vanish and
      -- sync-zoho happily recreates the contacts 99000009 already merged.
      update public.cportal_merged_zoho_contacts
         set merged_into_customer_id = primary_id
       where merged_into_customer_id = dupe_row.id;

      -- Record the merge so the next sync-zoho run skips this Zoho contact.
      if dupe_row.zoho_contact_id is not null then
        insert into public.cportal_merged_zoho_contacts
          (zoho_contact_id, merged_into_customer_id)
        values (dupe_row.zoho_contact_id, primary_id)
        on conflict (zoho_contact_id) do update
          set merged_into_customer_id = excluded.merged_into_customer_id;
      end if;

      delete from public.cportal_customers where id = dupe_row.id;
      merged := merged + 1;
    end loop;
  end loop;

  raise notice 'Merged % duplicate row(s) across % group(s)', merged, groups;
end
$migrate$;
