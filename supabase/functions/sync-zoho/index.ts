// Supabase Edge Function: sync-zoho
// Pulls Customers (contacts), Projects, and Invoices from Zoho Books (US data
// center) and upserts them into Supabase. Uses the service-role key, so it
// bypasses RLS when writing. Callable by an admin (manual button) or by the
// scheduled cron (which authenticates with the service-role key).
//
// Also sends notification emails via Microsoft Graph (as the shared sales@
// mailbox) on genuinely-new invoices and on project status changes. Honors the
// app_settings.emails_paused kill switch; best-effort if creds are unset.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { brandedEmail } from "../_shared/email-template.ts";

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

    const customerRows = contacts.map((c) => {
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
    const custMap = new Map((custList ?? []).map((c) => [c.zoho_contact_id, c.id]));
    const custEmail = new Map((custList ?? []).map((c) => [c.id, c.email]));

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

    // Email customers whose project status changed
    for (const p of projects) {
      const newStatus = mapProjectStatus(p.status);
      const prev = oldStatus.get(String(p.project_id));
      if (prev !== undefined && prev !== newStatus) {
        const email = custEmail.get(custMap.get(String(p.customer_id)) ?? "");
        await sendEmail(
          admin,
          email,
          `Project status updated: ${p.project_name}`,
          brandedEmail({
            preheader: `Your project ${p.project_name} is now ${newStatus}.`,
            title: `Project status updated`,
            bodyHtml: `<p>The status of your project <strong>${p.project_name}</strong> is now <strong>${newStatus}</strong>.</p>`,
          }),
        );
      }
    }

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

    // 3) Invoices — capture existing ids first so we can detect new ones
    const { data: existingInvoices } = await admin.from("cportal_invoices").select("zoho_invoice_id");
    const existingInvIds = new Set((existingInvoices ?? []).map((i) => i.zoho_invoice_id));

    const invoices = await fetchAll("invoices", "invoices", accessToken, orgId);
    const invoiceRows = invoices.map((inv) => ({
      zoho_invoice_id: String(inv.invoice_id),
      customer_id: custMap.get(String(inv.customer_id)) ?? null,
      project_id: inv.project_id ? (projMap.get(String(inv.project_id)) ?? null) : null,
      invoice_number: inv.invoice_number ?? null,
      status: inv.status ?? null,
      total: inv.total ?? null,
      balance: inv.balance ?? null,
      currency_code: inv.currency_code ?? null,
      invoice_date: inv.date || null,
      due_date: inv.due_date || null,
    }));
    if (invoiceRows.length) {
      const { error } = await admin.from("cportal_invoices").upsert(invoiceRows, { onConflict: "zoho_invoice_id" });
      if (error) throw error;
    }

    // Email customers about genuinely-new invoices
    for (const inv of invoices) {
      if (!existingInvIds.has(String(inv.invoice_id))) {
        const email = custEmail.get(custMap.get(String(inv.customer_id)) ?? "");
        await sendEmail(
          admin,
          email,
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
        membersAdded,
        customersRemoved,
        customersOrphaned,
      },
      at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
