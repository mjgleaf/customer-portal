// Supabase Edge Function: submit-quote-request
// Called by the customer portal when a logged-in user submits the in-portal
// Request-for-Quote form. We:
//   1. Authenticate the caller (must be a logged-in user)
//   2. Insert the row into public.cportal_quote_requests
//   3. POST the payload to the existing Power Automate webhook so the
//      original RFQ automation (SharePoint list entry, Teams notifications,
//      whatever else) runs unchanged.
//
// We deliberately do NOT send a separate notification email from the portal.
// The Power Automate flow handles team notifications; sending email here
// caused SharePoint list rows to be created twice (once from the email-
// triggered flow, once from the webhook-triggered flow).
//
// Attachments are uploaded directly by the frontend to the
// `quote-attachments` storage bucket before this function is called; the
// frontend only passes the storage paths to us so we can include them in
// the Power Automate payload.

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

// --- Microsoft Graph (app-only) email sender -------------------------------
// Same pattern as notify-upload / send-reminder.
const MAIL_SENDER = Deno.env.get("MAIL_SENDER") || "sales@hydrowates.com";

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

async function sendEmail(
  admin: ReturnType<typeof createClient>,
  to: string[],
  subject: string,
  html: string,
) {
  const { data: setting } = await admin
    .from("cportal_app_settings").select("value").eq("key", "emails_paused").maybeSingle();
  if (setting?.value !== "false") {
    console.log(`[emails paused] would send "${subject}" to: ${to.join(", ")}`);
    return;
  }
  const list = to.filter(Boolean);
  if (list.length === 0) return;
  let token: string;
  try { token = await graphToken(); }
  catch (e) { console.error("Graph token failed:", e); return; }
  for (const address of list) {
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
              toRecipients: [{ emailAddress: { address } }],
            },
            saveToSentItems: false,
          }),
        },
      );
      if (!res.ok) console.error(`Graph sendMail error for ${address}:`, res.status, await res.text());
    } catch (e) {
      console.error(`Graph sendMail failed for ${address}:`, e);
    }
  }
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Caller must be a logged-in user.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 401);

  try {
    const body = await req.json();
    const {
      name, company, phone, email, address, city, state, zip,
      requestTypes, comments, attachmentPaths, portalUrl,
    } = body ?? {};

    // Validate the required fields (mirrors the MODX FormIt validator)
    if (!name || !email || !comments) {
      return json({ error: "Name, email, and message are required." }, 400);
    }
    if (!Array.isArray(requestTypes) || requestTypes.length === 0) {
      return json({ error: "Please pick at least one quote type." }, 400);
    }

    // 1. Insert into quote_requests (service-role bypasses RLS)
    const { data: row, error: insertError } = await admin
      .from("cportal_quote_requests")
      .insert({
        user_id: user.id,
        name: String(name).trim(),
        company: company ? String(company).trim() : null,
        phone: phone ? String(phone).trim() : null,
        email: String(email).trim().toLowerCase(),
        address: address ? String(address).trim() : null,
        city: city ? String(city).trim() : null,
        state: state ? String(state).trim() : null,
        zip: zip ? String(zip).trim() : null,
        request_types: requestTypes,
        comments: String(comments).trim(),
        attachment_paths: Array.isArray(attachmentPaths) ? attachmentPaths : [],
      })
      .select()
      .single();

    if (insertError) {
      console.error("quote_requests insert failed:", insertError);
      return json({ error: insertError.message }, 500);
    }

    // 2. Forward to Power Automate webhook (best-effort). Match the same
    //    flattened format the MODX PHP hook used so the existing flow can
    //    process portal-submitted RFQs without any changes.
    let webhookStatus: string = "skipped";
    const webhookUrl = Deno.env.get("POWER_AUTOMATE_RFQ_WEBHOOK_URL");
    if (webhookUrl) {
      try {
        const flattened = {
          name,
          company: company ?? "",
          phone: phone ?? "",
          email,
          address: address ?? "",
          city: city ?? "",
          state: state ?? "",
          zip: zip ?? "",
          // MODX flattens checkbox arrays to comma-separated; do the same.
          request_type: (requestTypes as string[]).join(", "),
          comments,
          attachment_count: Array.isArray(attachmentPaths) ? attachmentPaths.length : 0,
          source: "customer-portal",
          submitted_at: new Date().toISOString(),
          quote_request_id: row.id,
        };
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(flattened),
        });
        webhookStatus = res.ok ? `ok (${res.status})` : `failed (${res.status})`;
        if (!res.ok) console.error("Power Automate webhook failed:", res.status, await res.text());
      } catch (e) {
        webhookStatus = `error: ${(e as Error)?.message ?? e}`;
        console.error("Power Automate webhook error:", e);
      }
      // Record the outcome on the row for the admin queue.
      await admin.from("cportal_quote_requests")
        .update({ webhook_status: webhookStatus })
        .eq("id", row.id);
    }

    return json({ ok: true, id: row.id, webhookStatus });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
