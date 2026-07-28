// Supabase Edge Function: add-customer-contact
// Admin-only. Creates or deletes a person on a customer record, writing
// through to Zoho Books so the change survives the hourly sync-zoho mirror
// (which deletes source='zoho' rows missing from Zoho and would duplicate
// local-only rows once the same person is added in Zoho).
//
//   action "add":    { action?, customerId, name?, email, role?, phone? }
//     Creates a contact person under the customer's Zoho contact, then
//     upserts cportal_customer_contacts with the returned contact_person_id
//     (source 'zoho'). If the customer has no Zoho record or Zoho rejects
//     the call, the row is saved locally with source 'manual' and the
//     response carries a `warning` explaining that Zoho wasn't updated.
//
//   action "delete": { action, contactId }
//     Deletes the person from Zoho first (when linked), then removes the
//     local row. Refuses to remove the local row if the Zoho delete fails —
//     otherwise the next sync would just resurrect it.

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

const ZOHO_ACCOUNTS = "https://accounts.zoho.com";
const ZOHO_BOOKS = "https://www.zohoapis.com/books/v3";

async function zohoAccessToken(): Promise<string> {
  const params = new URLSearchParams({
    refresh_token: Deno.env.get("ZOHO_REFRESH_TOKEN")!,
    client_id: Deno.env.get("ZOHO_CLIENT_ID")!,
    client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
    grant_type: "refresh_token",
  });
  const res = await fetch(`${ZOHO_ACCOUNTS}/oauth/v2/token?${params}`, { method: "POST" });
  const data = await res.json();
  if (!data.access_token) throw new Error("Zoho token refresh failed: " + JSON.stringify(data));
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Authorize: caller must be an admin user.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  let allowed = false;
  if (token && token !== serviceKey) {
    const { data: { user } } = await admin.auth.getUser(token);
    if (user) {
      const { data: profile } = await admin.from("cportal_profiles").select("role").eq("id", user.id).single();
      if (profile?.role === "admin") allowed = true;
    }
  }
  if (!allowed) return json({ error: "Not authorized" }, 403);

  try {
    const body = await req.json();
    const action = body.action === "delete" ? "delete" : "add";
    const orgId = Deno.env.get("ZOHO_ORG_ID")!;

    if (action === "delete") {
      const contactId = String(body.contactId ?? "");
      if (!contactId) return json({ error: "contactId is required" }, 400);
      const { data: row } = await admin
        .from("cportal_customer_contacts")
        .select("id, zoho_contact_person_id, customer_id")
        .eq("id", contactId).maybeSingle();
      if (!row) return json({ error: "Contact not found" }, 404);

      if (row.zoho_contact_person_id) {
        const { data: cust } = await admin
          .from("cportal_customers").select("zoho_contact_id")
          .eq("id", row.customer_id).maybeSingle();
        if (cust?.zoho_contact_id) {
          const accessToken = await zohoAccessToken();
          const url = `${ZOHO_BOOKS}/contacts/${cust.zoho_contact_id}/contactpersons/${row.zoho_contact_person_id}?organization_id=${orgId}`;
          const res = await fetch(url, {
            method: "DELETE",
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          });
          const data = await res.json().catch(() => ({}));
          // Zoho code 0 = success. A person already gone from Zoho (deleted
          // there directly) shouldn't block the local removal.
          const alreadyGone = res.status === 404 || data.code === 1004 || data.code === 2006;
          if (!(res.ok && data.code === 0) && !alreadyGone) {
            return json({ error: `Zoho delete failed: ${data.message ?? res.status}` }, 502);
          }
        }
      }
      const { error: delErr } = await admin.from("cportal_customer_contacts").delete().eq("id", row.id);
      if (delErr) return json({ error: delErr.message }, 500);
      return json({ ok: true });
    }

    // action === "add"
    const customerId = String(body.customerId ?? "");
    const email = String(body.email ?? "").trim().toLowerCase();
    const name = String(body.name ?? "").trim();
    const role = String(body.role ?? "").trim();
    const phone = String(body.phone ?? "").trim();
    if (!customerId) return json({ error: "customerId is required" }, 400);
    if (!email) return json({ error: "Email is required" }, 400);

    const { data: customer } = await admin
      .from("cportal_customers").select("id, zoho_contact_id, name, company")
      .eq("id", customerId).maybeSingle();
    if (!customer) return json({ error: "Customer not found" }, 404);

    // Duplicate guard: same email already on this customer.
    const { data: dupe } = await admin
      .from("cportal_customer_contacts").select("id")
      .eq("customer_id", customerId).eq("email", email).maybeSingle();
    if (dupe) return json({ error: "That email is already a contact on this customer." }, 409);

    // Try Zoho first so we can store the contact_person_id. Zoho splits
    // names; give it a best-effort first/last split.
    let zohoContactPersonId: string | null = null;
    let warning: string | null = null;
    if (customer.zoho_contact_id) {
      try {
        const accessToken = await zohoAccessToken();
        const [firstName, ...rest] = (name || email.split("@")[0]).split(/\s+/);
        const url = `${ZOHO_BOOKS}/contacts/${customer.zoho_contact_id}/contactpersons?organization_id=${orgId}`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Zoho-oauthtoken ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            first_name: firstName,
            last_name: rest.join(" "),
            email,
            ...(phone ? { phone } : {}),
            ...(role ? { designation: role } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.code === 0 && data.contact_person?.contact_person_id) {
          zohoContactPersonId = String(data.contact_person.contact_person_id);
        } else {
          warning = `Saved in the portal, but Zoho didn't accept the contact: ${data.message ?? `HTTP ${res.status}`}`;
        }
      } catch (e) {
        warning = `Saved in the portal, but Zoho couldn't be reached: ${(e as Error).message}`;
      }
    } else {
      warning = "Saved in the portal only — this customer has no linked Zoho record.";
    }

    // source 'zoho' + the id keeps future syncs updating this row in place;
    // a Zoho-less row stays 'manual' so the sync mirror never removes it.
    const { data: inserted, error: insErr } = await admin
      .from("cportal_customer_contacts")
      .insert({
        customer_id: customerId,
        name: name || null,
        email,
        role: role || null,
        phone: phone || null,
        source: zohoContactPersonId ? "zoho" : "manual",
        zoho_contact_person_id: zohoContactPersonId,
        updated_at: new Date().toISOString(),
      })
      .select("id").single();
    if (insErr) return json({ error: insErr.message }, 500);

    return json({ ok: true, id: inserted.id, zoho_contact_person_id: zohoContactPersonId, warning });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
