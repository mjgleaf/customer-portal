// Supabase Edge Function: sync-projects-from-sharepoint
//
// Pre-award jobs never reach Zoho Books — they exist only as folders under
// SharePoint's "<YYYY> Commercial Proposals" trees (one per entity):
//
//   Hydro-Wates/Commercial Proposals/2026 Commercial Proposals/HWI-26-254, Acme, Load Test/
//   Sentinel Instruments/Commercial Proposals/2026 Commercial Proposals/Q26012, ...
//
// This function walks the CURRENT YEAR's folder in both trees and creates a
// portal project (status 'quoted', no zoho_project_id) for every job-coded
// folder that doesn't already have a portal project. When the job is later
// awarded and shows up in Zoho Books, sync-zoho claims the quoted row by job
// code instead of inserting a duplicate — see the claim pass there.
//
// Customer linking is best-effort from the folder name: every comma-separated
// segment after the job code ("HWI-26-084, Waterbag Rental, Kent PLC,
// 02-23-2026" -> "Waterbag Rental" + "Kent PLC") is tried against
// cportal_customers.company/name. Only a unique, confident match is used;
// otherwise the project is created unassigned and an admin can link it. Rows
// that stay unlinked are re-matched every run (see the relink pass), so a
// customer created later — e.g. by sync-zoho at award time — links up then.
// When a customer IS matched, their portal profile (if any) is auto-added as
// a project member — same convention as sync-zoho — so the company's users
// can see the quoted job right away.
//
// Deliberately never deletes: a proposal folder that disappears (lost quote,
// renamed folder) leaves the portal row behind for an admin to remove.
//
// Admin-only (or service-role, for the hourly pg_cron job).

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

async function getSiteId(hostname: string, sitePath: string, token: string): Promise<string> {
  const path = sitePath && sitePath !== "/" ? `:${sitePath}` : "";
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${hostname}${path}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!r.ok) throw new Error(`Site lookup failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  if (!j.id) throw new Error("Site lookup returned no id");
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

async function listChildren(driveId: string, path: string, token: string) {
  const url = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(path)}:/children?$top=999`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`List "${path}" failed (${r.status}): ${await r.text()}`);
  const j = await r.json();
  return (j.value ?? []) as Array<{
    id?: string;
    name?: string;
    folder?: unknown;
    createdDateTime?: string;
  }>;
}

// Same job-code convention as upload-po-to-sharepoint: Hydro-Wates jobs are
// "HWI-26-254"-style, Sentinel Instruments jobs are "Q26001"-style.
function parseJobCode(name: string): string | null {
  const hwi = name.match(/^(HWI-\d{2}-\d+)/i);
  if (hwi) return hwi[1].toUpperCase();
  const q = name.match(/^(Q\d{5})\b/i);
  if (q) return q[1].toUpperCase();
  return null;
}

// Folder names follow "CODE, Description, Customer, MM-DD-YYYY" — but the
// segment order isn't reliable enough to trust positionally, so every
// comma-separated segment (minus obvious dates) is a candidate for customer
// matching.
function candidateSegments(name: string, jobCode: string): string[] {
  const rest = name.slice(jobCode.length).replace(/^[,\s]+/, "");
  return rest
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !/^\d{1,2}-\d{1,2}-\d{2,4}$/.test(s));
}

