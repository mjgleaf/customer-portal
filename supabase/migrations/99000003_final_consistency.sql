-- Final consistency fixes caught by a second-pass audit.
--
--   1. cportal_po_reviews lost the UNIQUE(file_id) constraint during the
--      cutover. The review-po edge function relies on it via
--      `.upsert(..., {onConflict: 'file_id'})` — without it the upsert
--      errors out.
--
--   2. cportal_project_notes.author_id had NOT NULL re-added in the
--      parity fix migration, which conflicts with the table's FK rule
--      (ON DELETE SET NULL on auth.users). Dest's SET NULL is safer
--      than source's CASCADE (deleting a former employee preserves
--      their notes for history), so we drop NOT NULL to make the
--      column consistent with the FK behavior.

alter table public.cportal_po_reviews
  add constraint cportal_po_reviews_file_id_key unique (file_id);

alter table public.cportal_project_notes
  alter column author_id drop not null;
