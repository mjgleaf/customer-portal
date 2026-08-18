-- Customer PO number recorded manually in the pipeline app.
--
-- The sales pipeline (SharePoint "Lead List", the same list sync-leads
-- already reads for scope / site contact / ship-to) has a PONum column that
-- the team fills in by hand the moment a customer's PO comes in — often long
-- before, or instead of, a PDF ever reaching the portal. Mirroring it here
-- lets the portal show the customer their own PO number, and lets a recorded
-- PO satisfy the "Purchase order — required" checklist item so we stop
-- nagging for a document that may not exist (verbal POs, credit-card jobs).
--
-- po_number is stored VERBATIM, including the ~20% of pipeline values that
-- are notes rather than numbers ("Verbal Jeremy", "CC", "Credit Card"). The
-- frontend decides who sees what: customers only see values containing a
-- digit; admins see everything. Keeping the raw value here means an admin
-- can always tell why a project's PO requirement is satisfied.
--
-- Written only by sync-leads (service role). No RLS change needed — these
-- ride along on cportal_projects, which is already gated by
-- can_access_project().

alter table public.cportal_projects
  add column if not exists po_number text,
  add column if not exists po_date   timestamptz;

comment on column public.cportal_projects.po_number is
  'Customer PO number, mirrored verbatim from SharePoint Lead List.PONum. May be a placeholder note ("Verbal", "CC") rather than a number — admin-only in the UI unless it contains a digit.';
comment on column public.cportal_projects.po_date is
  'Date the PO was received, from SharePoint Lead List.PODate.';
