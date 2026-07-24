// Supabase Edge Function: sync-zoho
// Pulls Customers (contacts), Projects, and Invoices from Zoho Books (US data
// center) and upserts them into Supabase. Uses the service-role key, so it
// bypasses RLS when writing. Callable by an admin (manual button) or by the
// scheduled cron (which authenticates with the service-role key).
//
// Also sends notification emails via Microsoft Graph (as the shared sales@
// mailbox) on genuinely-new invoices (only once they've cleared Zoho Books'
// approval workflow) and on project status changes. Emails are
// routed to the linked project's members (job-scoped) rather than the customer
// record's primary-contact email (company-scoped), falling back to the customer
// email only when there's no project link or the project has no members — a
// multi-office company must not have every office's invoices land with one
// person. Honors each user's email_notifications preference and the
// app_settings.emails_paused kill switch; best-effort if creds are unset.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// --- Branded email wrapper (inlined copy of _shared/email-template.ts so
//     this function deploys as a single self-contained file) ---------------
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface BrandedEmailOptions {
  preheader?: string;
  title: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
  footnote?: string;
}

function brandedEmail(opts: BrandedEmailOptions): string {
  const logoUrl = Deno.env.get("EMAIL_LOGO_URL") || "";
  const year = new Date().getFullYear();

  const headerVisual = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="Hydro-Wates" height="44" style="display:block;max-height:44px;width:auto;border:0;outline:none;text-decoration:none;">`
    : `<div style="font-family:'Helvetica Neue',Arial,sans-serif;color:#ffffff;line-height:1.1;text-align:center;">
         <div style="font-size:22px;font-weight:700;letter-spacing:0.06em;">HYDRO-WATES</div>
         <div style="font-size:10px;color:#94a3b8;letter-spacing:0.18em;text-transform:uppercase;margin-top:6px;">Proof-Load Testing Services</div>
       </div>`;

  const ctaBlock = opts.ctaUrl && opts.ctaLabel
    ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 0 0;">
         <tr><td style="background:#2563eb;border-radius:6px;">
           <a href="${esc(opts.ctaUrl)}" style="display:inline-block;padding:12px 28px;color:#ffffff;text-decoration:none;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:14px;font-weight:600;line-height:1;">${esc(opts.ctaLabel)}</a>
         </td></tr>
       </table>`
    : "";

  const footnote = opts.footnote
    ? `<p style="margin:24px 0 0 0;font-size:13px;color:#6b7280;line-height:1.5;font-style:italic;">${opts.footnote}</p>`
    : "";

  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;color:#f3f4f6;line-height:1px;">${esc(opts.preheader)}</div>`
    : "";

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${esc(opts.title)}</title>
<!--[if mso]>
<style type="text/css">
table {border-collapse:collapse;}
</style>
<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
${preheader}
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color:#f3f4f6;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:560px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td align="center" style="padding:28px 32px;background-color:#1e293b;">
            ${headerVisual}
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 24px 32px;">
            <h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.4;color:#111827;font-weight:600;">${esc(opts.title)}</h1>
            <div style="font-size:15px;line-height:1.6;color:#374151;">${opts.bodyHtml}</div>
            ${ctaBlock}
            ${footnote}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
            <p style="margin:0 0 8px 0;font-size:12px;color:#6b7280;line-height:1.5;">
              This message was sent by Hydro-Wates Proof-Load Testing Services. If you have questions, reply to this email or sign in to the customer portal.
            </p>
            <p style="margin:0;font-size:11px;color:#9ca3af;line-height:1.5;">
              Manage email preferences in the portal under <strong>Account &rarr; Email notifications</strong>.
            </p>
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0 0;font-size:11px;color:#9ca3af;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
        &copy; ${year} Hydro-Wates. All rights reserved.
      </p>
    </td>
  </tr>
</table>
</body>
</html>`;
}

const ZOHO_ACCOUNTS = "https://accounts.zoho.com";
const ZOHO_BOOKS = "https://www.zohoapis.com/books/v3";

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

async function getAccessToken(): Promise<string> {
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

// Fetch every page of a Zoho Books list endpoint.
async function fetchAll(path: string, key: string, accessToken: string, orgId: string): Promise<any[]> {
  const out: any[] = [];
  let page = 1;
  while (true) {
    const url = `${ZOHO_BOOKS}/${path}?organization_id=${orgId}&page=${page}&per_page=200`;
    const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
    const data = await res.json();
    if (typeof data.code !== "undefined" && data.code !== 0) {
      throw new Error(`Zoho ${path} error: ${JSON.stringify(data)}`);
    }
    out.push(...(data[key] ?? []));
    if (!data.page_context?.has_more_page) break;
    page++;
  }
  return out;
}

// Fetch a single contact's full record from Zoho. The /contacts list
// endpoint returns only summary data; the detail endpoint includes the
// shipping/billing address objects we need to populate cportal_customers.
async function fetchContactDetails(contactId: string, accessToken: string, orgId: string): Promise<Record<string, unknown> | null> {
  const url = `${ZOHO_BOOKS}/contacts/${contactId}?organization_id=${orgId}`;
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  if (!res.ok) return null;
  const data = await res.json();
  if (typeof data.code !== "undefined" && data.code !== 0) return null;
  return (data.contact ?? null) as Record<string, unknown> | null;
}

// Recover an invoice's project link. The /invoices LIST endpoint omits the
// project association entirely, so an invoice billed under a project still
// comes back with no project_id. The detail endpoint includes it — either at
// the top level (`project_id`) or on the first line item that carries one.
// Returns the Zoho project_id string, or null when the invoice genuinely has
// no project. THROWS on a transport/API error so the caller can leave the
// invoice unchecked and retry it on the next sync (rather than wrongly marking
// it as having no project).
async function fetchInvoiceProjectId(invoiceId: string, accessToken: string, orgId: string): Promise<string | null> {
  const url = `${ZOHO_BOOKS}/invoices/${invoiceId}?organization_id=${orgId}`;
  const res = await fetch(url, { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } });
  if (!res.ok) throw new Error(`Zoho invoice ${invoiceId} HTTP ${res.status}`);
  const data = await res.json();
  if (typeof data.code !== "undefined" && data.code !== 0) {
    throw new Error(`Zoho invoice ${invoiceId} error: ${JSON.stringify(data)}`);
  }
  const inv = (data.invoice ?? {}) as { project_id?: string; line_items?: Array<{ project_id?: string }> };
  if (inv.project_id) return String(inv.project_id);
  for (const li of inv.line_items ?? []) {
    if (li.project_id) return String(li.project_id);
  }
  return null;
}

// Run an async mapper over `items` with bounded concurrency. Keeps API
// calls under the per-minute rate limit while still pipelining requests.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function mapProjectStatus(zohoStatus: string): string {
  return zohoStatus === "active" ? "active" : "completed";
}

// Zoho Books approval workflow: an invoice moves draft → pending approval →
// approved (or rejected) → sent. The customer must not see — or be emailed
// about — an invoice that hasn't cleared approval. Depending on API version
// and org settings Zoho reports the approval state either as the top-level
// `status` or in `current_sub_status`, so check both. "approved" itself IS
// released: the portal is the delivery channel, so approval is the moment
// the customer may receive the invoice (no need to also mark it sent in Zoho).
const UNRELEASED_INVOICE_STATES = new Set(["draft", "pending_approval", "rejected"]);

function invoiceReleased(inv: { status?: string; current_sub_status?: string }): boolean {
  const status = String(inv.status ?? "").toLowerCase();
  const sub = String(inv.current_sub_status ?? "").toLowerCase();
  if (sub === "approved") return true;
  return !UNRELEASED_INVOICE_STATES.has(status) && !UNRELEASED_INVOICE_STATES.has(sub);
}

// Status to store in the portal. An approved-but-unsent invoice can carry a
// top-level status of "draft" (approval state lives in current_sub_status);
// storing that raw would get the row deleted by the draft cleanup on the next
// sync and re-created — and re-emailed — on the one after, forever. Store
// "approved" instead so the row survives.
function effectiveInvoiceStatus(inv: { status?: string; current_sub_status?: string }): string | null {
  const status = String(inv.status ?? "").toLowerCase();
  const sub = String(inv.current_sub_status ?? "").toLowerCase();
  if (sub === "approved" && UNRELEASED_INVOICE_STATES.has(status)) return "approved";
  return inv.status ?? null;
}

// Parse a Zoho date/timestamp into an ISO string, or null if absent/invalid.
function toIso(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function money(amount: unknown, currency: string | null): string {
  const n = Number(amount);
  if (isNaN(n)) return String(amount ?? "");
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(n);
  } catch {
    return String(n);
  }
}

// --- Microsoft Graph (app-only) email sender -------------------------------
// Sends as the shared mailbox sales@hydrowates.com using a client-credentials
// app (the same kind used for SharePoint). Requires Mail.Send (Application)
// consent + an Application Access Policy scoping the app to sales@. Set
// dedicated GRAPH_* secrets, or reuse the existing SHAREPOINT_* ones.
const MAIL_SENDER = Deno.env.get("MAIL_SENDER") || "sales@hydrowates.com";
const REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") || "sales@hydrowates.com";

async function graphToken(): Promise<string> {
  const tenant = Deno.env.get("GRAPH_TENANT_ID") || Deno.env.get("SHAREPOINT_TENANT_ID");
  const clientId = Deno.env.get("GRAPH_CLIENT_ID") || Deno.env.get("SHAREPOINT_CLIENT_ID");
  const clientSecret = Deno.env.get("GRAPH_CLIENT_SECRET") || Deno.env.get("SHAREPOINT_CLIENT_SECRET");
  if (!tenant || !clientId || !clientSecret) {
    throw new Error("Missing Graph mail credentials (set GRAPH_* or reuse SHAREPOINT_* secrets).");
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

// Email a single customer via Microsoft Graph. Honors the admin-controlled
// app_settings.emails_paused kill switch (defaults to paused). Best-effort.
async function sendEmail(
  admin: ReturnType<typeof createClient>,
  to: string | null | undefined,
  subject: string,
  html: string,
) {
  if (!to) return;
  const { data: setting } = await admin
    .from("cportal_app_settings").select("value").eq("key", "emails_paused").maybeSingle();
  if (setting?.value !== "false") {
    console.log(`[emails paused] would send "${subject}" to: ${to}`);
    return;
  }
  let token: string;
  try {
    token = await graphToken();
  } catch (e) {
    console.error("Graph token failed:", e);
    return;
  }
  try {
    const res = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAIL_SENDER)}/sendMail`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: "HTML", content: html },
            toRecipients: [{ emailAddress: { address: to } }],
            replyTo: [{ emailAddress: { address: REPLY_TO } }],
          },
          saveToSentItems: false,
        }),
      },
    );
    if (!res.ok) console.error(`Graph sendMail error for ${to}:`, res.status, await res.text());
  } catch (e) {
    console.error(`Graph sendMail failed for ${to}:`, e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Authorize: allow the scheduled cron (service-role key) or an admin user.
  // Three paths: direct env match, JWT role:service_role claim, or admin user JWT.
  // The multi-path check handles both legacy JWT-format service keys and the
  // newer sb_secret_* format.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  let allowed = false;
  if (token && token === serviceKey) {
    allowed = true;
  }
  if (!allowed && token) {
    try {
      const parts = token.split(".");
      if (parts.length === 3) {
        const padded = parts[1] + "=".repeat((4 - parts[1].length % 4) % 4);
        const payload = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
        if (payload?.role === "service_role") allowed = true;
      }
    } catch { /* not a JWT */ }
  }
  if (!allowed && token) {
    const { data: { user } } = await admin.auth.getUser(token);
    if (user) {
      const { data: profile } = await admin.from("cportal_profiles").select("role").eq("id", user.id).single();
      if (profile?.role === "admin") allowed = true;
    }
  }
  if (!allowed) return json({ error: "Not authorized" }, 403);

  try {
    const orgId = Deno.env.get("ZOHO_ORG_ID")!;
    const accessToken = await getAccessToken();

    // 1) Customers (Zoho contacts). Filter to ONLY contact_type === "customer"
    //    so vendors, tax authorities, and any other Zoho contact types stay
    //    out of the portal's customer list. Anything previously synced as a
    //    customer that Zoho now classifies as a non-customer gets cleaned up
    //    here — but only if it has no projects or invoices attached. If it
    //    does have related rows we leave it alone and report the orphan
    //    count so an admin can investigate.
    const allContacts = await fetchAll("contacts", "contacts", accessToken, orgId);
    const summaryCustomers = allContacts.filter((c) => c.contact_type === "customer");
    const nonCustomers = allContacts.filter((c) => c.contact_type !== "customer");

    // The /contacts list endpoint returns only summary data — no addresses,
    // no phone in the right shape. Fetch each customer's full detail record
    // so we get billing_address and shipping_address. Run with bounded
    // concurrency (5 at a time) to stay under Zoho's per-minute rate limit.
    // For ~500 contacts at concurrency=5 this takes ~1–2 minutes.
    const contacts = await mapWithConcurrency(summaryCustomers, 5, async (c) => {
      const details = await fetchContactDetails(String(c.contact_id), accessToken, orgId);
      // Merge summary + details so we keep all fields. Detail wins on conflict.
      return { ...c, ...(details ?? {}) };
    });

    // Pull the merged-contacts table so we know which Zoho contacts we
    // should NOT recreate (they were merged into a surviving customer
    // record by an admin) and where to re-point any project/invoice
    // references to them.
    const { data: mergedRows } = await admin
      .from("cportal_merged_zoho_contacts")
      .select("zoho_contact_id, merged_into_customer_id");
    const mergedMap = new Map<string, string>(
      (mergedRows ?? []).map((m) => [String(m.zoho_contact_id), String(m.merged_into_customer_id)]),
    );

    const customerRows = contacts
      .filter((c) => !mergedMap.has(String(c.contact_id)))
      .map((c) => {
        const ship = (c.shipping_address ?? {}) as Record<string, string | undefined>;
        const bill = (c.billing_address ?? {}) as Record<string, string | undefined>;
        return {
          zoho_contact_id: String(c.contact_id),
          name: c.contact_name ?? null,
          email: c.email || null,
          company: c.company_name || null,
          // Phone — Zoho contacts can have several phone fields; prefer the
          // main `phone` then fall back to `mobile`. Used by the Request
          // Quote form to autofill the customer's contact details.
          phone: (c as { phone?: string; mobile?: string }).phone || (c as { mobile?: string }).mobile || null,
          shipping_address: ship.address || ship.street || null,
          shipping_city: ship.city || null,
          shipping_state: ship.state || null,
          shipping_zip: ship.zip || null,
          shipping_country: ship.country || null,
          billing_address: bill.address || bill.street || null,
          billing_city: bill.city || null,
          billing_state: bill.state || null,
          billing_zip: bill.zip || null,
          billing_country: bill.country || null,
          updated_at: new Date().toISOString(),
        };
      });
    if (customerRows.length) {
      const { error } = await admin.from("cportal_customers").upsert(customerRows, { onConflict: "zoho_contact_id" });
      if (error) throw error;
    }

    // Cleanup pass: drop rows whose zoho_contact_id now belongs to a Zoho
    // non-customer (vendor, tax authority, etc.) and have no portal data
    // attached. Anything with related projects or invoices is left in place
    // and counted as "orphaned" — the admin can manually reassign or delete.
    let customersRemoved = 0;
    let customersOrphaned = 0;
    if (nonCustomers.length) {
      const nonCustomerIds = nonCustomers.map((c) => String(c.contact_id));
      const { data: candidates } = await admin
        .from("cportal_customers")
        .select("id, zoho_contact_id")
        .in("zoho_contact_id", nonCustomerIds);
      for (const cand of candidates ?? []) {
        const [{ count: projCount }, { count: invCount }] = await Promise.all([
          admin.from("cportal_projects").select("id", { count: "exact", head: true }).eq("customer_id", cand.id),
          admin.from("cportal_invoices").select("id", { count: "exact", head: true }).eq("customer_id", cand.id),
        ]);
        if ((projCount ?? 0) === 0 && (invCount ?? 0) === 0) {
          const { error } = await admin.from("cportal_customers").delete().eq("id", cand.id);
          if (!error) customersRemoved++;
        } else {
          customersOrphaned++;
        }
      }
    }

    const { data: custList } = await admin.from("cportal_customers").select("id, zoho_contact_id, email");
    const custMap = new Map<string, string>((custList ?? []).map((c) => [String(c.zoho_contact_id), String(c.id)]));
    const custEmail = new Map((custList ?? []).map((c) => [c.id, c.email]));

    // Route merged Zoho contact ids to their surviving customer so any
    // projects/invoices that reference the merged contact_id end up on
    // the right record.
    for (const [zohoId, survivorId] of mergedMap) {
      custMap.set(zohoId, survivorId);
    }

    // 1b) Customer contacts — multiple people per company (admin, PM,
    //     billing, site) pulled from Zoho. Zoho's /contactpersons
    //     endpoint requires a per-contact filter (there's no org-wide
    //     list), so we fetch per customer using the same bounded
    //     concurrency we already apply for the addresses.
    type ContactPerson = {
      contact_id?: string;
      contact_person_id?: string;
      first_name?: string;
      last_name?: string;
      email?: string;
      phone?: string;
      mobile?: string;
      designation?: string;
      is_primary_contact?: boolean;
    };

    async function fetchContactPersons(contactId: string): Promise<ContactPerson[]> {
      const url = `${ZOHO_BOOKS}/contacts/${contactId}/contactpersons?organization_id=${orgId}`;
      // Up to 3 tries — Zoho's edge sometimes returns a transient HTTP/2
      // connection error under concurrency; one or two retries clear it.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, {
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
          });
          if (!res.ok) return [];
          const data = await res.json();
          if (typeof data.code !== "undefined" && data.code !== 0) return [];
          return (data.contact_persons ?? []) as ContactPerson[];
        } catch (e) {
          if (attempt === 3) {
            console.warn(`contactpersons fetch failed after 3 tries for ${contactId}:`, (e as Error).message);
            return [];
          }
          // Brief exponential backoff: 250ms, 750ms
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
      return [];
    }

    const personsByContactId = new Map<string, ContactPerson[]>();
    // Lower concurrency than the 5 we use for fetchContactDetails — Zoho's
    // /contactpersons endpoint is flakier under parallel load.
    await mapWithConcurrency(summaryCustomers, 3, async (c) => {
      const id = String(c.contact_id);
      const persons = await fetchContactPersons(id);
      if (persons.length) personsByContactId.set(id, persons);
    });

    const contactRows: Array<Record<string, unknown>> = [];
    const seenZohoCpids = new Set<string>();

    for (const [zohoContactId, persons] of personsByContactId) {
      const localCustomerId = custMap.get(zohoContactId);
      if (!localCustomerId) continue;
      for (const p of persons) {
        const email = (p.email || "").trim().toLowerCase();
        if (!email) continue;
        const cpid = p.contact_person_id ? String(p.contact_person_id) : null;
        if (cpid) seenZohoCpids.add(cpid);
        const fullName = [p.first_name, p.last_name].filter(Boolean).join(" ").trim();
        contactRows.push({
          customer_id: localCustomerId,
          name: fullName || null,
          email,
          role: p.designation || (p.is_primary_contact ? "primary" : null),
          phone: p.phone || p.mobile || null,
          source: "zoho",
          zoho_contact_person_id: cpid,
          updated_at: new Date().toISOString(),
        });
      }
    }

    let contactsSynced = 0;
    let contactsRemoved = 0;
    if (contactRows.length) {
      // Upsert keyed on the Zoho contact_person_id so re-running just
      // updates existing rows instead of creating duplicates.
      const { error: ccErr } = await admin
        .from("cportal_customer_contacts")
        .upsert(contactRows, { onConflict: "zoho_contact_person_id" });
      if (ccErr) {
        console.error("contact upsert failed:", ccErr);
      } else {
        contactsSynced = contactRows.length;
      }
    }

    // Mirror Zoho: delete any source='zoho' contacts that no longer exist in
    // Zoho's contact_persons response. Leaves manual/sharepoint entries alone.
    {
      const { data: existingZoho } = await admin
        .from("cportal_customer_contacts")
        .select("id, zoho_contact_person_id")
        .eq("source", "zoho")
        .not("zoho_contact_person_id", "is", null);
      const stale = (existingZoho ?? []).filter(
        (r) => r.zoho_contact_person_id && !seenZohoCpids.has(r.zoho_contact_person_id),
      );
      if (stale.length) {
        const { error } = await admin
          .from("cportal_customer_contacts")
          .delete()
          .in("id", stale.map((r) => r.id));
        if (!error) contactsRemoved = stale.length;
      }
    }

    // 2) Projects — capture existing statuses first so we can detect changes
    const { data: existingProjects } = await admin
      .from("cportal_projects").select("zoho_project_id, status").not("zoho_project_id", "is", null);
    const oldStatus = new Map((existingProjects ?? []).map((p) => [p.zoho_project_id, p.status]));

    const projects = await fetchAll("projects", "projects", accessToken, orgId);
    const projectRows = projects.map((p) => ({
      zoho_project_id: String(p.project_id),
      name: p.project_name ?? "Untitled project",
      description: p.description || null,
      status: mapProjectStatus(p.status),
      customer_id: custMap.get(String(p.customer_id)) ?? null,
      started_on: toIso(p.created_time ?? p.start_date ?? p.created_date),
      updated_at: new Date().toISOString(),
    }));
    if (projectRows.length) {
      const { error } = await admin.from("cportal_projects").upsert(projectRows, { onConflict: "zoho_project_id" });
      if (error) throw error;
    }

    // (Status-change emails are sent further down, once project membership has
    // been refreshed, so they can be routed to the members on the job.)

    const { data: projList } = await admin
      .from("cportal_projects").select("id, zoho_project_id").not("zoho_project_id", "is", null);
    const projMap = new Map((projList ?? []).map((p) => [p.zoho_project_id, p.id]));

    // Auto-add project members from each project's customer email. For every
    // project whose customer has a portal profile, ensure that profile is
    // listed as a member. We don't auto-invite (creating the profile is still
    // an admin decision) — we only attach profiles that already exist.
    // Combined with sync-leads (which adds members from the SharePoint
    // LeadEmail field), this gives every project up-to-date membership from
    // both sources. Duplicates can't form because project_members has a
    // unique constraint on (project_id, user_id).
    let membersAdded = 0;
    {
      const { data: allProfiles } = await admin.from("cportal_profiles").select("id, email");
      const profileByEmail = new Map<string, string>();
      for (const p of allProfiles ?? []) {
        if (p.email) profileByEmail.set(p.email.toLowerCase(), p.id);
      }
      for (const p of projects) {
        const portalProjectId = projMap.get(String(p.project_id));
        const portalCustomerId = custMap.get(String(p.customer_id));
        if (!portalProjectId || !portalCustomerId) continue;
        const customerEmail = custEmail.get(portalCustomerId);
        if (!customerEmail) continue;
        const userId = profileByEmail.get(customerEmail.toLowerCase());
        if (!userId) continue;
        const { data: existing } = await admin
          .from("cportal_project_members")
          .select("id")
          .eq("project_id", portalProjectId)
          .eq("user_id", userId)
          .maybeSingle();
        if (existing) continue;
        const { error } = await admin
          .from("cportal_project_members").insert({ project_id: portalProjectId, user_id: userId });
        if (!error) membersAdded++;
      }
    }

    // --- Notification recipient routing --------------------------------------
    // A company can have many offices behind one customer record (e.g. Hoist &
    // Crane), so the record's primary-contact email is the wrong target for
    // job-specific news. Route each email to the linked project's members (the
    // people actually on the job) and use the customer-record email only as a
    // fallback when there's no project link or the project has no members.
    // Membership is read AFTER the auto-add pass above so members attached this
    // run are included. Internal roles (admin, service_tech) are never emailed,
    // and each user's email_notifications preference (portal Account page) is
    // honored — the email footer has always promised that control.
    const { data: mailProfiles } = await admin
      .from("cportal_profiles").select("id, email, role, email_notifications");
    const optedOut = new Set<string>();
    const portalEmails = new Set<string>();
    const internalEmails = new Set<string>();
    const profileEmailById = new Map<string, string>();
    for (const pf of mailProfiles ?? []) {
      const email = String(pf.email ?? "").trim().toLowerCase();
      if (!email) continue;
      portalEmails.add(email);
      profileEmailById.set(pf.id, email);
      if (pf.email_notifications === false) optedOut.add(email);
      if (pf.role === "admin" || pf.role === "service_tech") internalEmails.add(email);
    }

    const { data: memberRows } = await admin
      .from("cportal_project_members").select("project_id, user_id");
    const membersByProject = new Map<string, string[]>();
    for (const m of memberRows ?? []) {
      const email = profileEmailById.get(m.user_id);
      if (!email || internalEmails.has(email)) continue;
      const list = membersByProject.get(m.project_id) ?? [];
      if (!list.includes(email)) list.push(email);
      membersByProject.set(m.project_id, list);
    }

    // Resolve who should hear about news on a project. The customer-record
    // email is auto-added as a member of EVERY one of that record's projects
    // (see the auto-add pass above, which also re-adds it hourly), so its
    // presence in the member list doesn't mean that person is on THIS job.
    // When the job has any other members, those are the audience and the
    // company-wide contact is dropped; it stays the recipient only when it's
    // all the project has. When the audience exists but everyone in it opted
    // out, we send nothing rather than fall back — falling back would re-route
    // job news to the company-wide contact (the exact bug this prevents).
    // requirePortal: new-invoice emails only go to customers who already have
    // a portal account (never-invited customers shouldn't get "view it in
    // your portal" emails); status emails keep their historical behavior of
    // reaching the customer email regardless.
    function recipientsFor(
      portalProjectId: string | null | undefined,
      fallbackEmail: string | null | undefined,
      requirePortal: boolean,
    ): string[] {
      const fb = String(fallbackEmail ?? "").trim().toLowerCase();
      const members = (portalProjectId ? membersByProject.get(portalProjectId) : undefined) ?? [];
      const jobPeople = members.filter((e) => e !== fb);
      const audience = jobPeople.length ? jobPeople : members;
      if (audience.length) return audience.filter((e) => !optedOut.has(e));
      if (!fb || optedOut.has(fb)) return [];
      if (requirePortal && !portalEmails.has(fb)) return [];
      return [fb];
    }

    // Email the job's people when a project's status changed
    for (const p of projects) {
      const newStatus = mapProjectStatus(p.status);
      const prev = oldStatus.get(String(p.project_id));
      if (prev === undefined || prev === newStatus) continue;
      const fallback = custEmail.get(custMap.get(String(p.customer_id)) ?? "");
      for (const to of recipientsFor(projMap.get(String(p.project_id)), fallback, false)) {
        await sendEmail(
          admin,
          to,
          `Project status updated: ${p.project_name}`,
          brandedEmail({
            preheader: `Your project ${p.project_name} is now ${newStatus}.`,
            title: `Project status updated`,
            bodyHtml: `<p>The status of your project <strong>${p.project_name}</strong> is now <strong>${newStatus}</strong>.</p>`,
          }),
        );
      }
    }

    // 3) Invoices — only invoices that have cleared Zoho's approval workflow
    //    (or were never subject to one) flow into the portal. Drafts, invoices
    //    pending approval, and rejected invoices stay out entirely so a
    //    customer never sees — or gets emailed about — an invoice that's still
    //    being prepared. The moment the PM approves (or, without an approval
    //    workflow, sends) it, the next sync brings it in — which is when the
    //    portal "receives" the invoice and the new-invoice email fires.

    // Clean up any unreleased rows a prior sync may have stored before this
    // rule existed. This also ensures that when such an invoice is later
    // released, it counts as genuinely new and triggers the notification.
    await admin.from("cportal_invoices").delete()
      .in("status", ["draft", "pending_approval", "rejected"]);

    // Capture existing rows first so we can (a) detect genuinely new invoices
    // for the notification email and (b) skip re-resolving the project link for
    // invoices we've already checked in a prior sync.
    const { data: existingInvoices } = await admin
      .from("cportal_invoices").select("zoho_invoice_id, project_id, project_synced_at");
    const existingInvIds = new Set((existingInvoices ?? []).map((i) => i.zoho_invoice_id));
    const priorLink = new Map(
      (existingInvoices ?? []).map((i) => [
        i.zoho_invoice_id,
        { projectId: i.project_id as string | null, checked: !!i.project_synced_at },
      ]),
    );

    // Exclude anything not yet approved: a customer "receives" an invoice only
    // once it has cleared approval (or been sent, absent an approval workflow).
    const invoices = (await fetchAll("invoices", "invoices", accessToken, orgId))
      .filter((inv) => invoiceReleased(inv));

    // Resolve each invoice's project. Zoho's invoice LIST omits the project
    // link, so for any invoice we haven't resolved before we read it from the
    // DETAIL endpoint (same list-is-summary / detail-has-the-field pattern as
    // contacts above). We pay that detail call only ONCE per invoice: once an
    // invoice has project_synced_at set, later syncs reuse the stored link, so
    // the recurring cron never re-walks the whole invoice history. Bounded
    // concurrency (5) keeps us under Zoho's per-minute rate limit. A transient
    // failure leaves the invoice unchecked so the next sync retries it.
    const resolved = await mapWithConcurrency(invoices, 5, async (inv) => {
      const zInvId = String(inv.invoice_id);
      const prior = priorLink.get(zInvId);
      if (prior?.checked) return { projectId: prior.projectId, checked: true };       // resolved before
      if (inv.project_id) return { projectId: projMap.get(String(inv.project_id)) ?? null, checked: true };
      try {
        const zProjId = await fetchInvoiceProjectId(zInvId, accessToken, orgId);
        return { projectId: zProjId ? (projMap.get(zProjId) ?? null) : null, checked: true };
      } catch (_e) {
        return { projectId: null, checked: false };                                   // retry next sync
      }
    });

    const nowIso = new Date().toISOString();
    const invoiceRows = invoices.map((inv, i) => ({
      zoho_invoice_id: String(inv.invoice_id),
      customer_id: custMap.get(String(inv.customer_id)) ?? null,
      project_id: resolved[i].projectId,
      invoice_number: inv.invoice_number ?? null,
      status: effectiveInvoiceStatus(inv),
      total: inv.total ?? null,
      balance: inv.balance ?? null,
      currency_code: inv.currency_code ?? null,
      invoice_date: inv.date || null,
      due_date: inv.due_date || null,
      // Stamp once the project link is settled so future syncs skip the detail
      // call. Left null on a transient failure so the next run retries it.
      project_synced_at: resolved[i].checked ? nowIso : null,
    }));
    if (invoiceRows.length) {
      const { error } = await admin.from("cportal_invoices").upsert(invoiceRows, { onConflict: "zoho_invoice_id" });
      if (error) throw error;
    }

    // Email the job's people about genuinely-new invoices. Unreleased invoices
    // (draft / pending approval / rejected) are already filtered out above, so
    // this only fires for invoices that have cleared Zoho's approval workflow.
    // Skip voided invoices. Recipients come from the linked project's
    // members; the customer-record email is only a fallback, and only when that
    // customer already has a portal account (a cportal_profiles row is created
    // at invite time, so its presence means they've been invited/registered —
    // cold customers should not receive "view it in your portal" emails).
    for (let i = 0; i < invoices.length; i++) {
      const inv = invoices[i];
      if (existingInvIds.has(String(inv.invoice_id))) continue;
      if (String(inv.status ?? "").toLowerCase() === "void") continue;
      const fallback = custEmail.get(custMap.get(String(inv.customer_id)) ?? "");
      for (const to of recipientsFor(resolved[i].projectId, fallback, true)) {
        await sendEmail(
          admin,
          to,
          `New invoice ${inv.invoice_number ?? ""}`.trim(),
          brandedEmail({
            preheader: `Invoice ${inv.invoice_number ?? ""} for ${money(inv.total, inv.currency_code)} is ready.`,
            title: `New invoice ${inv.invoice_number ?? ""}`.trim(),
            bodyHtml: `<p>A new invoice <strong>${inv.invoice_number ?? ""}</strong> for <strong>${money(inv.total, inv.currency_code)}</strong> is now available in your portal.</p>`,
          }),
        );
      }
    }

    return json({
      ok: true,
      synced: {
        customers: customerRows.length,
        projects: projectRows.length,
        invoices: invoiceRows.length,
        invoicesLinkedToProject: resolved.filter((r) => r.projectId).length,
        membersAdded,
        customersRemoved,
        customersOrphaned,
        contactsSynced,
        contactsRemoved,
        contactPersonsFetched: contactRows.length,
      },
      at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
