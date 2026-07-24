# Customer Portal — Handoff Runbook

> **Audience**: whoever maintains the Hydro-Wates customer portal after Kaylee Kim leaves.
> **Last updated**: 2026-06-04 by Kaylee Kim.
>
> This document is the single source of truth for how the portal works, what
> depends on what, and what to do when something breaks. If you find something
> that's no longer accurate, **fix this file** rather than working around it.

---

## 1. What the portal is

A web application that gives Hydro-Wates customers self-service access to:
- Their projects (HWI-NN-NNN job records)
- Documents the team has shared with them (quotes, purchase orders, certificates)
- Their invoices (synced from Zoho Books)
- A Request-for-Quote form

It also gives Hydro-Wates admins (`role='admin'` on the `profiles` table) a unified workspace for:
- Browsing every project, file, customer, and quote request
- Sending document-reminder emails to customers
- Reviewing AI-extracted Purchase Order details
- Filing customer-emailed POs automatically (via Power Automate)
- Managing project members and notes

## 2. The 10-second mental model

```
                 ┌──────────────────────────┐
                 │ Customers / Admins / PMs │
                 └────────────┬─────────────┘
                              │  HTTPS
                              ▼
                 ┌──────────────────────────┐
                 │   React/Vite frontend    │   ← repo: customer-portal/src
                 │  (deployed to <TBD>)     │
                 └────────────┬─────────────┘
                              │
                              ▼
                 ┌──────────────────────────┐
                 │  Supabase (Postgres +    │   ← repo: customer-portal/supabase
                 │  Auth + Storage + Edge   │
                 │  Functions)              │
                 └────────────┬─────────────┘
                              │
       ┌──────────────┬───────┴──────┬──────────────┬──────────────┐
       ▼              ▼              ▼              ▼              ▼
   Zoho Books   Microsoft Graph   Anthropic    Power Automate    n/a
  (CRM + AR)   (Mail + Files)    (Claude AI)   (email ingest)
```

Everything in the data plane runs in Supabase. Everything in the integration plane is an outbound API call from an edge function. There is no separate Node server.

## 3. Critical "if X breaks" runbook

Read this section first when something is broken. Each row points you at where
to look and how to fix.

| Symptom | Most likely cause | Where to look | How to fix |
|---|---|---|---|
| Customer can't log in | Supabase Auth misconfig | Supabase Dashboard → Authentication | Check provider settings, JWT secret rotation |
| Login works but customer sees no projects | RLS or wrong customer email | Supabase → SQL Editor: `select * from profiles where email = '<their email>'` then check `customers` and `project_members` | Add to `project_members` or align `customer.email` |
| New SharePoint files don't appear in portal | Auto-sync skipped/failed, or SharePoint app token expired | Supabase → Edge Functions → `sync-files-from-sharepoint` logs | Check `SHAREPOINT_CLIENT_SECRET` hasn't expired (Microsoft rotates every ~2 yrs) |
| Customer's Zoho data is stale | Hourly cron failed, or Zoho refresh token revoked | `sync-zoho` function logs | Reauth Zoho self-client; rotate `ZOHO_REFRESH_TOKEN` secret |
| Customer-forwarded PO didn't appear after they emailed `automation@` | Power Automate flow off / errored | Power Automate → My Flows → `PO Email Ingest` → Run history | Check connection token; look at HTTP step error |
| AI PO review/classification returns errors | Anthropic key expired or quota | `analyze-po` / `ingest-po-from-email` function logs | Rotate `ANTHROPIC_API_KEY` secret |
| Outbound emails (reminders, notifications) not sending | Graph app permission revoked, or sender mailbox issue | `notify-upload`, `send-reminder`, `notify-project-note` function logs | Check Microsoft Graph app permissions; verify `notifications@hydrowates.com` mailbox |
| One specific edge function returns 401 | Service-role key changed; function's auth check is stale | Function source for the legacy `token === serviceKey` check | Patch function to use the three-path auth (see `upload-po-to-sharepoint` for the reference implementation) |

## 4. Secrets inventory

Every Supabase Edge Function secret. Set/rotated at:
**Supabase Dashboard → Project Settings → Edge Functions → Manage secrets**

