// Supabase Edge Function: get-sharepoint-download-url
//
// Takes a `fileId` (from the `files` table), verifies the caller can access
// the file's project, and returns a short-lived Microsoft Graph download
// URL. The frontend uses this for reference-only files (i.e. ones whose
// bytes live in SharePoint, not Supabase Storage).
//
// Why short-lived: the URL itself is anonymous-for-15-minutes; anyone who
// has it can download without further auth. So we don't leak it widely —
// we generate one per click and let the browser navigate to it.

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

// Cache the default drive ID per process run — saves one Graph call per
// invocation. Edge functions get recycled often so this is best-effort.
let cachedDriveId: string | null = null;
async function getDefaultDriveId(token: string): Promise<string> {
  if (cachedDriveId) return cachedDriveId;
  const hostname = Deno.env.get("SHAREPOINT_PO_HOSTNAME") || "hydrowates.sharepoint.com";
  const sitePath = Deno.env.get("SHAREPOINT_PO_SITE_PATH") || "";
  const sitePathPart = sitePath && sitePath !== "/" ? `:${sitePath}` : "";
  const siteResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}${sitePathPart}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!siteResp.ok) throw new Error(`Site lookup failed (${siteResp.status})`);
  const site = await siteResp.json();
  const driveResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${site.id}/drive`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!driveResp.ok) throw new Error(`Drive lookup failed (${driveResp.status})`);
  const drive = await driveResp.json();
  cachedDriveId = drive.id as string;
  return cachedDriveId;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Verify caller is authenticated. We don't require admin — any logged-in
  // user can request a URL for a file they have access to. Access is then
  // checked via the project's RLS rules (admin OR project_members OR
  // matching customer email).
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 401);

  try {
    const body = await req.json();
    const fileId = body?.fileId as string | undefined;
    // mode="download" (default): returns the @microsoft.graph.downloadUrl,
    //   which forces the browser to download (Content-Disposition: attachment).
    //   Right for the Download button.
    // mode="preview": calls Graph's /preview action, which returns an
    //   embeddable viewer URL that renders in an iframe. Right for the
    //   Preview modal.
    const mode = (body?.mode === "preview" ? "preview" : "download") as "preview" | "download";
    if (!fileId) return json({ error: "fileId is required" }, 400);

    // Look up the file row. We use the admin client to read it (service
    // role bypasses RLS), then manually verify access against the project.
    const { data: file } = await admin
      .from("files")
      .select("id, project_id, name, sharepoint_source_id")
      .eq("id", fileId)
      .single();
    if (!file) return json({ error: "File not found" }, 404);
    if (!file.sharepoint_source_id) {
      return json({ error: "This file is not in SharePoint; use Supabase Storage signed URL instead" }, 400);
    }

    // Access check: admin, project_member, OR customer email match.
    const { data: profile } = await admin.from("profiles").select("role, email").eq("id", user.id).single();
    const isAdmin = profile?.role === "admin";
    if (!isAdmin) {
      const { data: member } = await admin
        .from("project_members")
        .select("id")
        .eq("project_id", file.project_id)
        .eq("user_id", user.id)
        .maybeSingle();
      let hasAccess = !!member;
      if (!hasAccess) {
        const callerEmail = (profile?.email ?? "").toLowerCase();
        if (callerEmail) {
          const { data: project } = await admin
            .from("projects")
            .select("customer:customers(email)")
            .eq("id", file.project_id)
            .single();
          const projCustomerEmail = (project?.customer as { email?: string } | null)?.email?.toLowerCase() ?? "";
          if (projCustomerEmail && projCustomerEmail === callerEmail) hasAccess = true;
        }
      }
      if (!hasAccess) return json({ error: "Not authorized for this file" }, 403);
    }

    const graphTok = await graphToken();
    const driveId = await getDefaultDriveId(graphTok);

    if (mode === "preview") {
      // POST /drives/{drive-id}/items/{item-id}/preview returns a getUrl
      // that's safe to drop into an iframe — same renderer SharePoint uses
      // for its own inline file viewer.
      const previewResp = await fetch(
        `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${file.sharepoint_source_id}/preview`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${graphTok}`, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (!previewResp.ok) {
        const detail = await previewResp.text();
        return json({ error: `Graph preview failed (${previewResp.status})`, detail: detail.slice(0, 200) }, 502);
      }
      const previewJson = await previewResp.json();
      const previewUrl = previewJson.getUrl as string | undefined;
      if (!previewUrl) {
        return json({ error: "Graph preview returned no getUrl" }, 502);
      }
      return json({
        ok: true,
        url: previewUrl,
        // Kept for backward compat with any older frontend code that reads `downloadUrl`.
        downloadUrl: previewUrl,
        mode: "preview",
        filename: file.name,
      });
    }

    // mode === "download": fetch the Drive item to get its short-lived
    // anonymous downloadUrl. ~15 min validity.
    const itemResp = await fetch(
      `https://graph.microsoft.com/v1.0/drives/${driveId}/items/${file.sharepoint_source_id}?select=@microsoft.graph.downloadUrl,name,size,file,webUrl`,
      { headers: { Authorization: `Bearer ${graphTok}` } },
    );
    if (!itemResp.ok) {
      const detail = await itemResp.text();
      return json({ error: `Graph item lookup failed (${itemResp.status})`, detail: detail.slice(0, 200) }, 502);
    }
    const item = await itemResp.json();
    const downloadUrl = item["@microsoft.graph.downloadUrl"] as string | undefined;
    if (!downloadUrl) {
      return json({ error: "Graph response had no @microsoft.graph.downloadUrl" }, 502);
    }

    return json({
      ok: true,
      url: downloadUrl,
      downloadUrl,
      mode: "download",
      filename: item.name ?? file.name,
      size: item.size ?? null,
      mimeType: item.file?.mimeType ?? null,
      webUrl: item.webUrl ?? null,
      validForSeconds: 900,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
