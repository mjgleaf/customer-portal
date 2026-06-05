// Supabase Edge Function: sync-files-from-sharepoint
// One-way pull from SharePoint into the customer portal for a single
// project. Walks the matching project folder's subfolders:
//
//   <root>/<YYYY> Commercial Proposals/<HWI-YY-XXX, ...>/
//     ├── Purchase Order/    -> kind='purchase_order'   (any file type)
//     ├── Inspection Documents/ -> kind='certificate'   (any file type)
//     └── Quote/             -> kind='quote'            (PDF only)
//
// Dedupes by SharePoint item ID so re-running the sync only pulls new files.
// Admin-only.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const siteCache = new Map<string, string>();
async function getSiteId(hostname: string, sitePath: string, token: string): Promise<string> {
  const key = `${hostname}${sitePath}`;
  const cached = siteCache.get(key);
  if (cached) return cached;
  const path = sitePath && sitePath !== "/" ? `:${sitePath}` : "";
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`Site lookup failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  if (!j.id) throw new Error("Site lookup returned no id");
  siteCache.set(key, j.id as string);
  return j.id as string;
}

async function getDefaultDriveId(siteId: string, token: string): Promise<string> {
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`Drive lookup failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  return j.id as string;
}

function parseHwiCode(projectName: string): string | null {
  const m = projectName.match(/^(HWI-\d{2}-\d+)/i);
  return m ? m[1].toUpperCase() : null;
}

function yearFromHwiCode(code: string): number | null {
  const m = code.match(/^HWI-(\d{2})-/i);
  if (!m) return null;
  const yy = parseInt(m[1], 10);
  return yy < 51 ? 2000 + yy : 1900 + yy;
}

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

