-- When a file is synced from SharePoint, we want to remember when it was
-- originally added to OneDrive — not when our sync happened. This column
-- holds the Graph API's createdDateTime for SharePoint-sourced files.
-- Null for files uploaded directly through the portal (use created_at).
alter table public.files
  add column if not exists source_created_at timestamptz;

-- Index for sorting by "real" upload date when the column is present.
create index if not exists files_source_created_idx
  on public.files (project_id, source_created_at desc)
  where source_created_at is not null;
