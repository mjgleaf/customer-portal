## Database migrations

This folder is the **version-controlled source-of-truth** for the customer portal's Supabase database schema. Before today's baseline was written, the schema only existed inside the live Supabase database — drift between production and code was impossible to detect or audit. From here forward, every database change should land as a new file in this folder.

### File naming

`YYYYMMDDHHMMSS_short_description.sql` — Supabase CLI convention. Files are applied in lexicographic order, so the timestamp prefix establishes the order.

For example:
- `20260603000000_baseline.sql` ← captures everything as of 2026-06-03
- `20260615120000_add_quote_request_priority_column.sql` ← a future, narrowly-scoped change
- `20260620090000_dedupe_some_table.sql` ← another future change

### How to apply

You have two options:

**1. Via the Supabase Dashboard SQL Editor** (matches the workflow you've been using)
- Open the SQL Editor → New query → paste the file contents → Run.
- This is fine for one-off changes; just remember the file in this folder is what should "win" if production and the file disagree.

**2. Via the Supabase CLI** (recommended for new changes once set up)
- `supabase link --project-ref vpdcikiyaifppkkantrb` (one-time setup, needs the database password — different from your CLI access token; available in Supabase Dashboard → Project Settings → Database).
- `supabase db push` applies any new migration files that haven't been applied yet.

### Adding a new migration

When you want to change the schema:
1. Decide what you want to change (add a column, write a new policy, etc.).
2. Create a new file named `YYYYMMDDHHMMSS_<description>.sql` — easiest way is `Get-Date -Format yyyyMMddHHmmss` in PowerShell, then append the description.
3. Write idempotent SQL where possible (`drop ... if exists`, `create ... if not exists`, etc.) so the file can be safely re-applied.
4. Apply it (via dashboard or CLI).
5. Commit the file to git.

### What the baseline covers

`20260603000000_baseline.sql` captures the production state as of 2026-06-03, including:

- 4 helper functions: `is_admin`, `can_access_project`, `handle_new_user`, `prevent_role_escalation`
- 2 triggers: `on_auth_user_created` (on `auth.users`), `prevent_role_escalation_trigger` (on `public.profiles`)
- 11 application tables: `app_settings`, `customers`, `document_requests`, `files`, `invoices`, `profiles`, `project_members`, `project_notes`, `projects`, `quote_requests`, `reminders`
- 36 row-level security policies across the `public` and `storage` schemas
- 2 storage buckets: `project-files`, `quote-attachments`

Function bodies, trigger definitions, and policy expressions were extracted **verbatim from production** via the Supabase Management API (not reconstructed from memory), so they match what's currently running.

### What's NOT captured here

- Edge functions (live under `supabase/functions/`, deployed separately)
- Supabase Auth configuration (managed in the Dashboard)
- Secrets like `MAIL_SENDER`, `POWER_AUTOMATE_RFQ_WEBHOOK_URL`, the Graph credentials (set via `supabase secrets set`)
- The pg_cron schedule that runs `sync-zoho` and `sync-leads` hourly (lives in `cron.job`, see project memory notes)
- Microsoft 365 / Azure side configuration (app registration permissions, Application Access Policy, mailbox setup)
