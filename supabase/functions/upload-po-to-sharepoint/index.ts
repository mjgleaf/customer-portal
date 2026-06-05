// Supabase Edge Function: upload-po-to-sharepoint
// Fires whenever a Purchase Order file is uploaded (by admin or customer)
// to push a copy into Hydro-Wates' SharePoint document library so the
// existing PO archive workflow continues to receive POs automatically.
//
// Flow:
//   1. Authenticate caller (any logged-in user — RLS already gates this
//      via files.project access).
//   2. Look up the file by id, verify kind='purchase_order'.
//   3. Look up the project's customer name for folder organization.
//   4. Get app-only Graph token (same SharePoint app used for sync-leads,
//      now also has Files.ReadWrite.All).
//   5. Read the file bytes from Supabase Storage via signed URL.
//   6. Ensure the folder hierarchy exists in SharePoint
//      ("<root>/<customer>/<project>/").
//   7. PUT the file via Microsoft Graph.
//   8. Update files row with sharepoint_synced_at + sharepoint_path
//      on success, or sharepoint_error on failure.
//
// Best-effort: a failure here doesn't break the upload flow in the portal.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandedEmail } from "../_shared/email-template.ts";
import { renderProjectInfoBlock } from "../_shared/project-context.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// HTML-escape strings before interpolating them into the email body.
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Same SharePoint app + tenant used for sync-leads. IT just added
// Files.ReadWrite.All to its existing permissions.
async function graphToken(): Promise<string> {
  const tenant = Deno.env.get("SHAREPOINT_TENANT_ID");
  const clientId = Deno.env.get("SHAREPOINT_CLIENT_ID");
  const clientSecret = Deno.env.get("SHAREPOINT_CLIENT_SECRET");
  if (!tenant || !clientId || !clientSecret) {
    throw new Error("Missing SHAREPOINT_* credentials");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Graph token failed: " + JSON.stringify(j));
  return j.access_token as string;
}

// Look up the SharePoint site by hostname. Cached at function-instance level
// (warm starts reuse the lookup; cold start does it once).
const siteCache = new Map<string, string>();

async function getSiteId(hostname: string, sitePath: string, token: string): Promise<string> {
  const key = `${hostname}${sitePath}`;
  const cached = siteCache.get(key);
  if (cached) return cached;
  const path = sitePath && sitePath !== "/" ? `:${sitePath}` : "";
  const url = `https://graph.microsoft.com/v1.0/sites/${hostname}${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Site lookup failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  if (!j.id) throw new Error("Site lookup returned no id");
  siteCache.set(key, j.id as string);
  return j.id as string;
}

// Look up the drive (document library) by display name. If the env var
// SHAREPOINT_PO_LIBRARY is unset or matches "default", use the default drive.
async function getDriveId(siteId: string, token: string): Promise<string> {
  const libName = Deno.env.get("SHAREPOINT_PO_LIBRARY") || "";
  if (!libName || libName.toLowerCase() === "default" || libName.toLowerCase() === "documents") {
    // Default drive — present in every site, no lookup needed.
    const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drive`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) throw new Error(`Default drive lookup failed (${r.status}): ${await r.text()}`);
    const j = await r.json();
    return j.id as string;
  }
  // Named library — list all drives and match by name.
  const r = await fetch(`https://graph.microsoft.com/v1.0/sites/${siteId}/drives`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`Drives list failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  const match = (j.value ?? []).find(
    (d: { name?: string }) => (d.name ?? "").toLowerCase() === libName.toLowerCase(),
  );
  if (!match) {
    throw new Error(`Document library "${libName}" not found in site. Available: ${(j.value ?? []).map((d: { name?: string }) => d.name).join(", ")}`);
  }
  return match.id as string;
}

// Strip characters SharePoint forbids in file/folder names: \ / : * ? " < > |
// Also collapse whitespace and trim — keeps the folder/file names usable.
function sanitize(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200) || "Untitled";
}

// Pull the HWI- code (e.g. "HWI-26-254") off the front of a project name.
// Returns null if the project doesn't follow Hydro-Wates' HWI numbering.
function parseHwiCode(projectName: string): string | null {
  const m = projectName.match(/^(HWI-\d{2}-\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

// "HWI-26-254" -> 2026.  Two-digit years 00-50 -> 2000-2050, 51-99 -> 1951-1999.
function yearFromHwiCode(code: string): number | null {
  const m = code.match(/^HWI-(\d{2})-/i);
  if (!m) return null;
  const yy = parseInt(m[1], 10);
  return yy < 51 ? 2000 + yy : 1900 + yy;
}

// Find a folder whose name STARTS with the HWI code followed by a comma or
// space, so "HWI-26-25" can't accidentally match "HWI-26-254".
function findProjectFolder(
  items: Array<{ folder?: unknown; name?: string }>,
  hwiCode: string,
): { name: string } | null {
  const code = hwiCode.toUpperCase();
  for (const it of items) {
    if (!it.folder || !it.name) continue;
    const upper = it.name.toUpperCase();
    if (upper === code || upper.startsWith(code + ",") || upper.startsWith(code + " ")) {
      return { name: it.name };
    }
  }
  return null;
}

function todayMMDDYYYY(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
}

// Base64-encode a Uint8Array without blowing the call stack on larger files.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Send an email with a file attachment via Microsoft Graph. Used when the
// project folder doesn't exist in SharePoint yet — we route the PO to the
// sales mailbox so the team can manually file it once they create the
// proposal folder. Uses the same Graph credentials + kill switch as the
// other email functions.
const SENTINEL_EMAILED = "emailed-to-sales";

async function sendEmailWithAttachment(
  admin: ReturnType<typeof createClient>,
  opts: {
    to: string;
    subject: string;
    bodyHtml: string;
    attachmentName: string;
    attachmentBytes: Uint8Array;
    attachmentMimeType: string;
  },
): Promise<void> {
  const { data: setting } = await admin
    .from("app_settings").select("value").eq("key", "emails_paused").maybeSingle();
  if (setting?.value !== "false") {
    console.log(`[emails paused] would send "${opts.subject}" to: ${opts.to}`);
    return;
  }

  const mailSender = Deno.env.get("MAIL_SENDER") || "sales@hydrowates.com";
  const replyTo = Deno.env.get("EMAIL_REPLY_TO") || "sales@hydrowates.com";
  const token = await graphToken();

  // Microsoft Graph simple sendMail caps attachments around 3 MB (4 MB total
  // message). Above that we'd need a draft + upload-session flow, which
  // POs almost never need.
  if (opts.attachmentBytes.length > 3 * 1024 * 1024) {
    throw new Error(
      `PO file is too large to email (${(opts.attachmentBytes.length / 1024 / 1024).toFixed(1)} MB > 3 MB cap). ` +
      `Falling back: file is still in Supabase Storage, admin can download from portal.`,
    );
  }

  const contentBytes = bytesToBase64(opts.attachmentBytes);

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailSender)}/sendMail`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          subject: opts.subject,
          body: { contentType: "HTML", content: opts.bodyHtml },
          toRecipients: [{ emailAddress: { address: opts.to } }],
          replyTo: [{ emailAddress: { address: replyTo } }],
          attachments: [
            {
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: opts.attachmentName,
              contentType: opts.attachmentMimeType || "application/octet-stream",
              contentBytes,
            },
          ],
        },
        saveToSentItems: false,
      }),
    },
  );

  if (!resp.ok) {
    throw new Error(`Graph sendMail (with attachment) failed: ${resp.status} ${await resp.text()}`);
  }
}

