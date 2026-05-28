// Supabase Edge Function: sync-zoho
// Pulls Customers (contacts), Projects, and Invoices from Zoho Books (US data
// center) and upserts them into Supabase. Uses the service-role key, so it
// bypasses RLS when writing. Callable by an admin (manual button) or by the
// scheduled cron (which authenticates with the service-role key).
//
// Also sends notification emails via Resend on genuinely-new invoices and on
// project status changes (best-effort; skipped if RESEND_API_KEY is unset).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// Send an email via Resend. Best-effort: no-op if RESEND_API_KEY is unset.
async function sendEmail(to: string | null | undefined, subject: string, html: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey || !to) return;
  const from = Deno.env.get("NOTIFY_FROM") || "Hydro-Wates Portal <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    if (!res.ok) console.error("Resend error:", await res.text());
  } catch (e) {
    console.error("Resend send failed:", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Authorize: allow the scheduled cron (service-role key) or an admin user.
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
    const orgId = Deno.env.get("ZOHO_ORG_ID")!;
    const accessToken = await getAccessToken();

    // 1) Customers (Zoho contacts)
    const contacts = await fetchAll("contacts", "contacts", accessToken, orgId);
    const customerRows = contacts.map((c) => ({
      zoho_contact_id: String(c.contact_id),
      name: c.contact_name ?? null,
      email: c.email || null,
      company: c.company_name || null,
      updated_at: new Date().toISOString(),
    }));
    if (customerRows.length) {
      const { error } = await admin.from("customers").upsert(customerRows, { onConflict: "zoho_contact_id" });
      if (error) throw error;
    }

    const { data: custList } = await admin.from("customers").select("id, zoho_contact_id, email");
    const custMap = new Map((custList ?? []).map((c) => [c.zoho_contact_id, c.id]));
    const custEmail = new Map((custList ?? []).map((c) => [c.id, c.email]));

    // 2) Projects — capture existing statuses first so we can detect changes
    const { data: existingProjects } = await admin
      .from("projects").select("zoho_project_id, status").not("zoho_project_id", "is", null);
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
      const { error } = await admin.from("projects").upsert(projectRows, { onConflict: "zoho_project_id" });
      if (error) throw error;
    }

    // Email customers whose project status changed
    for (const p of projects) {
      const newStatus = mapProjectStatus(p.status);
      const prev = oldStatus.get(String(p.project_id));
      if (prev !== undefined && prev !== newStatus) {
        const email = custEmail.get(custMap.get(String(p.customer_id)) ?? "");
        await sendEmail(
          email,
          `Project status updated: ${p.project_name}`,
          `<p>The status of your project <strong>${p.project_name}</strong> is now <strong>${newStatus}</strong>.</p>`,
        );
      }
    }

    const { data: projList } = await admin
      .from("projects").select("id, zoho_project_id").not("zoho_project_id", "is", null);
    const projMap = new Map((projList ?? []).map((p) => [p.zoho_project_id, p.id]));

    // 3) Invoices — capture existing ids first so we can detect new ones
    const { data: existingInvoices } = await admin.from("invoices").select("zoho_invoice_id");
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
      const { error } = await admin.from("invoices").upsert(invoiceRows, { onConflict: "zoho_invoice_id" });
      if (error) throw error;
    }

    // Email customers about genuinely-new invoices
    for (const inv of invoices) {
      if (!existingInvIds.has(String(inv.invoice_id))) {
        const email = custEmail.get(custMap.get(String(inv.customer_id)) ?? "");
        await sendEmail(
          email,
          `New invoice ${inv.invoice_number ?? ""}`.trim(),
          `<p>A new invoice <strong>${inv.invoice_number ?? ""}</strong> for <strong>${money(inv.total, inv.currency_code)}</strong> is now available in your portal.</p>`,
        );
      }
    }

    return json({
      ok: true,
      synced: {
        customers: customerRows.length,
        projects: projectRows.length,
        invoices: invoiceRows.length,
      },
      at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
