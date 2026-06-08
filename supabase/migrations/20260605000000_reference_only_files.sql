-- Make storage_path nullable so we can have "reference-only" files in the
-- files table — metadata pointing at a file that lives in SharePoint, with
-- no copy in Supabase Storage. Saves ~1-3 GB of duplicated storage and
-- means SharePoint changes are reflected immediately.
--
-- Pattern:
--   storage_path IS NULL + sharepoint_source_id IS NOT NULL
--     → file is in SharePoint only; download/preview must fetch a fresh
--       Graph URL via the get-sharepoint-download-url edge function.
--   storage_path IS NOT NULL
--     → file is in Supabase Storage (and possibly mirrored to SharePoint).
alter table public.files
  alter column storage_path drop not null;

-- Keep the storage RLS policies sane: a NULL storage_path file is fine,
-- but if a path IS set, it should still be inside the project's folder.
-- (No policy changes needed — the existing path-based check just skips
-- when there's nothing to check.)
