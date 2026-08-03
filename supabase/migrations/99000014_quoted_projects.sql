-- Pre-award ("quoted") projects.
--
-- Awarded jobs come from Zoho Books, but a job exists as a SharePoint
-- Commercial Proposals folder from the moment it's quoted. The
-- sync-projects-from-sharepoint edge function creates portal projects for
-- those folders with status 'quoted' and no zoho_project_id; when the job is
-- later awarded and appears in Zoho, sync-zoho claims the row by job code
-- (sets zoho_project_id, flips status) instead of inserting a duplicate.

alter table public.cportal_projects
  drop constraint if exists cportal_projects_status_check;
alter table public.cportal_projects
  add constraint cportal_projects_status_check
  check (status in ('active', 'completed', 'on-hold', 'quoted'));
