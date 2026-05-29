// Supabase Edge Function: sync-leads
// Pulls "LeadComments" from the SharePoint "Lead List" (via Microsoft Graph)
// into projects.lead_comments, matching each lead's QuoteNum to a project name.
// Read-only against SharePoint. Callable by an admin or the scheduled cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TENANT = Deno.env.get("SHAREPOINT_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("SHAREPOINT_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("SHAREPOINT_CLIENT_SECRET")!;

// Discovered IDs for the Hydro-Wates "Lead List" (stable):
const SITE_ID = "hydrowates.sharepoint.com,4cf8dd27-3d13-4243-8f37-6ec35f0d1ece,f2e7a899-93ae-47c6-bae1-e7df6ecfe451";
const LIST_ID = "039ab20f-42ee-404a-a4dd-ee47d7463084";
const MATCH_FIELD = "QuoteNum";        // matched (trimmed, case-insensitive) against a project's name
const COMMENTS_FIELD = "LeadComments"; // the description text shown as "Lead notes"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

async function graphToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("Graph token failed: " + JSON.stringify(j));
  return j.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  let allowed = false;
  if (token && token === serviceKey) {
    allowed = true;
  } else if (token) {
    const { data: { user } } = await admin.auth.getUser(token);
    if (user) {
      const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
      if (profile?.role === "admin") allowed = true;
    }
  }
  if (!allowed) return json({ error: "Not authorized" }, 403);

  try {
    const accessToken = await graphToken();

    // Fetch all Lead List items (paginated)
    const leads: Record<string, unknown>[] = [];
    let url: string | null =
      `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/items?expand=fields&$top=200`;
    while (url) {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = await r.json();
      if (data.error) throw new Error("Graph list error: " + JSON.stringify(data.error));
      for (const it of data.value ?? []) leads.push(it.fields ?? {});
      url = (data["@odata.nextLink"] as string | undefined) ?? null;
    }

    // Map project name -> id (trimmed, lower-cased)
    const { data: projects } = await admin.from("projects").select("id, name");
    const byName = new Map<string, string>();
    for (const p of projects ?? []) byName.set(String(p.name).trim().toLowerCase(), p.id);

    let matched = 0;
    for (const f of leads) {
      const q = String(f[MATCH_FIELD] ?? "").trim();
      const comments = String(f[COMMENTS_FIELD] ?? "").trim();
      if (!q || !comments) continue;
      const projectId = byName.get(q.toLowerCase());
      if (!projectId) continue;
      const { error } = await admin.from("projects").update({ lead_comments: comments }).eq("id", projectId);
      if (!error) matched++;
    }

    return json({ ok: true, leadsScanned: leads.length, projectsMatched: matched, at: new Date().toISOString() });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