function normCompany(s: string): string {
  return s
    .toLowerCase()
    // Company-suffix noise ("Acme Crane, Inc." vs "Acme Crane LLC") must not
    // block a match; strip the common suffixes and punctuation before
    // comparing.
    .replace(/[.,']/g, "")
    .replace(/\b(inc|llc|ltd|co|corp|corporation|company|lp|llp)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Auth: admins or service-role (pg_cron) only.
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
  if (!isServiceRole) {
    const { data: { user } } = await admin.auth.getUser(authToken);
    if (!user) return json({ error: "Not authorized" }, 401);
    const { data: profile } = await admin.from("cportal_profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") return json({ error: "Admins only" }, 403);
  }

  try {
    const hostname = Deno.env.get("SHAREPOINT_PO_HOSTNAME") || "hydrowates.sharepoint.com";
    const sitePath = Deno.env.get("SHAREPOINT_PO_SITE_PATH") || "";
    const roots = [
      (Deno.env.get("SHAREPOINT_PO_ROOT_FOLDER") || "Hydro-Wates/Commercial Proposals").trim(),
      (Deno.env.get("SHAREPOINT_SENTINEL_ROOT_FOLDER") || "Sentinel Instruments/Commercial Proposals").trim(),
    ];
    const year = new Date().getFullYear();

    const token = await graphToken();
    const siteId = await getSiteId(hostname, sitePath, token);
    const driveId = await getDefaultDriveId(siteId, token);

    // Every existing portal project's job code — Zoho-synced or quoted, the
    // folder is already represented either way, so skip it.
    const { data: existingProjects } = await admin
      .from("cportal_projects").select("id, name, status, customer_id");
    const knownCodes = new Set<string>();
    for (const p of existingProjects ?? []) {
      const code = parseJobCode(String(p.name ?? ""));
      if (code) knownCodes.add(code);
    }

    // Customers + profiles for the best-effort link / member auto-add.
    const { data: customers } = await admin
      .from("cportal_customers").select("id, name, company, email");
    const { data: profiles } = await admin.from("cportal_profiles").select("id, email");
    const profileByEmail = new Map<string, string>();
    for (const pf of profiles ?? []) {
      if (pf.email) profileByEmail.set(String(pf.email).toLowerCase(), pf.id);
    }

    // Unique-match lookup: normalized company/name -> customer id, with
    // ambiguous keys (two customers normalizing to the same string) dropped.
    const byNorm = new Map<string, { id: string; email: string | null } | null>();
    for (const c of customers ?? []) {
      for (const field of [c.company, c.name]) {
        const key = normCompany(String(field ?? ""));
        if (!key) continue;
        if (byNorm.has(key) && byNorm.get(key)?.id !== c.id) byNorm.set(key, null); // ambiguous
        else byNorm.set(key, { id: c.id, email: c.email ?? null });
      }
    }
    // Word-boundary containment: does `needle` appear in `hay` as whole
    // words? Guards against "test" matching inside "1 Ton Crane Test"-style
    // description segments — plain substring containment linked exactly that.
    function containsWords(hay: string, needle: string): boolean {
      return ` ${hay} `.includes(` ${needle} `);
    }

    function matchCustomer(segments: string[]): { id: string; email: string | null } | null {
      // Pass 1: exact normalized match on any segment. A folder name can
      // only link when every matching segment agrees on ONE customer.
      let found: { id: string; email: string | null } | null = null;
      for (const seg of segments) {
        const hit = byNorm.get(normCompany(seg));
        if (!hit) continue; // no match, or ambiguous key (null)
        if (found && found.id !== hit.id) return null;
        found = hit;
      }
      if (found) return found;
      // Pass 2: containment fallback ("Acme" vs "Acme Crane & Rigging"),
      // word-boundary only, and only for keys long enough to be meaningful —
      // short tokens like "test" appear inside description segments.
      for (const seg of segments) {
        const key = normCompany(seg);
        if (!key) continue;
        for (const [k, v] of byNorm) {
          if (!v) continue;
          if (Math.min(k.length, key.length) < 6) continue;
          if (!containsWords(k, key) && !containsWords(key, k)) continue;
          if (found && found.id !== v.id) return null; // ambiguous
          found = v;
        }
      }
      return found;
    }

    const summary = {
      year,
      scanned: 0,
      created: 0,
      skippedExisting: 0,
      noJobCode: 0,
      customerMatched: 0,
      relinked: 0,
      membersAdded: 0,
      errors: [] as string[],
    };

    // Attach the matched customer's portal profile as a project member (same
    // convention as sync-zoho; the unique constraint makes re-adds harmless).
    async function addMemberFor(projectId: string, customer: { email: string | null }) {
      const email = customer.email?.toLowerCase();
      const userId = email ? profileByEmail.get(email) : undefined;
      if (!userId) return;
      const { data: already } = await admin
        .from("cportal_project_members")
        .select("id").eq("project_id", projectId).eq("user_id", userId).maybeSingle();
      if (already) return;
      const { error } = await admin
        .from("cportal_project_members")
        .insert({ project_id: projectId, user_id: userId });
      if (!error) summary.membersAdded++;
    }

    for (const rootPath of roots) {
      const yearFolderPath = `${rootPath}/${year} Commercial Proposals`;
      let children: Awaited<ReturnType<typeof listChildren>>;
      try {
        children = await listChildren(driveId, yearFolderPath, token);
      } catch (e) {
        // A missing year folder (e.g. Sentinel hasn't quoted anything yet
        // this year) isn't an error worth failing the run over.
        const msg = String((e as Error).message);
        if (msg.includes("404") || msg.includes("itemNotFound")) continue;
        summary.errors.push(`${yearFolderPath}: ${msg}`);
        continue;
      }

      for (const item of children) {
        if (!item.folder || !item.name) continue;
        summary.scanned++;
        const code = parseJobCode(item.name);
        if (!code) { summary.noJobCode++; continue; }
        if (knownCodes.has(code)) { summary.skippedExisting++; continue; }

        const customer = matchCustomer(candidateSegments(item.name, code));
        if (customer) summary.customerMatched++;

        const { data: inserted, error: insErr } = await admin.from("cportal_projects").insert({
          name: item.name,
          description: null,
          status: "quoted",
          customer_id: customer?.id ?? null,
          started_on: item.createdDateTime ?? null,
          updated_at: new Date().toISOString(),
        }).select("id").single();
        if (insErr || !inserted) {
          summary.errors.push(`${item.name}: ${insErr?.message ?? "insert failed"}`);
          continue;
        }
        knownCodes.add(code);
        summary.created++;
        console.log(`[quoted] created "${item.name}" customer=${customer ? customer.id : "unmatched"}`);

        if (customer) await addMemberFor(inserted.id, customer);
      }
    }

    // Relink pass: quoted rows that still have no customer get re-matched
    // every run. Pre-award customers often don't exist in the portal yet —
    // once Zoho (or an admin) creates them, the next hourly run links the
    // quoted job automatically. Never overrides a non-null customer_id, so
    // manual admin assignments stick.
    for (const p of existingProjects ?? []) {
      if (p.status !== "quoted" || p.customer_id) continue;
      const code = parseJobCode(String(p.name ?? ""));
      if (!code) continue;
      const customer = matchCustomer(candidateSegments(String(p.name), code));
      if (!customer) continue;
      const { error } = await admin
        .from("cportal_projects")
        .update({ customer_id: customer.id, updated_at: new Date().toISOString() })
        .eq("id", p.id)
        .is("customer_id", null);
      if (error) {
        summary.errors.push(`relink ${p.name}: ${error.message}`);
        continue;
      }
      summary.relinked++;
      await addMemberFor(p.id, customer);
    }

    return json({ ok: true, summary });
  } catch (e) {
    console.error("sync-projects-from-sharepoint failed:", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
