// Supabase Edge Function: invoice-pdf
// Returns the PDF for a single invoice, fetched live from Zoho Books.
// Authorized for admins, or the customer the invoice belongs to (matched by email).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ZOHO_ACCOUNTS = "https://accounts.zoho.com";
const ZOHO_BOOKS = "https://www.zohoapis.com/books/v3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
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
  if (!data.access_token) throw new Error("Zoho token refresh failed");
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return jsonError("Not authorized", 403);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return jsonError("Not authorized", 403);

  try {
    const { invoiceId } = await req.json();
    if (!invoiceId) return jsonError("invoiceId is required", 400);

    const { data: invoice } = await admin
      .from("cportal_invoices").select("zoho_invoice_id, customer_id").eq("id", invoiceId).single();
    if (!invoice) return jsonError("Invoice not found", 404);

    // Authorize: admins, or the customer this invoice belongs to (matched by email).
    const { data: profile } = await admin.from("cportal_profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "admin") {
      let ok = false;
      if (invoice.customer_id) {
        const { data: cust } = await admin.from("cportal_customers").select("email").eq("id", invoice.customer_id).single();
        if (cust?.email && user.email && cust.email.toLowerCase() === user.email.toLowerCase()) ok = true;
      }
      if (!ok) return jsonError("Not authorized to view this invoice", 403);
    }

    const orgId = Deno.env.get("ZOHO_ORG_ID")!;
    const accessToken = await getAccessToken();
    const pdfRes = await fetch(
      `${ZOHO_BOOKS}/invoices/${invoice.zoho_invoice_id}?organization_id=${orgId}&accept=pdf`,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}` } },
    );
    if (!pdfRes.ok) return jsonError("Could not fetch the invoice from Zoho", 502);

    const pdf = await pdfRes.arrayBuffer();
    return new Response(pdf, {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/pdf" },
    });
  } catch (e) {
    return jsonError(String((e as Error)?.message ?? e), 500);
  }
});