// Idempotently create a child folder under `parentPath`. If the folder
// already exists, returns silently (treats 409 nameAlreadyExists as success).
async function ensureFolder(
  driveId: string,
  parentPath: string,
  folderName: string,
  token: string,
): Promise<void> {
  const url = parentPath
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(parentPath)}:/children`
    : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children`;
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: folderName,
      folder: {},
      "@microsoft.graph.conflictBehavior": "fail",
    }),
  });
  if (r.ok) return;
  if (r.status === 409) return; // already exists — fine
  throw new Error(`ensureFolder "${folderName}" under "${parentPath}": ${r.status} ${await r.text()}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Caller must be a logged-in user OR present a service-role-claim JWT
  // (matches the sync-zoho pattern so cron jobs, scripts, and other
  // automation can invoke the function without a user session). We check
  // the JWT's role claim rather than string-comparing the env var so this
  // works regardless of which service-role-key format Supabase issued.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 401);
  let isServiceRole = false;
  // Check 1: direct string match against the env service-role key. Handles
  // the new sb_secret_ key format which isn't a JWT and so can't be parsed
  // the legacy way below. Inter-function calls from ingest-po-from-email
  // use this path.
  if (token === serviceKey) {
    isServiceRole = true;
  }
  // Check 2: legacy JWT with role:service_role claim (old key format).
  if (!isServiceRole) {
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const padded = parts[1] + "=".repeat((4 - parts[1].length % 4) % 4);
        const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
        if (payload?.role === "service_role") isServiceRole = true;
      }
    } catch { /* not a JWT — fall through to user check */ }
  }
  // Check 3: regular user JWT — must resolve to an actual auth.users row.
  if (!isServiceRole) {
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Not authorized" }, 401);
  }

  let fileId: string | undefined;
  try {
    const body = await req.json();
    fileId = body?.fileId;
    if (!fileId) return json({ error: "fileId is required" }, 400);

    // Fetch file + project + customer context.
    const { data: file } = await admin
      .from("files")
      .select("id, project_id, name, kind, storage_path")
      .eq("id", fileId)
      .single();
    if (!file) return json({ error: "File not found" }, 404);
    if (file.kind !== "purchase_order") {
      return json({ error: "Only PO files are mirrored to SharePoint" }, 400);
    }

    const { data: project } = await admin
      .from("projects")
      .select("id, name, customer_id, description, lead_comments")
      .eq("id", file.project_id)
      .single();
    if (!project) return json({ error: "Project not found" }, 404);

    let customerName = "Uncategorized";
    if (project.customer_id) {
      const { data: cust } = await admin
        .from("customers")
        .select("company, name")
        .eq("id", project.customer_id)
        .maybeSingle();
      customerName = cust?.company || cust?.name || customerName;
    }

    // Read configuration from env (sensible defaults).
    const hostname = Deno.env.get("SHAREPOINT_PO_HOSTNAME") || "hydrowates.sharepoint.com";
    const sitePath = Deno.env.get("SHAREPOINT_PO_SITE_PATH") || "";
    // The root folder is an existing path inside the document library.
    const rootPath = (Deno.env.get("SHAREPOINT_PO_ROOT_FOLDER") || "Hydro-Wates/Commercial Proposals").trim();
    // Sub-folder inside each project folder where customer POs land,
    // separate from the proposal/quote documents the Hydro-Wates team puts
    // there manually. (Strategy B from the design discussion.)
    // POs land in the project's existing "Purchase Order" subfolder so
    // PMs only have one place to look for POs. The next sync-from-SharePoint
    // run will see the mirrored file but dedup it via sharepoint_source_id
    // (set after the upload below), so we won't create a duplicate portal
    // row. Override via env var SHAREPOINT_PO_SUBFOLDER if you ever want a
    // separate subfolder again.
    const customerPoSubfolder = (Deno.env.get("SHAREPOINT_PO_SUBFOLDER") || "Purchase Order").trim();

    // Hydro-Wates organizes Commercial Proposals as:
    //   {root}/{YYYY} Commercial Proposals/HWI-YY-XXX, {description}, {customer}, {date}/
    // So we need to (1) parse the HWI code, (2) navigate to the year folder,
    // (3) find the project folder by HWI-code prefix, (4) create it on the
    // fly if missing (so a customer can't break the upload by being early).
    const hwiCode = parseHwiCode(project.name);
    const year = hwiCode ? yearFromHwiCode(hwiCode) : null;
    if (!hwiCode || !year) {
      throw new Error(
        `Could not parse an HWI code (e.g. "HWI-26-254") from project name "${project.name}". ` +
        `POs are filed in SharePoint by HWI code + year, so a non-HWI project name has no obvious destination.`,
      );
    }
    const yearFolder = `${year} Commercial Proposals`;
    const yearFolderPath = `${rootPath}/${yearFolder}`;

    const accessToken = await graphToken();
    const siteId = await getSiteId(hostname, sitePath, accessToken);
    const driveId = await getDriveId(siteId, accessToken);

    // List the year folder and find the matching project folder by HWI code.
    const listUrl =
      `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(yearFolderPath)}:/children?$top=999`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResp.ok) {
      throw new Error(
        `Could not list "${yearFolder}" (HTTP ${listResp.status}): ${await listResp.text()}`,
      );
    }
    const yearChildren = await listResp.json();
    const existingMatch = findProjectFolder(yearChildren.value ?? [], hwiCode);

    // Download the file from Supabase Storage via a short-lived signed URL.
    // We need the bytes either way: to upload to SharePoint OR to attach to
    // the email notification.
    const { data: urlData, error: urlErr } = await admin.storage
      .from("project-files")
      .createSignedUrl(file.storage_path, 300);
    if (urlErr || !urlData?.signedUrl) {
      throw new Error(`Could not get signed URL: ${urlErr?.message ?? "unknown"}`);
    }
    const fileResp = await fetch(urlData.signedUrl);
    if (!fileResp.ok) {
      throw new Error(`Supabase Storage download failed (${fileResp.status})`);
    }
    const fileBytes = new Uint8Array(await fileResp.arrayBuffer());

    // === Folder-miss branch =================================================
    // If no project folder exists in SharePoint yet for this HWI code, email
    // the sales mailbox with the PO attached so the team can manually file
    // it once they create the proposal folder. Don't create a placeholder
    // folder — that would just clutter Commercial Proposals with empty
    // shells the team has to clean up later.
    if (!existingMatch) {
      const teamEmail = Deno.env.get("ADMIN_NOTIFY_EMAIL") || "sales@hydrowates.com";
      const portalUrl = Deno.env.get("PORTAL_URL") || "";
      const bodyHtml = brandedEmail({
        preheader: `${file.name} arrived from ${customerName} — no folder yet for ${hwiCode}.`,
        title: "PO received — needs manual filing",
        bodyHtml: `
          <p>A customer just uploaded a Purchase Order through the portal, but there's <strong>no matching project folder</strong> in SharePoint for this HWI code yet — likely because the proposal hasn't been sent out from your end.</p>
          <p><strong>HWI code:</strong> ${esc(hwiCode)}<br/>
             <strong>Project name:</strong> ${esc(project.name)}<br/>
             <strong>Customer:</strong> ${esc(customerName)}<br/>
             <strong>PO filename:</strong> ${esc(file.name)}</p>
          ${renderProjectInfoBlock(project)}
          <p><strong>Expected SharePoint location:</strong><br/>
             <code style="font-size:12px;color:#475569;">${esc(rootPath)}/${esc(yearFolder)}/${esc(hwiCode)}, &lt;description&gt;, ${esc(customerName)}, &lt;date&gt;/${esc(customerPoSubfolder)}/</code></p>
          <p>The PO is attached to this email. Once you create the project folder in SharePoint, drop the attached file into its <code>${esc(customerPoSubfolder)}/</code> subfolder.</p>
        `,
        ctaLabel: portalUrl ? "View in portal" : undefined,
        ctaUrl: portalUrl || undefined,
      });

      await sendEmailWithAttachment(admin, {
        to: teamEmail,
        subject: `PO received — no SharePoint folder yet for ${hwiCode} (${customerName})`,
        bodyHtml,
        attachmentName: file.name,
        attachmentBytes: fileBytes,
        attachmentMimeType: (file as { mime_type?: string }).mime_type || "application/pdf",
      });

      // Record on the file row that we routed via email instead of SharePoint.
      await admin
        .from("files")
        .update({
          sharepoint_synced_at: new Date().toISOString(),
          sharepoint_path: SENTINEL_EMAILED,
          sharepoint_error: null,
        })
        .eq("id", fileId);

      return json({
        ok: true,
        status: "emailed",
        emailedTo: teamEmail,
        reason: `No project folder matching ${hwiCode} found under ${yearFolder}`,
      });
    }

    // === Folder-match branch (SharePoint upload) ===========================
    const projectFolderName = existingMatch.name;
    const projectFolderPath = `${yearFolderPath}/${projectFolderName}`;

    // Ensure the Customer PO sub-folder exists inside the project folder
    // (Strategy B — customer-uploaded POs land in a clearly-labeled subfolder).
    await ensureFolder(driveId, projectFolderPath, customerPoSubfolder, accessToken);

    const spFilename = sanitize(file.name);
    const fullPath = `${projectFolderPath}/${customerPoSubfolder}/${spFilename}`;

    // PUT to Graph. Simple upload supports files up to 4 MB.
    // (Larger files need an upload session — POs are typically a few hundred KB.)
    const uploadUrl =
      `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(fullPath)}:/content`;
    const uploadResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
      body: fileBytes,
    });
    if (!uploadResp.ok) {
      throw new Error(`Graph upload failed (${uploadResp.status}): ${await uploadResp.text()}`);
    }
    const uploaded = await uploadResp.json();

    // Mark the row as synced. Also record the SharePoint item id so the
    // next sync-files-from-sharepoint run dedupes correctly and doesn't
    // pull the mirrored file back as a brand-new portal entry.
    await admin
      .from("files")
      .update({
        sharepoint_synced_at: new Date().toISOString(),
        sharepoint_path: fullPath,
        sharepoint_source_id: uploaded.id ?? null,
        sharepoint_error: null,
      })
      .eq("id", fileId);

    return json({
      ok: true,
      path: fullPath,
      webUrl: uploaded.webUrl,
      sharepointItemId: uploaded.id,
    });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.error("upload-po-to-sharepoint failed:", msg);
    // Record the failure on the file row so the admin UI can surface it.
    if (fileId) {
      await admin
        .from("files")
        .update({
          sharepoint_error: msg.slice(0, 500),
          sharepoint_synced_at: null,
        })
        .eq("id", fileId);
    }
    return json({ error: msg }, 500);
  }
});
