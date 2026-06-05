-- Track each PO file's SharePoint sync status so the UI can show
-- "Saved to SharePoint" / "Sync failed" badges per file row.
alter table public.files
  add column if not exists sharepoint_synced_at timestamptz,
  add column if not exists sharepoint_path      text,
  add column if not exists sharepoint_error     text;

-- Quick lookup of failed/missing PO syncs (admin operational view).
create index if not exists files_sharepoint_status_idx
  on public.files (sharepoint_synced_at, sharepoint_error)
  where kind = 'purchase_order';