| Secret | What it's for | Where to obtain a new one | Expiry behavior |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Claude vision + text for `analyze-po`, `ingest-po-from-email` | https://console.anthropic.com → API keys | No automatic expiry; rotate if leaked |
| `ZOHO_REFRESH_TOKEN` | Long-lived Zoho Books auth (used by `sync-zoho`) | Re-run Zoho OAuth self-client setup (see §8) | Revoked if user disables app; ~no idle timeout |
| `ZOHO_ORG_ID` | Zoho organization scope | Zoho Books → Profile → Organization ID | Permanent |
| `SHAREPOINT_TENANT_ID` | Microsoft 365 tenant identifier | Azure AD → app overview | Permanent |
| `SHAREPOINT_CLIENT_ID` | App registration ID for Graph access | Azure AD → app registrations | Permanent |
| `SHAREPOINT_CLIENT_SECRET` | App secret (used to mint Graph tokens) | Azure AD → app → Certificates & secrets | **~2-year lifetime — set a calendar reminder** |
| `SHAREPOINT_PO_HOSTNAME` | Override default SharePoint host (`hydrowates.sharepoint.com`) | n/a — usually unset | n/a |
| `SHAREPOINT_PO_ROOT_FOLDER` | Path under Shared Documents (default `Hydro-Wates/Commercial Proposals`) | Edit in dashboard if folder layout changes | n/a |
| `SHAREPOINT_PO_SUBFOLDER` | Override the per-project PO subfolder name (default `Purchase Order`) | Edit if conventions change | n/a |
| `PO_INGEST_TOKEN` | Shared secret between `ingest-po-from-email` and Power Automate's HTTP step | Generate a new random string; update **both** the Supabase secret AND the Power Automate `X-Ingest-Token` header value | Rotate if leaked |
| `INSPECT_KEY` | Header value to call `sharepoint-list` debug helper | Edit if compromised | Rotate if leaked |
| `EMAIL_LOGO_URL` | URL for the Hydro-Wates logo image used in branded emails | Public image URL | n/a |
| `MAIL_SENDER` | Sender address for outbound Graph emails (default `sales@hydrowates.com`) | n/a — usually unset | n/a |
| `EMAIL_REPLY_TO` | Reply-To header for outbound emails (default `sales@hydrowates.com`) | n/a — usually unset | n/a |
| `ADMIN_NOTIFY_EMAIL` | Address that gets "PO received — needs manual filing" emails | n/a — usually unset (defaults to `sales@`) | n/a |
| `PORTAL_URL` | Base URL of the portal (used in email CTAs) | **Set this when portal is deployed.** Currently unset. | n/a |
| `SUPABASE_URL` | Auto-injected by Supabase | n/a | n/a |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase | Rotate from Supabase Dashboard → API | Rotating breaks every function until they get the new value (auto on next deploy) |

**Frontend env vars** (set at build time in your hosting provider, not in Supabase):

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Public Supabase URL |
| `VITE_SUPABASE_ANON_KEY` | Public anon key (RLS-scoped) |

## 5. Edge function reference

All functions live under `supabase/functions/<name>/index.ts`. Deploy any one with:

```powershell
cd C:\path\to\customer-portal
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."  # from https://supabase.com/dashboard/account/tokens
supabase functions deploy <name> --project-ref vpdcikiyaifppkkantrb --use-api --no-verify-jwt
```

**Project ref**: `vpdcikiyaifppkkantrb`

### Function inventory