async function listChildren(driveId: string, path: string, token: string) {
  const url = path
    ? `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(path)}:/children?$top=999`
    : `https://graph.microsoft.com/v1.0/drives/${driveId}/root/children?$top=999`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`List "${path}" failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  return (j.value ?? []) as Array<{
    id?: string;
    name?: string;
    file?: { mimeType?: string };
    folder?: unknown;
    size?: number;
    webUrl?: string;
    lastModifiedDateTime?: string;
    createdDateTime?: string;
  }>;
}

// Map SharePoint subfolder name -> portal file kind + format filter
// (whether to PDF-only filter for that category).
//
// Note: "Inspection Documents" in SharePoint holds per-job equipment
// calibration certs (Load Cell, Waterbag, Sling, etc.) — not customer
// test reports — so it maps to equipment_certificate. Customer-facing
// test certificates / reports live elsewhere and are synced separately
// (see future sync entries below).
const SUBFOLDER_MAP: Array<{
  spName: string;
  portalKind: string;
  pdfOnly: boolean;
  label: string;
}> = [
  { spName: "Purchase Order",      portalKind: "purchase_order",         pdfOnly: false, label: "POs" },
  { spName: "Inspection Documents", portalKind: "equipment_certificate", pdfOnly: false, label: "equipment certificates" },
  { spName: "Quote",               portalKind: "quote",                  pdfOnly: true,  label: "quotes (PDF only)" },
];

function isPdf(file: { name?: string; file?: { mimeType?: string } }): boolean {
  const mime = (file.file?.mimeType ?? "").toLowerCase();
  if (mime === "application/pdf") return true;
  const name = (file.name ?? "").toLowerCase();
  return name.endsWith(".pdf");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Auth: admins can sync any project; project members (customer-side
  // portal users) can sync ONLY the project they're requesting. Service-role
  // (cron/scripts) bypasses both checks.
  const authToken = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!authToken) return json({ error: "Not authorized" }, 401);
  let isServiceRole = false;
  try {
    const parts = authToken.split(".");
    if (parts.length === 3) {
      const padded = parts[1] + "=".repeat((4 - parts[1].length % 4) % 4);
      const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
      if (payload?.role === "service_role") isServiceRole = true;
    }
  } catch { /* fall through */ }

  let callerUserId: string | null = null;
  let callerIsAdmin = false;
  if (!isServiceRole) {
    const { data: { user } } = await admin.auth.getUser(authToken);
    if (!user) return json({ error: "Not authorized" }, 401);
    callerUserId = user.id;
    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
    callerIsAdmin = profile?.role === "admin";
  }

  try {
    const body = await req.json();
    const projectId = body?.projectId as string | undefined;
    // certsOnly: only walk the project folder root for Certificate*.pdf
    // files. Skip the SUBFOLDER_MAP loop entirely (no extra Graph reads on
    // Purchase Order / Inspection Documents / Quote subfolders). Useful for
    // targeted bulk runs when you don't want to risk pulling extra files.
    const certsOnly = body?.certsOnly === true;
    if (!projectId) return json({ error: "projectId is required" }, 400);

    // Non-admin, non-service callers must be a member of the project they're
    // trying to sync. Mirrors the can_access_project() RLS helper, but
    // inlined here because we're calling from a service-role client and
    // auth.uid() isn't available inside the helper from that context.
    if (!isServiceRole && !callerIsAdmin && callerUserId) {
      // Check 1: explicit project_members row?
      const { data: memberRow } = await admin
        .from("project_members")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", callerUserId)
        .maybeSingle();
      let hasAccess = !!memberRow;
      // Check 2: email match on the project's customer record?
      if (!hasAccess) {
        const { data: callerProfile } = await admin
          .from("profiles")
          .select("email")
          .eq("id", callerUserId)
          .single();
        const callerEmail = (callerProfile?.email ?? "").toLowerCase();
        if (callerEmail) {
          const { data: projectRow } = await admin
            .from("projects")
            .select("customer:customers(email)")
            .eq("id", projectId)
            .single();
          const projectCustomerEmail = (projectRow?.customer as { email?: string | null } | null)?.email?.toLowerCase() ?? "";
          if (projectCustomerEmail && projectCustomerEmail === callerEmail) hasAccess = true;
        }
      }
      if (!hasAccess) return json({ error: "Not authorized for this project" }, 403);
    }

    const { data: project } = await admin
      .from("projects")
      .select("id, name")
      .eq("id", projectId)
      .single();
    if (!project) return json({ error: "Project not found" }, 404);

    const hwiCode = parseHwiCode(project.name);
    const year = hwiCode ? yearFromHwiCode(hwiCode) : null;
    if (!hwiCode || !year) {
      return json({
        error: `Project name "${project.name}" doesn't start with an HWI code (e.g. HWI-26-254). Cannot locate the matching SharePoint folder.`,
      }, 400);
    }

    const hostname = Deno.env.get("SHAREPOINT_PO_HOSTNAME") || "hydrowates.sharepoint.com";
    const sitePath = Deno.env.get("SHAREPOINT_PO_SITE_PATH") || "";
    const rootPath = (Deno.env.get("SHAREPOINT_PO_ROOT_FOLDER") || "Hydro-Wates/Commercial Proposals").trim();

    const token = await graphToken();
    const siteId = await getSiteId(hostname, sitePath, token);
    const driveId = await getDefaultDriveId(siteId, token);

    // 1. Find the matching project folder in the year's Commercial Proposals.
    const yearFolderPath = `${rootPath}/${year} Commercial Proposals`;
    const yearChildren = await listChildren(driveId, yearFolderPath, token);
    const projectFolder = findProjectFolder(yearChildren, hwiCode);
    if (!projectFolder) {
      return json({
        ok: true,
        status: "no-folder",
        message: `No SharePoint folder matching ${hwiCode} found under "${year} Commercial Proposals". Nothing synced.`,
      });
    }

    const projectFolderPath = `${yearFolderPath}/${projectFolder.name}`;

    // 2. Pre-fetch already-synced items so we can dedupe AND opportunistically
    // backfill source_created_at on rows that pre-date that column.
    const { data: existingRows } = await admin
      .from("files")
      .select("id, sharepoint_source_id, source_created_at")
      .eq("project_id", projectId)
      .not("sharepoint_source_id", "is", null);
    const existing = new Map<string, { id: string; needsSourceDate: boolean }>();
    for (const r of existingRows ?? []) {
      if (!r.sharepoint_source_id) continue;
      existing.set(r.sharepoint_source_id as string, {
        id: r.id as string,
        needsSourceDate: !r.source_created_at,
      });
    }

    const summary: Record<string, { added: number; skipped: number; backfilled: number; pdfFiltered: number; errors: number }> = {};
    for (const sub of SUBFOLDER_MAP) {
      summary[sub.spName] = { added: 0, skipped: 0, backfilled: 0, pdfFiltered: 0, errors: 0 };
    }
    // Customer-facing test certificates live at the *root* of each project
    // folder (e.g. "Certificate_1.pdf"), not in any subfolder. Track them
    // under their own summary bucket.
    const ROOT_CERT_KEY = "Project root (Certificates)";
    summary[ROOT_CERT_KEY] = { added: 0, skipped: 0, backfilled: 0, pdfFiltered: 0, errors: 0 };

    // 3. Iterate each subfolder, sync new files. Skipped when certsOnly is
    // set — useful for targeted bulk runs that only want root-level
    // customer-facing test certificates.
    if (!certsOnly) for (const sub of SUBFOLDER_MAP) {
      const subPath = `${projectFolderPath}/${sub.spName}`;
      let items: Awaited<ReturnType<typeof listChildren>>;
      try {
        items = await listChildren(driveId, subPath, token);
      } catch (e) {
        // Subfolder might not exist for some projects — that's not an error.
        const msg = String((e as Error).message);
        if (msg.includes("404") || msg.includes("itemNotFound") || msg.includes("does not exist")) {
          continue;
        }
        console.error(`Subfolder "${sub.spName}" list error:`, msg);
        summary[sub.spName].errors++;
        continue;
      }

      for (const item of items) {
        if (item.folder || !item.id || !item.name) continue;

        if (sub.pdfOnly && !isPdf(item)) {
          summary[sub.spName].pdfFiltered++;
          continue;
        }

        const prior = existing.get(item.id);
        if (prior) {
          // Already synced — but backfill source_created_at if it's missing
          // (this lets the bulk sync re-run pick up the "real" upload date
          // for rows that pre-date the source_created_at column).
          if (prior.needsSourceDate && item.createdDateTime) {
            const { error: updErr } = await admin
              .from("files")
              .update({ source_created_at: item.createdDateTime })
              .eq("id", prior.id);
            if (!updErr) {
              prior.needsSourceDate = false;
              summary[sub.spName].backfilled++;
            }
          }
          summary[sub.spName].skipped++;
          continue;
        }

        try {
          // Download bytes from SharePoint
          const contentResp = await fetch(
            `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${item.id}/content`,
            { headers: { Authorization: `Bearer ${token}` } },
          );
          if (!contentResp.ok) {
            console.error(`Download failed for ${item.name}: ${contentResp.status}`);
            summary[sub.spName].errors++;
            continue;
          }
          const bytes = new Uint8Array(await contentResp.arrayBuffer());

          // Upload to Supabase Storage under the project's folder
          const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const storagePath = `${projectId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
          const { error: upErr } = await admin.storage
            .from("project-files")
            .upload(storagePath, bytes, {
              contentType: item.file?.mimeType || "application/octet-stream",
              upsert: false,
            });
          if (upErr) {
            console.error(`Storage upload failed for ${item.name}: ${upErr.message}`);
            summary[sub.spName].errors++;
            continue;
          }

          // Insert files row. source_created_at holds the SharePoint
          // createdDateTime — the "real" upload date the user wants to see,
          // distinct from created_at which is when we inserted this row.
          const { data: insertedRow, error: insErr } = await admin.from("files").insert({
            project_id: projectId,
            name: item.name,
            storage_path: storagePath,
            size: item.size ?? bytes.length,
            mime_type: item.file?.mimeType || null,
            kind: sub.portalKind,
            sharepoint_source_id: item.id,
            source_created_at: item.createdDateTime || null,
            // For files synced from SharePoint, we also mark them as "synced
            // back to SharePoint" (they're literally already there) so the
            // PO sync function won't try to re-upload them. The sentinel
            // value here is the SharePoint webUrl for easy navigation.
            sharepoint_synced_at: new Date().toISOString(),
            sharepoint_path: item.webUrl || "synced-from-sharepoint",
          }).select("id").single();
          if (insErr || !insertedRow) {
            console.error(`Files insert failed for ${item.name}: ${insErr?.message}`);
            // Clean up the orphaned Storage file
            await admin.storage.from("project-files").remove([storagePath]);
            summary[sub.spName].errors++;
            continue;
          }

          existing.set(item.id, { id: insertedRow.id, needsSourceDate: false });
          summary[sub.spName].added++;
        } catch (e) {
          console.error(`Sync failed for ${item.name}:`, e);
          summary[sub.spName].errors++;
        }
      }
    }

    // 4. Root-level test certificates. Files named "Certificate*.pdf" at the
    // project folder root are customer-facing proof-load test certificates
    // (distinct from the equipment calibration certs in Inspection Documents).
    // We scan the root we already listed earlier.
    let rootChildren: Awaited<ReturnType<typeof listChildren>> = [];
    try {
      rootChildren = await listChildren(driveId, projectFolderPath, token);
    } catch (e) {
      console.warn(`Root listing failed for ${projectFolderPath}:`, (e as Error).message);
    }
    for (const item of rootChildren) {
      if (item.folder || !item.id || !item.name) continue;
      // Match files starting with "certificate" (case-insensitive). The user's
      // observed pattern is "Certificate_1.pdf", "Certificate_2.pdf", etc.
      if (!/^certificate/i.test(item.name)) continue;
      // PDF-only for these — Word documents at the root are usually drafts
      // or work procedures, not the final issued certificate.
      if (!isPdf(item)) {
        summary[ROOT_CERT_KEY].pdfFiltered++;
        continue;
      }

      const prior = existing.get(item.id);
      if (prior) {
        if (prior.needsSourceDate && item.createdDateTime) {
          const { error: updErr } = await admin
            .from("files")
            .update({ source_created_at: item.createdDateTime })
            .eq("id", prior.id);
          if (!updErr) {
            prior.needsSourceDate = false;
            summary[ROOT_CERT_KEY].backfilled++;
          }
        }
        summary[ROOT_CERT_KEY].skipped++;
        continue;
      }

      try {
        const contentResp = await fetch(
          `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${item.id}/content`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!contentResp.ok) {
          console.error(`Download failed for ${item.name}: ${contentResp.status}`);
          summary[ROOT_CERT_KEY].errors++;
          continue;
        }
        const bytes = new Uint8Array(await contentResp.arrayBuffer());
        const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const storagePath = `${projectId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
        const { error: upErr } = await admin.storage
          .from("project-files")
          .upload(storagePath, bytes, {
            contentType: item.file?.mimeType || "application/pdf",
            upsert: false,
          });
        if (upErr) {
          console.error(`Storage upload failed for ${item.name}: ${upErr.message}`);
          summary[ROOT_CERT_KEY].errors++;
          continue;
        }

        const { data: insertedRow, error: insErr } = await admin.from("files").insert({
          project_id: projectId,
          name: item.name,
          storage_path: storagePath,
          size: item.size ?? bytes.length,
          mime_type: item.file?.mimeType || "application/pdf",
          kind: "certificate",
          sharepoint_source_id: item.id,
          source_created_at: item.createdDateTime || null,
          sharepoint_synced_at: new Date().toISOString(),
          sharepoint_path: item.webUrl || "synced-from-sharepoint",
        }).select("id").single();
        if (insErr || !insertedRow) {
          console.error(`Files insert failed for ${item.name}: ${insErr?.message}`);
          await admin.storage.from("project-files").remove([storagePath]);
          summary[ROOT_CERT_KEY].errors++;
          continue;
        }

        existing.set(item.id, { id: insertedRow.id, needsSourceDate: false });
        summary[ROOT_CERT_KEY].added++;
      } catch (e) {
        console.error(`Root cert sync failed for ${item.name}:`, e);
        summary[ROOT_CERT_KEY].errors++;
      }
    }

    return json({
      ok: true,
      project: { id: projectId, name: project.name, hwiCode },
      sharepointFolder: projectFolderPath,
      summary,
    });
  } catch (e) {
    console.error("sync-files-from-sharepoint failed:", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
