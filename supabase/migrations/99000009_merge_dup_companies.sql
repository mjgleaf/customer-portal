-- Merge near-duplicate customer rows that represent the same company
-- under different name spellings ("Kone Cranes" vs "Konecranes", etc.).
--
-- For each group:
--   * Pick the row with the most projects + invoices as the survivor.
--   * Re-point projects, invoices, and contacts at the survivor.
--   * Preserve each dying row's email as a contact on the survivor so
--     no portal access is lost.
--   * Record the dying row's Zoho contact id so the next sync-zoho run
--     won't recreate it from Zoho.

create table if not exists public.cportal_merged_zoho_contacts (
  zoho_contact_id         text primary key,
  merged_into_customer_id uuid not null references public.cportal_customers(id) on delete cascade,
  merged_at               timestamptz not null default now()
);

do $migrate$
declare
  -- Each group is the explicit set of normalized (lowercase,
  -- alpha-numeric-only) company-name spellings that all refer to the
  -- SAME company. We match on exact membership in the group rather than
  -- a single truncated prefix, so every known spelling variant is
  -- caught — e.g. "Kone Crane" AND "Konecranes" both normalize into the
  -- Konecranes group. Consolidated is intentionally NOT here (the two
  -- Consolidated rows are different companies). The "judgment-call"
  -- groups (Atlas Copco, Mazzella, Primoris, Axess, Overland, Alltech)
  -- are intentionally left out pending confirmation.
  groups jsonb := '[
    ["konecranes", "konecrane"],
    ["cranetechinc", "cranetech"],
    ["versabarinc", "versabar"],
    ["ebicranesllc", "ebicranes"],
    ["deshazoinc", "deshazo"],
    ["geda", "gedausa"],
    ["relyonnutecusallc", "relyonnutec"],
    ["msrc", "marinespillresponsecorporation"],
    ["2isllc", "2isus"]
  ]'::jsonb;
  grp          jsonb;
  names        text[];
  ids          uuid[];
  primary_id   uuid;
  dupe         uuid;
  dupe_row     record;
begin
  for grp in select * from jsonb_array_elements(groups) loop
    names := array(select jsonb_array_elements_text(grp));

    -- Gather all customer ids whose normalized name is in this group.
    select array_agg(id)
      into ids
    from public.cportal_customers
    where lower(regexp_replace(trim(company), '[^a-zA-Z0-9]', '', 'g')) = any(names);

    if ids is null or array_length(ids, 1) < 2 then
      raise notice 'Group "%": <2 rows, skipping', names[1];
      continue;
    end if;

    -- Pick the survivor: most projects + invoices wins. Tie-break by id.
    select c.id
      into primary_id
    from public.cportal_customers c
    where c.id = any(ids)
    order by (
      (select count(*) from public.cportal_projects p where p.customer_id = c.id) +
      (select count(*) from public.cportal_invoices i where i.customer_id = c.id)
    ) desc, c.id asc
    limit 1;

    raise notice 'Group "%": survivor %, merging % rows', names[1], primary_id, array_length(ids, 1) - 1;

    -- Loop through the duplicates and fold each into the survivor.
    for dupe in
      select unnest(ids) as id
      except
      select primary_id
    loop
      select * into dupe_row from public.cportal_customers where id = dupe;

      -- Promote dupe's email to survivor if survivor lacks one.
      update public.cportal_customers c
         set email = dupe_row.email,
             phone = coalesce(c.phone, dupe_row.phone)
       where c.id = primary_id
         and (c.email is null or trim(c.email) = '')
         and dupe_row.email is not null
         and trim(dupe_row.email) != '';

      -- Re-point any data referenced by FK on customer_id.
      update public.cportal_projects set customer_id = primary_id where customer_id = dupe;
      update public.cportal_invoices set customer_id = primary_id where customer_id = dupe;

      -- Move customer_contacts (skip dupes by email).
      insert into public.cportal_customer_contacts
        (customer_id, name, email, role, phone, source)
      select primary_id, name, email, role, phone, source
        from public.cportal_customer_contacts where customer_id = dupe
      on conflict (customer_id, email) do nothing;
      delete from public.cportal_customer_contacts where customer_id = dupe;

      -- Preserve dupe's primary email as a contact on survivor.
      if dupe_row.email is not null and trim(dupe_row.email) != '' then
        insert into public.cportal_customer_contacts
          (customer_id, name, email, role, phone, source)
        values (
          primary_id, dupe_row.name, lower(trim(dupe_row.email)),
          'primary', dupe_row.phone, 'zoho'
        )
        on conflict (customer_id, email) do nothing;
      end if;

      -- Record the merge so sync-zoho won't recreate this row.
      if dupe_row.zoho_contact_id is not null then
        insert into public.cportal_merged_zoho_contacts
          (zoho_contact_id, merged_into_customer_id)
        values (dupe_row.zoho_contact_id, primary_id)
        on conflict (zoho_contact_id) do update
          set merged_into_customer_id = excluded.merged_into_customer_id;
      end if;

      delete from public.cportal_customers where id = dupe;
    end loop;
  end loop;
end
$migrate$;