| Function | Triggered by | What it does |
|---|---|---|
| `sync-zoho` | Hourly cron + admin "Sync from Zoho" button | Pulls customers/projects/invoices from Zoho Books. Auto-adds project members on email match. Sends Graph email on status changes. |
| `sync-files-from-sharepoint` | Project page load (auto-sync) + admin button + bulk-sync script | Pulls files from `Purchase Order/`, `Quote/`, `Inspection Documents/` subfolders + root `Certificate*.pdf` files for a given project. Dedupes by SharePoint item ID. Supports `certsOnly: true` body param to skip subfolders. |
| `sync-leads` | Manual / scheduled | Pulls project descriptions from the SharePoint Lead List into `projects.lead_comments`. |
| `sharepoint-list` | Debug helper, gated by `INSPECT_KEY` header | Read-only Graph folder listing. Used during development to inspect SharePoint structure. |
| `upload-po-to-sharepoint` | Admin/customer PO upload via portal + `ingest-po-from-email` | Mirrors a portal-uploaded PO into SharePoint's `Purchase Order/` subfolder. If no matching project folder exists, emails sales@ with the PO attached. Records the SharePoint item ID for dedup with future syncs. |
| `ingest-po-from-email` | Power Automate (`PO Email Ingest` flow) | Receives forwarded PO / drawing emails. Claude Opus vision classifies each attachment as PO, drawing, or other. POs upload into the portal AND fire the SharePoint mirror; drawings upload with `kind='drawing'` (project Drawings tab, no SharePoint mirror). Native CAD files (.dwg/.dxf/.step) are filed as drawings by extension. Bounces with a friendly explanation if nothing recognized or HWI code not found. |
| `analyze-po` | Admin "Review with AI" button on a PO file | Claude Opus reads the PO PDF and returns summary + concerns + extracted fields. Result is cached in `po_reviews` table. |
| `notify-upload` | Frontend after every file upload | Emails the other party (customer if admin uploaded, sales@ if customer uploaded). Honors `app_settings.emails_paused` kill switch. |
| `send-reminder` | Admin "Remind" button on missing documents | Emails the customer (and any selected project members) a branded reminder. Records `reminders` row for the "last reminded" indicator. |
| `notify-project-note` | Frontend after note add/edit | Emails the other side of the project notes thread. |
| `invite-customer` | Admin "Invite" button on Customers page / Project Members tab | Calls Supabase `auth.admin.inviteUserByEmail`. Returns the new `auth.users.id` so the Project page can immediately add them to `project_members`. |
| `submit-quote-request` | Customer's "Request Now" button on `/request-quote` | Inserts a row into `quote_requests`, sends a notification to sales@, forwards the form to Power Automate (legacy MODX webhook). |

### Functions deployed with `--no-verify-jwt`

These bypass the Supabase gateway's JWT verification because they need to be
called inter-function or from Power Automate's HTTP step where the auth header
doesn't conform to the legacy JWT format. Each one re-implements its own auth
check internally (compare against env service key OR JWT role:service_role
claim OR admin user JWT):

- `upload-po-to-sharepoint`
- `ingest-po-from-email`
- `sync-files-from-sharepoint`
- `sync-zoho`
- `sharepoint-list`

If you add a new function that needs to be called from inside another function,
deploy it with `--no-verify-jwt` and copy the three-path auth check pattern
from `upload-po-to-sharepoint`.

## 6. Database schema

The source of truth lives at `supabase/migrations/`. To bring a fresh
Supabase project up to current production schema, apply every migration in
that folder in filename order.

Tables (current production):

| Table | What it stores | Notable columns |
|---|---|---|
| `profiles` | One row per portal user (auth.users mirror + role + preferences) | `role: 'customer'|'admin'`, `email_notifications: bool` |
| `customers` | Synced from Zoho contacts (contact_type='customer' only) | `zoho_contact_id`, `shipping_*`, `billing_*`, `phone` |
| `projects` | Synced from Zoho projects + manually created | `zoho_project_id`, `customer_id`, `status`, `description`, `lead_comments` |
| `project_members` | Explicit per-user, per-project access | `project_id → projects`, `user_id → auth.users` |
| `files` | Every file in the portal (uploads + SharePoint syncs) | `kind`, `sharepoint_source_id` (dedup), `sharepoint_synced_at`, `sharepoint_path`, `source_created_at` (real OneDrive upload date) |
| `document_requests` | Admin-defined required documents per project | `label` |
| `invoices` | Synced from Zoho invoices | `zoho_invoice_id`, `total`, `balance`, `status` |
| `quote_requests` | Customer-submitted RFQs | `request_types`, `attachment_paths`, `admin_notes`, `status` |
| `project_notes` | Shared comment thread per project | `content`, `author_id`, `visibility` |
| `reminders` | Per-project, per-document "last reminded" record | `project_id`, `document_label` |
| `po_reviews` | Cached AI PO review output | `file_id`, `summary`, `concerns`, `extracted_fields`, `model` |
| `app_settings` | Single-row global toggles | `emails_paused` |

Helper functions in `public`:
- `is_admin()` — used in many RLS policies
- `can_access_project(pid uuid)` — combines admin OR project_members OR customer-email match
- `handle_new_user()` — trigger on auth.users insert; auto-creates a profile row
- `prevent_role_escalation()` — trigger on profiles update; blocks customers from setting their own role to admin

Storage buckets:
- `project-files` — every uploaded file, scoped per-project by RLS (folder = project UUID)
- `quote-attachments` — quote request attachments, scoped per-user (folder = auth.uid())

## 7. Integrations

### 7a. Zoho Books

- **Auth**: OAuth self-client (refresh token long-lived).
- **Sync function**: `sync-zoho`.
- **Cadence**: hourly cron (Supabase pg_cron). Also triggered by admin "Sync from Zoho" button.
- **What gets pulled**: contacts (customer-type only), projects, invoices.
- **What gets pushed**: nothing — read-only.

