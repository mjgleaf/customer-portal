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

// ---- SharePoint List helpers (for the equipment cert pipeline) ----

const listIdCache = new Map<string, string>();
async function getListId(siteId: string, listName: string, token: string): Promise<string | null> {
  const cacheKey = `${siteId}/${listName}`;
  if (listIdCache.has(cacheKey)) return listIdCache.get(cacheKey)!;
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/lists?$select=id,displayName,name`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`Lists query failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  const lower = listName.trim().toLowerCase();
  const found = (j.value ?? []).find((l: { displayName?: string; name?: string }) =>
    l.displayName?.toLowerCase() === lower || l.name?.toLowerCase() === lower,
  );
  if (!found?.id) return null;
  listIdCache.set(cacheKey, found.id as string);
  return found.id as string;
}

// Generic paginated list-items fetch with a $filter. Uses the
// HonorNonIndexedQueriesWarningMayFailRandomly Prefer header so we don't
// have to maintain SharePoint column indexes; for low-volume admin use
// that's a fine trade-off.
async function fetchListItems(
  siteId: string,
  listId: string,
  filterClause: string,
  selectFields: string[],
  token: string,
): Promise<Array<Record<string, unknown>>> {
  const expand = `fields(select=${selectFields.join(",")})`;
  let url = `https://graph.microsoft.com/v1.0/sites/${siteId}/lists/${listId}/items?expand=${expand}&$filter=${encodeURIComponent(filterClause)}&$top=500`;
  const out: Array<Record<string, unknown>> = [];
  for (let page = 0; page < 20 && url; page++) {
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly",
      },
    });
    if (!r.ok) {
      throw new Error(`List items fetch failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
    }
    const j = await r.json();
    for (const it of (j.value ?? [])) out.push(it.fields ?? {});
    url = (j["@odata.nextLink"] as string) || "";
  }
  return out;
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

// Map SharePoint subfolder name -> portal file kind + format filter.
//
// Equipment certificates are NOT pulled from the project's "Inspection
// Documents" subfolder anymore — that turned out to be a brittle data
// source (humans had to file calibration certs into each project's folder
// manually, with no validation against what actually shipped).
//
// The new pipeline (handled below the subfolder loop):
//   Load Out List (SharePoint List) -> equipment assembly SNs actually shipped
//   -> Hydro-Wates Inventory (SharePoint List) -> per-equipment FolderPath
//   -> walk that folder for PDF cert files.
const SUBFOLDER_MAP: Array<{
  spName: string;
  portalKind: string;
  pdfOnly: boolean;
  label: string;
}> = [
  { spName: "Purchase Order",      portalKind: "purchase_order",         pdfOnly: false, label: "POs" },
  { spName: "Quote",               portalKind: "quote",                  pdfOnly: true,  label: "quotes (PDF only)" },
];

// SharePoint List names used by the equipment-cert pipeline.
const LOADOUT_LIST_NAME   = "Load Out List";
const INVENTORY_LIST_NAME = "Hydro-Wates Inventory";

// Hydro-Wates' SharePoint stores FolderPath values as
// "/Shared Documents/<rest of path>". The Drive API walks paths
// relative to the document library root, so strip the prefix.
function stripSharedDocsPrefix(path: string): string {
  return path.replace(/^\/?Shared Documents\/?/i, "").replace(/^\/+/, "");
}

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
  let callerIsServiceTech = false;
  if (!isServiceRole) {
    const { data: { user } } = await admin.auth.getUser(authToken);
    if (!user) return json({ error: "Not authorized" }, 401);
    callerUserId = user.id;
    const { data: profile } = await admin.from("cportal_profiles").select("role").eq("id", user.id).single();
    callerIsAdmin = profile?.role === "admin";
    callerIsServiceTech = profile?.role === "service_tech";
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

    // Non-admin, non-service callers must be allowed to access this
    // specific project. Mirrors cportal_can_access_project(), inlined.
    if (!isServiceRole && !callerIsAdmin && callerUserId) {
      let hasAccess = false;
      // Check 1: service tech + project is Service-type? Techs get blanket
      // access to every Service-type project (no per-project assignment).
      if (callerIsServiceTech) {
        const { data: projectRow } = await admin
          .from("cportal_projects")
          .select("project_type")
          .eq("id", projectId)
          .single();
        if (projectRow?.project_type === "Service") hasAccess = true;
      }
      // Check 2: explicit project_members row?
      if (!hasAccess) {
        const { data: memberRow } = await admin
          .from("cportal_project_members")
          .select("id")
          .eq("project_id", projectId)
          .eq("user_id", callerUserId)
          .maybeSingle();
        if (memberRow) hasAccess = true;
      }
      // Check 3: email match on the project's customer record?
      if (!hasAccess) {
        const { data: callerProfile } = await admin
          .from("cportal_profiles")
          .select("email")
          .eq("id", callerUserId)
          .single();
        const callerEmail = (callerProfile?.email ?? "").toLowerCase();
        if (callerEmail) {
          const { data: projectRow } = await admin
            .from("cportal_projects")
            .select("customer:cportal_customers(email)")
            .eq("id", projectId)
            .single();
          const projectCustomerEmail = (projectRow?.customer as { email?: string | null } | null)?.email?.toLowerCase() ?? "";
          if (projectCustomerEmail && projectCustomerEmail === callerEmail) hasAccess = true;
        }
      }
      if (!hasAccess) return json({ error: "Not authorized for this project" }, 403);
    }

    const { data: project } = await admin
      .from("cportal_projects")
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
      .from("cportal_files")
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
              .from("cportal_files")
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

        // Reference-only insert: we don't download bytes or upload to
        // Supabase Storage. The frontend fetches a fresh Graph download URL
        // when the customer clicks the file. sharepoint_source_id is the
        // lookup key for that download URL.
        try {
          const { data: insertedRow, error: insErr } = await admin.from("cportal_files").insert({
            project_id: projectId,
            name: item.name,
            storage_path: null,
            size: item.size ?? null,
            mime_type: item.file?.mimeType || null,
            kind: sub.portalKind,
            sharepoint_source_id: item.id,
            source_created_at: item.createdDateTime || null,
            sharepoint_synced_at: new Date().toISOString(),
            sharepoint_path: item.webUrl || "synced-from-sharepoint",
          }).select("id").single();
          if (insErr || !insertedRow) {
            console.error(`Files insert failed for ${item.name}: ${insErr?.message}`);
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

    // 3.5 Equipment certificates via loadout → inventory → asset folder.
    // This is the reference-only pipeline: we don't download PDF bytes,
    // we just record metadata in the files table with sharepoint_source_id
    // set. The frontend fetches a fresh Graph download URL on click via
    // get-sharepoint-download-url.
    //
    // Skipped when certsOnly is set (the cert-only bulk run is specifically
    // for project-root test reports, not equipment).
    summary["Equipment certificates (loadout)"] = { added: 0, skipped: 0, backfilled: 0, pdfFiltered: 0, errors: 0 };
    if (!certsOnly) {
      try {
        const loadoutListId = await getListId(siteId, LOADOUT_LIST_NAME, token);
        const inventoryListId = await getListId(siteId, INVENTORY_LIST_NAME, token);
        if (!loadoutListId || !inventoryListId) {
          throw new Error(`SharePoint list lookup failed (loadout=${!!loadoutListId}, inventory=${!!inventoryListId})`);
        }

        // (a) Find the equipment shipped on this job. JobNumber is text on
        // the Load Out List, so we filter on it directly.
        const loadoutRows = await fetchListItems(
          siteId,
          loadoutListId,
          `fields/JobNumber eq '${hwiCode}'`,
          ["JobNumber", "AssemblySN", "Description", "CartEqCateg"],
          token,
        );
        const assemblySNs = new Set<string>();
        for (const row of loadoutRows) {
          const sn = (row.AssemblySN as string | undefined)?.trim();
          if (sn) assemblySNs.add(sn);
        }

        // (b) For each unique equipment assembly SN, look up its FolderPath
        // in the Inventory list and walk that folder for cert PDFs.
        for (const sn of assemblySNs) {
          let folderPath: string | null = null;
          try {
            const invRows = await fetchListItems(
              siteId,
              inventoryListId,
              `fields/Title eq '${sn.replace(/'/g, "''")}'`,
              ["Title", "AssemblySerialNumber", "FolderPath"],
              token,
            );
            folderPath = (invRows[0]?.FolderPath as string | undefined) ?? null;
          } catch (e) {
            console.warn(`Inventory lookup failed for ${sn}: ${(e as Error).message}`);
            continue;
          }
          if (!folderPath) continue; // equipment isn't in inventory, or no folder configured

          // FolderPath comes in as "/Shared Documents/<rest>" — strip the
          // library prefix so the Drive walk works from the doc root.
          const drivePath = stripSharedDocsPrefix(folderPath);
          let assetItems: Awaited<ReturnType<typeof listChildren>> = [];
          try {
            assetItems = await listChildren(driveId, drivePath, token);
          } catch (e) {
            // Folder may have been moved/renamed/deleted — skip quietly,
            // don't fail the entire sync.
            console.warn(`Asset folder walk failed for ${sn} at "${drivePath}": ${(e as Error).message}`);
            continue;
          }

          for (const item of assetItems) {
            if (item.folder || !item.id || !item.name) continue;
            if (!isPdf(item)) continue; // PDFs only

            const prior = existing.get(item.id);
            if (prior) {
              if (prior.needsSourceDate && item.createdDateTime) {
                const { error: updErr } = await admin
                  .from("cportal_files")
                  .update({ source_created_at: item.createdDateTime })
                  .eq("id", prior.id);
                if (!updErr) {
                  prior.needsSourceDate = false;
                  summary["Equipment certificates (loadout)"].backfilled++;
                }
              }
              summary["Equipment certificates (loadout)"].skipped++;
              continue;
            }

            // Reference-only insert: no storage upload, no bytes downloaded.
            // storage_path is null on purpose; the frontend hits
            // get-sharepoint-download-url when a customer clicks the file.
            try {
              const { data: insertedRow, error: insErr } = await admin.from("cportal_files").insert({
                project_id: projectId,
                name: item.name,
                storage_path: null,
                size: item.size ?? null,
                mime_type: item.file?.mimeType || "application/pdf",
                kind: "equipment_certificate",
                sharepoint_source_id: item.id,
                source_created_at: item.createdDateTime || null,
                sharepoint_synced_at: new Date().toISOString(),
                sharepoint_path: item.webUrl || folderPath,
              }).select("id").single();
              if (insErr || !insertedRow) {
                console.error(`Equipment cert insert failed for ${item.name}: ${insErr?.message}`);
                summary["Equipment certificates (loadout)"].errors++;
                continue;
              }
              existing.set(item.id, { id: insertedRow.id, needsSourceDate: false });
              summary["Equipment certificates (loadout)"].added++;
            } catch (e) {
              console.error(`Equipment cert sync failed for ${item.name}:`, e);
              summary["Equipment certificates (loadout)"].errors++;
            }
          }
        }
      } catch (e) {
        console.error("Loadout-based equipment cert sync failed:", e);
        summary["Equipment certificates (loadout)"].errors++;
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
            .from("cportal_files")
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

      // Reference-only insert: no bytes downloaded, no Supabase Storage.
      try {
        const { data: insertedRow, error: insErr } = await admin.from("cportal_files").insert({
          project_id: projectId,
          name: item.name,
          storage_path: null,
          size: item.size ?? null,
          mime_type: item.file?.mimeType || "application/pdf",
          kind: "certificate",
          sharepoint_source_id: item.id,
          source_created_at: item.createdDateTime || null,
          sharepoint_synced_at: new Date().toISOString(),
          sharepoint_path: item.webUrl || "synced-from-sharepoint",
        }).select("id").single();
        if (insErr || !insertedRow) {
          console.error(`Files insert failed for ${item.name}: ${insErr?.message}`);
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
