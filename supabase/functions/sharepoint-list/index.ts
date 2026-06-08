// Supabase Edge Function: sharepoint-list
// Admin debug utility: lists the contents of a folder in the SharePoint
// document library configured for PO sync. Useful for verifying the folder
// structure before / after enabling auto-sync, and for sanity-checking
// that the Files.ReadWrite.All permission landed correctly.
//
// POST body:
//   { path: string }    folder path within the library root
//                       (e.g. "Hydro-Wates/Commercial Proposals/2025")
//                       (empty string = library root)
//
// Returns: list of immediate children at that path (folders and files),
// sorted by last-modified-date descending.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Debug utility — gate behind a static inspection key passed via header,
  // so it can be called from anywhere with the right key but is opaque to
  // anyone who doesn't have it. Read-only, no mutation.
  const inspectKey = Deno.env.get("INSPECT_KEY") || "inspect-2026-06-03";
  const headerKey = req.headers.get("x-inspect-key") ?? "";
  if (headerKey !== inspectKey) {
    return json({ error: "Missing or invalid x-inspect-key header" }, 403);
  }

  try {
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    // Mode selector. Supports the original folder-walking mode plus three
    // new modes for inspecting SharePoint *Lists* (which are a different
    // Graph object from Drive folders). The new modes are needed to wire
    // up the loadout-list → inventory-list → asset-folder cert sync.
    //
    //   mode="folder"       (default) — list children at `path`
    //   mode="sp-lists"     — enumerate every SharePoint List on the site
    //   mode="sp-columns"   — show column schema for list named `listName`
    //   mode="sp-items"     — show items in list `listName` (up to top=10)
    const mode = String(body?.mode ?? "folder");
    const path = String(body?.path ?? "");
    const listName = String(body?.listName ?? "");
    const top = Math.min(50, Number(body?.top ?? 10));

    const hostname = Deno.env.get("SHAREPOINT_PO_HOSTNAME") || "hydrowates.sharepoint.com";
    const sitePath = Deno.env.get("SHAREPOINT_PO_SITE_PATH") || "";

    const token = await graphToken();

    // 1. Resolve site
    const sitePathPart = sitePath && sitePath !== "/" ? `:${sitePath}` : "";
    const siteResp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${hostname}${sitePathPart}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!siteResp.ok) {
      return json({
        error: `Site lookup failed (${siteResp.status})`,
        detail: await siteResp.text(),
      }, 500);
    }
    const site = await siteResp.json();

    // ----- New SharePoint Lists modes -----

    if (mode === "sp-lists") {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${site.id}/lists?$select=id,displayName,name,list,webUrl`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!r.ok) return json({ error: `Lists query failed (${r.status})`, detail: await r.text() }, 500);
      const j = await r.json();
      const lists = (j.value ?? []).map((l: Record<string, unknown>) => ({
        id: l.id,
        displayName: l.displayName,
        name: l.name,
        template: (l.list as { template?: string } | undefined)?.template,
        webUrl: l.webUrl,
      }));
      return json({ siteId: site.id, siteName: site.displayName, listCount: lists.length, lists });
    }

    async function findList(name: string) {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${site.id}/lists?$select=id,displayName,name`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = await r.json();
      const lower = name.trim().toLowerCase();
      return (j.value ?? []).find((l: { displayName?: string; name?: string }) =>
        l.displayName?.toLowerCase() === lower || l.name?.toLowerCase() === lower
      );
    }

    if (mode === "sp-columns") {
      if (!listName) return json({ error: "listName is required for sp-columns mode" }, 400);
      const found = await findList(listName);
      if (!found) return json({ error: `List "${listName}" not found on site` }, 404);
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${site.id}/lists/${found.id}/columns?$select=name,displayName,description,columnGroup,hidden,readOnly,required`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = await r.json();
      const columns = (j.value ?? [])
        .filter((c: { hidden?: boolean }) => !c.hidden)
        .map((c: Record<string, unknown>) => ({
          name: c.name,
          displayName: c.displayName,
          description: c.description,
          group: c.columnGroup,
          readOnly: c.readOnly,
          required: c.required,
        }));
      return json({ siteId: site.id, listId: found.id, listName: found.displayName, columnCount: columns.length, columns });
    }

    if (mode === "sp-items") {
      if (!listName) return json({ error: "listName is required for sp-items mode" }, 400);
      const found = await findList(listName);
      if (!found) return json({ error: `List "${listName}" not found on site` }, 404);
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${site.id}/lists/${found.id}/items?expand=fields&$top=${top}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const j = await r.json();
      const items = (j.value ?? []).map((it: Record<string, unknown>) => ({
        id: it.id,
        fields: it.fields,
        webUrl: it.webUrl,
      }));
      return json({ siteId: site.id, listId: found.id, listName: found.displayName, itemCount: items.length, sampleItems: items });
    }

    // ----- Default: folder children walk -----

    // 2. Get default drive (the Documents/Shared Documents library)
    const driveResp = await fetch(
      `https://graph.microsoft.com/v1.0/sites/${site.id}/drive`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!driveResp.ok) {
      return json({
        error: `Drive lookup failed (${driveResp.status})`,
        detail: await driveResp.text(),
      }, 500);
    }
    const drive = await driveResp.json();

    // 3. List children at the path
    const listUrl = path
      ? `https://graph.microsoft.com/v1.0/drives/${drive.id}/root:/${encodeURI(path)}:/children?$top=100&$orderby=lastModifiedDateTime desc`
      : `https://graph.microsoft.com/v1.0/drives/${drive.id}/root/children?$top=100&$orderby=lastModifiedDateTime desc`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!listResp.ok) {
      return json({
        error: `List failed (${listResp.status})`,
        detail: await listResp.text(),
        listedPath: path,
      }, 500);
    }
    const listJson = await listResp.json();

    const items = (listJson.value ?? []).map((it: Record<string, unknown>) => ({
      name: it.name,
      kind: it.folder ? "folder" : "file",
      lastModified: it.lastModifiedDateTime,
      size: it.size,
      childCount: (it.folder as { childCount?: number } | undefined)?.childCount,
      webUrl: it.webUrl,
    }));

    return json({
      siteId: site.id,
      siteName: site.displayName,
      driveId: drive.id,
      driveName: drive.name,
      path: path || "(root)",
      itemCount: items.length,
      items,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
