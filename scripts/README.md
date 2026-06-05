# Scripts

Operational scripts for the customer portal. None of these are part of the
deployed app — they're for admins to run from a developer machine when they
need to do bulk operations or test integrations.

All three are PowerShell scripts (Windows). Each one prompts for a Supabase
personal access token if you don't have one in your environment.

## Getting a Supabase access token

1. Sign in to https://supabase.com/dashboard
2. Click your avatar (top right) → **Account → Access Tokens**
3. **Generate new token** → name it (e.g. `ops-scripts-2026-06`) → copy the `sbp_...` value
4. Save it somewhere safe (1Password, etc.). It won't be shown again.

Then set it for your session:

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."
```

Or pass it directly to a script via `-SupabaseToken`.

## bulk-sync-all.ps1

Re-sync every HWI-25 and HWI-26 project from SharePoint. Pulls POs, quotes,
equipment certs, and root-level test certificates. Safe to re-run — dedupes by
SharePoint item ID.

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."
.\bulk-sync-all.ps1
```

- **Duration**: ~25 minutes for ~250 projects (the first run downloads files; subsequent runs are much faster because most are already synced)
- **Progress log**: `~\Desktop\.bulk-sync-progress.txt` (overwritten each iteration)
- **Detail log**: `~\Desktop\.bulk-sync-log.txt` (appended)

Use when: a SharePoint folder structure changed, a new big batch of files was
added, or you suspect the per-page auto-sync has fallen behind.

## bulk-sync-certs.ps1

Same as `bulk-sync-all` but **only** scans the project folder root for
`Certificate*.pdf` files. Skips the subfolder loop entirely (no extra POs,
quotes, or equipment certs pulled).

```powershell
$env:SUPABASE_ACCESS_TOKEN = "sbp_..."
.\bulk-sync-certs.ps1                    # defaults to HWI-26
.\bulk-sync-certs.ps1 -YearPrefix "HWI-25"
```

- **Duration**: ~3-5 minutes for ~75 projects
- Use when: you added customer-facing test certificates to project folder roots and want them visible in the portal quickly.

## test-ingest-po.ps1

Smoke-test the email-to-portal PO ingest function by sending a PDF directly,
without going through Outlook + Power Automate. Useful for diagnosing whether
a PO ingest issue is on the portal side or the email/Power-Automate side.

```powershell
$env:PO_INGEST_TOKEN = "<value of PO_INGEST_TOKEN Supabase secret>"
.\test-ingest-po.ps1 -PdfPath "C:\path\to\your.pdf" -HwiCode "HWI-26-200"
```

Look for `"ok": true` in the response and confirm:
- The PO appears in the portal under that project's Documents → Purchase Order
- The PO appears in SharePoint under that project's `Purchase Order/` subfolder
  (or `sales@hydrowates.com` gets an email if the SharePoint folder doesn't exist yet)
