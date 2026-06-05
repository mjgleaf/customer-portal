-- Task #36: AI Purchase Order review.
-- Stores Claude's analysis of each uploaded PO file. One row per file_id
-- (latest review wins on re-analyze). Admin-only via RLS — customers
-- don't see the AI's internal review.

create table if not exists public.po_reviews (
  id                uuid primary key default gen_random_uuid(),
  file_id           uuid not null unique references public.files(id) on delete cascade,
  summary           text,
  concerns          text[] not null default '{}'::text[],
  extracted_fields  jsonb,
  model             text,
  reviewed_at       timestamptz not null default now(),
  reviewed_by       uuid references auth.users(id) on delete set null
);

create index if not exists po_reviews_file_idx
  on public.po_reviews (file_id);

alter table public.po_reviews enable row level security;

drop policy if exists "po_reviews_select_admin" on public.po_reviews;
drop policy if exists "po_reviews_write_admin"  on public.po_reviews;

create policy "po_reviews_select_admin" on public.po_reviews
  for select to authenticated using (public.is_admin());

create policy "po_reviews_write_admin" on public.po_reviews
  for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
