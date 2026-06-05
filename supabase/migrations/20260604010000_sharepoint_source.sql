-- Track files that were pulled FROM SharePoint into the portal (as opposed
-- to uploaded directly through the portal). The SharePoint item ID is the
-- stable, unique identifier we use to dedupe — re-running the sync won't
-- create duplicate rows for the same SharePoint file.
alter table public.files
  add column if not exists sharepoint_source_id text;

-- Quick lookup when checking "have we already synced this SharePoint file?"
create index if not exists files_sharepoint_source_idx
  on public.files (project_id, sharepoint_source_id)
  where sharepoint_source_id is not null;