**To rotate the refresh token (after Zoho revokes or for security):**
1. Sign in to https://api-console.zoho.com (use a Hydro-Wates Zoho admin account).
2. Open the self-client we registered (named something like "Customer Portal").
3. Generate a fresh refresh token (scope: `ZohoBooks.fullaccess.all`).
4. Update the `ZOHO_REFRESH_TOKEN` secret in Supabase.
5. Wait for the next hourly cron, or manually click the admin "Sync from Zoho" button to confirm it works.

### 7b. Microsoft Graph (SharePoint + Email)

- **Auth**: Client-credentials app registration in Azure AD ("Hydro-Wates Portal Integration" or similar).
- **App permissions required**: `Sites.ReadWrite.All`, `Files.ReadWrite.All`, `Mail.Send` (application).
- **App access policy**: scoped so Mail.Send only works for `notifications@hydrowates.com` and `sales@hydrowates.com` (this is set via PowerShell on the tenant — see Azure docs for "limit application permissions").
- **Used by**: `sync-files-from-sharepoint`, `upload-po-to-sharepoint`, `sharepoint-list`, `sync-leads`, `notify-upload`, `send-reminder`, `notify-project-note`, `sync-zoho`.

**To rotate the client secret (every 2 years, before expiry):**
1. Sign in to https://portal.azure.com as a tenant admin.
2. Azure AD → App registrations → find the Hydro-Wates Portal app.
3. Certificates & secrets → New client secret. Set expiry to 24 months. Copy the value immediately (you can't see it again).
4. Update the `SHAREPOINT_CLIENT_SECRET` secret in Supabase.
5. Test by clicking the admin "Sync from SharePoint" button on any project. If it works, you're done. Old secret stays valid until its expiry date so there's no downtime.

### 7c. Anthropic (Claude)

- **Auth**: API key.
- **Models used**:
  - `claude-opus-4-7` — `analyze-po` (full PO review) and `ingest-po-from-email` (PO classification + extraction)
- **Cost**: ~$2-6/month at current volume (~20 PO emails + occasional admin reviews).

**To rotate the API key:**
1. Sign in to https://console.anthropic.com.
2. Workspace → API keys → Create new key.
3. Update the `ANTHROPIC_API_KEY` secret in Supabase.
4. Revoke the old key.

### 7d. Power Automate (PO Email Ingest)

- **Mailbox**: `automation@hydrowates.com` (shared mailbox; the flow runs under whichever user owns it).
- **Flow name**: `PO Email Ingest`.
- **Trigger**: New email arrives → subject contains `#PO` or the word `drawing` (case-insensitive, via a trigger condition — the Subject Filter field is intentionally empty) → has attachments.
- **Endpoint**: `https://vpdcikiyaifppkkantrb.supabase.co/functions/v1/ingest-po-from-email`.
- **Auth**: `X-Ingest-Token` header. Value must match the `PO_INGEST_TOKEN` Supabase secret.

**PM-facing instructions:**

> When a customer emails you a PO or project drawings, forward it to `automation@hydrowates.com` with the HWI code (e.g. `HWI-26-254`) anywhere in the subject, plus either `#PO` or the word "drawing" (any casing — "Fwd: Drawings for HWI-26-254" works as-is). Within ~60 seconds you'll get a reply confirming what was filed — POs go to the project's documents + SharePoint, drawings go to the project's Drawings tab. If the system can't recognize the attachments or find the project, the reply tells you what to fix.

**To rotate the ingest token:**
1. Generate a new random string (any URL-safe base64-encoded 32 bytes).
2. Update `PO_INGEST_TOKEN` in Supabase secrets.
3. In Power Automate → `PO Email Ingest` → HTTP step → Headers → update `X-Ingest-Token` to the same value.
4. Save and turn the flow back on.

**To recreate the flow from scratch** (e.g. accidental deletion):

In Power Automate logged in as the mailbox owner, create an Automated Cloud Flow with these 6 actions:

1. **Trigger**: *When a new email arrives (V3)*. Mailbox: `automation@hydrowates.com`. Include Attachments: Yes. Only with Attachments: Yes. Leave Subject Filter empty; instead add this under Settings → Trigger conditions:
   ```
   @or(contains(toLower(coalesce(triggerBody()?['subject'], '')), '#po'), contains(toLower(coalesce(triggerBody()?['subject'], '')), 'drawing'))
   ```
2. **Select** (Data Operation). From: `triggerOutputs()?['body/attachments']`. Map to:
   ```json
   {
     "filename": @{item()?['Name']},
     "contentBase64": @{item()?['ContentBytes']},
     "contentType": @{item()?['ContentType']}
   }
   ```
3. **HTTP** POST to `https://vpdcikiyaifppkkantrb.supabase.co/functions/v1/ingest-po-from-email`. Headers: `Content-Type: application/json`, `X-Ingest-Token: <PO_INGEST_TOKEN value>`. Body:
   ```json
   {
     "subject": @{triggerOutputs()?['body/subject']},
     "body": @{triggerOutputs()?['body/bodyPreview']},
     "fromEmail": @{triggerOutputs()?['body/from']},
     "fromName": @{triggerOutputs()?['body/sender/emailAddress/name']},
     "attachments": @{body('Select')}
   }
   ```
4. **Parse JSON** on the HTTP response with schema:
   ```json
   {"type":"object","properties":{"ok":{"type":"boolean"},"message":{"type":"string"},"reason":{"type":"string"},"hwiCode":{"type":"string"},"projectName":{"type":"string"},"customer":{"type":"string"}}}
   ```
5. **Send an email (V2)**. To: `triggerOutputs()?['body/from']`. Subject: `Re: ` + Subject dynamic chip. Body: `body('Parse_JSON')?['message']`. From (Send as): `automation@hydrowates.com`.
6. Save and turn on.

## 8. Deployment

### Frontend (current state: NOT DEPLOYED)

The portal currently runs only via `npm run dev` on the developer's local
machine. **This is a critical gap.** Deploy to Vercel/Netlify/Cloudflare Pages
as soon as possible.

**Recommended: Vercel.**

```
1. Sign in to https://vercel.com with the Hydro-Wates team account.
2. Import project → Add New → Project → Import the customer-portal Git repo.
3. Framework preset: Vite. Build command: npm run build. Output: dist.
4. Environment variables (Production):
     VITE_SUPABASE_URL=https://vpdcikiyaifppkkantrb.supabase.co
     VITE_SUPABASE_ANON_KEY=<anon key from Supabase dashboard>
5. Deploy.
6. Add custom domain (portal.hydrowates.com) and SSL via Vercel UI.
7. Update Supabase Edge Function secret PORTAL_URL to the production URL.
```

After deploy, every push to `main` auto-deploys. Preview deployments for
branches. Roll back via Vercel UI in two clicks if anything goes wrong.

### Backend (Supabase Edge Functions)

Deployed manually using the Supabase CLI. There is no CI/CD pipeline.

**Required tools:**
- Supabase CLI (`scoop install supabase` or download from https://github.com/supabase/cli/releases)
- Personal access token from https://supabase.com/dashboard/account/tokens

**Workflow:**
```powershell
cd C:\path\to\customer-portal
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."  # your personal token
supabase functions deploy <function-name> --project-ref vpdcikiyaifppkkantrb --use-api --no-verify-jwt
```

Most functions need `--no-verify-jwt` because of how they're called. Specifically required for:
`upload-po-to-sharepoint`, `ingest-po-from-email`, `sync-files-from-sharepoint`, `sync-zoho`, `sharepoint-list`.

Other functions (e.g. `submit-quote-request`, `notify-upload`, `send-reminder`)
can be deployed with or without `--no-verify-jwt` — they're called from the
frontend with a user JWT.

### Database migrations

Schema changes go in `supabase/migrations/` as new `<timestamp>_<name>.sql`
files. To apply a migration to production, paste the SQL into Supabase
Dashboard → SQL Editor (no automated process yet).

When a migration is applied, **add it to the migrations folder** even if you
applied it manually — the folder is the source of truth for "what's the
current schema."

## 9. Routine maintenance

### Monthly

- Check Supabase Dashboard → Edge Function logs for any function with elevated error rate
- Check Anthropic console for token usage trends
- Verify the hourly Zoho cron is still running (Supabase Dashboard → Database → Extensions → pg_cron → look at `cron.job_run_details`)

### Quarterly

- Spot-check 2-3 projects: open them in the portal, confirm SharePoint sync still works
- Forward a test PO email to `automation@hydrowates.com` from your own account; confirm round-trip

### Annually

- **Review and rotate**: all secrets in §4 that don't have a hard expiry
- **Plan ahead for**: `SHAREPOINT_CLIENT_SECRET` expiry (set a calendar reminder ~3 months before)

## 10. Local development

```powershell
# One-time setup
git clone <repo-url> customer-portal
cd customer-portal
npm install
# Copy .env.local from a teammate or generate from Supabase dashboard:
#   VITE_SUPABASE_URL=...
#   VITE_SUPABASE_ANON_KEY=...

# Day-to-day
npm run dev    # starts Vite at http://localhost:5173
```

### Working with edge functions locally

The Supabase CLI can serve edge functions locally too, but most of the
time it's easier to deploy directly to the production project. Function code
changes are isolated by function name, so deploying a single function doesn't
affect anything else.

### Useful PowerShell scripts (in `scripts/`)

- `bulk-sync-all.ps1` — Full sync of every HWI-25 + HWI-26 project (POs, quotes, equipment certs, root certificates)
- `bulk-sync-certs.ps1` — Cert-only sync (skips subfolders, just pulls root `Certificate*.pdf`)
- `test-ingest-po.ps1` — Test the email-to-portal ingest function by POSTing a PDF directly

All three require a Supabase personal access token. Edit the script to paste
yours in, or pass via `$env:SUPABASE_ACCESS_TOKEN` if the script is updated to
read from env.

## 11. Contact information

### Critical accounts and where they live

- **Supabase project owner**: <set this — currently kkim@hydrowates.com>
- **Vercel account** (after deploy): <set this when deploying>
- **Domain registrar** (for `portal.hydrowates.com`): <set this>
- **Zoho Books admin**: <whoever holds Zoho Books admin role>
- **Microsoft 365 admin / IT**: <name and email>
- **Anthropic billing owner**: <whoever owns the Anthropic workspace>

### Vendor support

- Supabase: https://supabase.com/dashboard/support
- Anthropic: support@anthropic.com
- Microsoft 365: through your Microsoft Partner / Premier support
- Zoho: https://www.zoho.com/books/contact-us.html

## 12. Known gaps / future work

Listed in rough priority order:

1. **Production deployment** — Portal isn't on a real domain yet. Critical.
2. **Uptime monitoring** — Suggest UptimeRobot hitting the root URL every 5 min, alert sales@ on failure.
3. **Schema snapshot** — Run `supabase db dump --schema-only > supabase/schema.sql` and commit periodically as a backup source-of-truth.
4. **CI/CD** — Eventually replace manual function deploys with GitHub Actions on push to main.
5. **Staging environment** — Create a second Supabase project for testing big changes before they hit production.
6. **Test suite** — Edge function tests in particular would catch auth and dedup regressions early.
7. **Customer self-service**: Allow customers to update their own profile, request password reset without admin involvement.
8. **Power Automate flow versioning** — Currently no source-control for the flow definition. Microsoft has a tool to export flows as JSON; worth exporting and committing periodically.

---

## Appendix A: Edge function code patterns to copy

When adding a new edge function that needs service-role authorization, use
this pattern (copied from `upload-po-to-sharepoint`):

```typescript
const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
if (!token) return json({ error: "Not authorized" }, 401);

let isServiceRole = false;
// Check 1: direct string match against env service key
if (token === serviceKey) isServiceRole = true;
// Check 2: legacy JWT with role:service_role claim
if (!isServiceRole) {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const padded = parts[1] + "=".repeat((4 - parts[1].length % 4) % 4);
      const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
      if (payload?.role === "service_role") isServiceRole = true;
    }
  } catch { /* not a JWT */ }
}
// Check 3: regular user JWT — must be an admin
if (!isServiceRole) {
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 401);
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") return json({ error: "Admin only" }, 403);
}
```

And deploy with `--no-verify-jwt`.

## Appendix B: Common SQL queries

```sql
-- All admin users
select id, email, full_name from profiles where role = 'admin';

-- A customer's projects via email match
select p.* from projects p
  join customers c on c.id = p.customer_id
  where lower(c.email) = lower('<their@email>');

-- Files synced from SharePoint in the last 24h
select f.name, p.name as project, f.sharepoint_synced_at
  from files f join projects p on p.id = f.project_id
  where f.sharepoint_synced_at > now() - interval '24 hours'
  order by f.sharepoint_synced_at desc;

-- Customers without a portal account yet (haven't accepted invite)
select c.* from customers c
  where c.email is not null
    and not exists (select 1 from profiles p where lower(p.email) = lower(c.email));

-- Reset emails_paused kill switch
update app_settings set emails_paused = false;
```
