// Supabase Edge Function: sync-leads
// Pulls fields from the SharePoint "Lead List" (via Microsoft Graph) into
// each matched project. For each lead matched by QuoteNum -> project.name:
//   - LeadComments -> projects.lead_comments (shown as "Project scope")
//   - LeadEmail    -> auto-add the user to project_members (only if a
//                     profile with that email already exists in the portal)
// Read-only against SharePoint. Callable by an admin or the scheduled cron.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { isServiceRoleToken } from "../_shared/auth.ts";

const TENANT = Deno.env.get("SHAREPOINT_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("SHAREPOINT_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("SHAREPOINT_CLIENT_SECRET")!;

// Discovered IDs for the Hydro-Wates "Lead List" (stable):
const SITE_ID = "hydrowates.sharepoint.com,4cf8dd27-3d13-4243-8f37-6ec35f0d1ece,f2e7a899-93ae-47c6-bae1-e7df6ecfe451";
const LIST_ID = "039ab20f-42ee-404a-a4dd-ee47d7463084";
const MATCH_FIELD = "QuoteNum";         // matched (trimmed, case-insensitive) against a project's name
const COMMENTS_FIELD = "LeadComments";  // the description text shown as "Project scope"
// SharePoint may expose the column under any of these internal names — we
// try them in order. If your column is named differently, add it here.
const EMAIL_FIELDS = ["LeadEmail", "leademail", "Lead_x0020_Email", "Email"];
// Site contact info (on-site point of contact for the service tech).
// SharePoint stores these as ContactNameOnSite / ContactPhoneOnSite —
// confirmed empirically by unioning fields across every lead row.
const SITE_CONTACT_FIELDS = ["ContactNameOnSite"];
const SITE_CONTACT_PHONE_FIELDS = ["ContactPhoneOnSite"];
// Ship-to address for the job site. The SharePoint column is "addressshipto";
// the internal name is usually the lowercased value, but we try a few common
// encodings to be safe (same approach as EMAIL_FIELDS). This is the
// authoritative ship-to — Zoho Books shipping addresses are unreliable.
const SHIPTO_FIELDS = ["addressshipto", "AddressShipTo", "AddressShipto", "addressShipTo", "Address_x0020_Ship_x0020_To", "ShipToAddress", "ShipTo"];
// Customer PO number + date, typed by hand into the pipeline app. Mirrored
// onto the project so the portal can show the customer their own PO number
// and stop asking for a PO document once one has been recorded.
const PONUM_FIELDS = ["PONum", "ponum", "PONumber", "PO_x0020_Num"];
const PODATE_FIELDS = ["PODate", "podate", "PO_x0020_Date"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// PostgREST caps every response at Supabase's max-rows setting (1000 by
// default), and supabase-js surfaces the truncated page as if it were the
// whole result. cportal_projects is past 1400 rows, so an unpaged read left
// a third of the projects invisible to the lead matcher — those jobs never
// got their scope/site-contact/ship-to fields. Page (ordered by id so pages
// don't shift) until a short page marks the end.
const PAGE_SIZE = 1000;
async function selectAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`paged select failed: ${error.message}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
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

  // Auth: a signature-verified service-role key, or an admin user JWT.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  let allowed = false;
  // Signature-verified; never trust a decoded role claim (see _shared/auth.ts).
  if (await isServiceRoleToken(token)) allowed = true;
  if (!allowed && token) {
    const { data: { user } } = await admin.auth.getUser(token);
    if (user) {
      const { data: profile } = await admin.from("cportal_profiles").select("role").eq("id", user.id).single();
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

    // Map project name -> {id, customer_id} (trimmed, lower-cased)
    const projects = await selectAll<{ id: string; name: string | null; customer_id: string | null }>(
      (a, b) => admin.from("cportal_projects").select("id, name, customer_id").order("id").range(a, b),
    );
    const byName = new Map<string, { id: string; customer_id: string | null }>();
    for (const p of projects) {
      byName.set(String(p.name).trim().toLowerCase(), { id: p.id, customer_id: p.customer_id });
    }

    let matched = 0;
    let projectTypesSet = 0;
    let siteContactsSet = 0;
    let shipToSet = 0;
    let poNumbersSet = 0;
    let membersAdded = 0;
    let contactsSynced = 0;

    // Pull up the existing sharepoint-source contacts so we can later
    // mirror-delete ones no longer in any lead.
    const seenContactKeys = new Set<string>(); // `${customer_id}::${email}`
    // Diagnostic: union every field key across every lead row. SharePoint
    // omits null/empty fields from the `?expand=fields` payload, so a
    // column that exists but is only filled on some rows won't appear if
    // we sample a single row.
    const allFieldNames = new Set<string>();
    for (const l of leads) for (const k of Object.keys(l)) allFieldNames.add(k);
    const sampleFieldNames = [...allFieldNames].sort();

    // Also fetch the LIST'S column schema for definitive ground truth.
    // This returns every defined column even if all rows are empty.
    let listColumns: { name: string; displayName: string }[] = [];
    try {
      const colResp = await fetch(
        `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/lists/${LIST_ID}/columns?$select=name,displayName`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      const colData = await colResp.json();
      listColumns = (colData.value ?? []).map((c: { name: string; displayName: string }) => ({
        name: c.name,
        displayName: c.displayName,
      }));
    } catch { /* best-effort */ }

    for (const f of leads) {
      const q = String(f[MATCH_FIELD] ?? "").trim();
      if (!q) continue;
      const project = byName.get(q.toLowerCase());
      if (!project) continue;
      const projectId = project.id;
      const customerId = project.customer_id;

      // Build the update payload incrementally so we only PATCH the columns
      // this lead actually has values for.
      const update: Record<string, string | null> = {};

      // 1. LeadComments -> project_scope
      const comments = String(f[COMMENTS_FIELD] ?? "").trim();
      if (comments) update.lead_comments = comments;

      // 2. ProjType -> project_type ('Service', 'Rental', 'Sales'). Used by
      //    the service_tech role to filter what they see — only Service jobs.
      const projType = String(f["ProjType"] ?? "").trim();
      if (projType) update.project_type = projType;

      // 3. ContactNameOnSite -> site_contact. Shown under the ship-to
      //    address on the service tech view so they have a name to ask
      //    for on arrival. Phone goes in site_contact_phone so we can
      //    render it as a tap-to-call link on mobile.
      let siteContact = "";
      for (const key of SITE_CONTACT_FIELDS) {
        const v = f[key];
        if (typeof v === "string" && v.trim()) { siteContact = v.trim(); break; }
      }
      if (siteContact) update.site_contact = siteContact;

      let siteContactPhone = "";
      for (const key of SITE_CONTACT_PHONE_FIELDS) {
        const v = f[key];
        if (typeof v === "string" && v.trim()) { siteContactPhone = v.trim(); break; }
      }
      if (siteContactPhone) update.site_contact_phone = siteContactPhone;

      // 4. addressshipto -> ship_to_address. Authoritative ship-to for the
      //    job site, shown on the project page (preferred over the Zoho
      //    customer shipping address, which is unreliable).
      let shipTo = "";
      for (const key of SHIPTO_FIELDS) {
        const v = f[key];
        if (typeof v === "string" && v.trim()) { shipTo = v.trim(); break; }
      }
      if (shipTo) update.ship_to_address = shipTo;

      // 5. PONum / PODate -> po_number / po_date. Unlike every other field
      //    here, a blank is meaningful: the pipeline is the only source of
      //    po_number, and a recorded PO satisfies the portal's "Purchase
      //    order" requirement. Leaving a stale number behind after someone
      //    clears a wrong entry would keep the requirement wrongly ticked,
      //    so an empty PONum clears the portal's copy.
      let poNum = "";
      for (const key of PONUM_FIELDS) {
        const v = f[key];
        if (typeof v === "string" && v.trim()) { poNum = v.trim(); break; }
        if (typeof v === "number") { poNum = String(v); break; }
      }
      update.po_number = poNum || null;

      let poDate: string | null = null;
      for (const key of PODATE_FIELDS) {
        const v = f[key];
        if (typeof v === "string" && v.trim()) {
          const d = new Date(v.trim());
          if (!isNaN(d.getTime())) poDate = d.toISOString();
          break;
        }
      }
      // Only meaningful alongside a number — don't leave a date on a project
      // whose PO entry was cleared.
      update.po_date = poNum ? poDate : null;

      if (Object.keys(update).length > 0) {
        const { error } = await admin.from("cportal_projects").update(update).eq("id", projectId);
        if (!error) {
          matched++;
          if (update.project_type) projectTypesSet++;
          if (update.site_contact) siteContactsSet++;
          if (update.ship_to_address) shipToSet++;
          if (update.po_number) poNumbersSet++;
        }
      }

      // 6. LeadEmail -> the person who submitted the lead. We do two
      //    things with it:
      //      a) Add as a contact on the project's customer so they (and
      //         their company peers) automatically get portal access.
      //      b) If they ALREADY have a portal profile, also link them as
      //         an explicit project_member (legacy behavior — kept so
      //         nothing breaks for already-invited users).
      let email = "";
      for (const key of EMAIL_FIELDS) {
        const v = f[key];
        if (typeof v === "string" && v.trim()) { email = v.trim(); break; }
      }
      if (email && customerId) {
        const lowerEmail = email.toLowerCase();
        seenContactKeys.add(`${customerId}::${lowerEmail}`);

        // Lead name + phone (helpful display info on the contact row).
        const leadName = String(f["LeadName"] ?? "").trim() || null;
        const leadPhone = String(f["Phone"] ?? "").trim() || null;

        const { error: ccErr } = await admin
          .from("cportal_customer_contacts")
          .upsert(
            {
              customer_id: customerId,
              email: lowerEmail,
              name: leadName,
              role: "lead",
              phone: leadPhone,
              source: "sharepoint",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "customer_id,email" },
          );
        if (!ccErr) contactsSynced++;
      }

      if (email) {
        const { data: prof } = await admin
          .from("cportal_profiles").select("id").ilike("email", email).maybeSingle();
        if (prof?.id) {
          const { data: existing } = await admin
            .from("cportal_project_members")
            .select("id")
            .eq("project_id", projectId)
            .eq("user_id", prof.id)
            .maybeSingle();
          if (!existing) {
            const { error } = await admin
              .from("cportal_project_members").insert({ project_id: projectId, user_id: prof.id });
            if (!error) membersAdded++;
          }
        }
      }
    }

    // Mirror SharePoint: drop sharepoint-source contacts that no longer
    // appear in any current lead. Leaves zoho and manual entries alone.
    let contactsRemoved = 0;
    {
      const existingSp = await selectAll<{ id: string; customer_id: string; email: string }>(
        (a, b) => admin.from("cportal_customer_contacts")
          .select("id, customer_id, email")
          .eq("source", "sharepoint")
          .order("id").range(a, b),
      );
      const stale = existingSp.filter(
        (r) => !seenContactKeys.has(`${r.customer_id}::${r.email}`),
      );
      if (stale.length) {
        const { error } = await admin
          .from("cportal_customer_contacts")
          .delete()
          .in("id", stale.map((r) => r.id));
        if (!error) contactsRemoved = stale.length;
      }
    }

    return json({
      ok: true,
      leadsScanned: leads.length,
      projectsMatched: matched,
      projectTypesSet,
      siteContactsSet,
      shipToSet,
      poNumbersSet,
      membersAdded,
      contactsSynced,
      contactsRemoved,
      sampleFieldNames,
      listColumns,
      at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
