// Supabase Edge Function: notify-invite-accepted
//
// Notifies Hydro-Wates (a shared inbox) when an invited customer accepts
// their invitation — i.e. clicks the invite link and confirms their account
// for the first time. Fired by a database trigger on auth.users (see
// migration 99000010_notify_invite_accepted.sql) via pg_net, NOT by the
// client, so it's gated behind a shared secret rather than a user session.
//
// Reuses the same Microsoft Graph pipeline (notifications@hydrowates.com)
// and brandedEmail template as send-auth-email / notify-upload, so the
// internal alert looks consistent with the rest of our mail.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Shared inbox that receives the alert. Override per-environment with
// INVITE_NOTIFY_TO (e.g. sales@hydrowates.com).
const NOTIFY_TO = Deno.env.get("INVITE_NOTIFY_TO") || "notifications@hydrowates.com";
const MAIL_SENDER = Deno.env.get("MAIL_SENDER") || "notifications@hydrowates.com";
const PORTAL_URL = Deno.env.get("PORTAL_URL") || "https://connect.hydrowates.com";

// Shared secret the trigger must present. We refuse to run without it set
// so this endpoint can never be triggered anonymously.
const NOTIFY_SECRET = Deno.env.get("INVITE_NOTIFY_SECRET") || "";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Branded email wrapper (inlined copy of _shared/email-template.ts so
//     this function deploys as a single self-contained file) ---------------
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

        <!-- Header bar -->
        <tr>
          <td align="center" style="padding:28px 32px;background-color:#1e293b;">
            ${headerVisual}
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 32px 24px 32px;">
            <h1 style="margin:0 0 16px 0;font-size:20px;line-height:1.4;color:#111827;font-weight:600;">${esc(opts.title)}</h1>
            <div style="font-size:15px;line-height:1.6;color:#374151;">${opts.bodyHtml}</div>
            ${ctaBlock}
            ${footnote}
          </td>
        </tr>

        <!-- Footer -->
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

// --- Microsoft Graph (app-only) email sender ------------------------------
async function graphToken(): Promise<string> {
  const tenant = Deno.env.get("GRAPH_TENANT_ID") || Deno.env.get("SHAREPOINT_TENANT_ID");
  const clientId = Deno.env.get("GRAPH_CLIENT_ID") || Deno.env.get("SHAREPOINT_CLIENT_ID");
  const clientSecret = Deno.env.get("GRAPH_CLIENT_SECRET") || Deno.env.get("SHAREPOINT_CLIENT_SECRET");
  if (!tenant || !clientId || !clientSecret) {
    throw new Error("Missing Graph mail credentials");
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

async function sendViaGraph(to: string, subject: string, html: string): Promise<void> {
  const token = await graphToken();
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
        },
        saveToSentItems: false,
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Graph sendMail failed: ${res.status} ${detail.slice(0, 200)}`);
  }
}

interface AcceptedPayload {
  user_id?: string;
  email?: string;
  full_name?: string | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  if (!NOTIFY_SECRET) {
    console.error("INVITE_NOTIFY_SECRET is not set — refusing to run");
    return new Response("Server not configured", { status: 500 });
  }
  // Constant-ish check: the trigger sends the secret in this header.
  if ((req.headers.get("x-notify-secret") ?? "") !== NOTIFY_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: AcceptedPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const email = (payload.email || "").trim().toLowerCase();
  if (!email) return new Response("Missing email", { status: 400 });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Best-effort company/name context. The accepting user's email usually
    // matches either a customer row or one of its contacts; we surface the
    // company so the alert reads "Acme Corp" rather than just an address.
    let company: string | null = null;
    let personName: string | null = payload.full_name || null;

    const { data: custMatch } = await admin
      .from("cportal_customers")
      .select("company, name")
      .ilike("email", email)
      .maybeSingle();
    if (custMatch) {
      company = custMatch.company ?? null;
      personName = personName || custMatch.name;
    } else {
      const { data: contactMatch } = await admin
        .from("cportal_customer_contacts")
        .select("name, customer_id, cportal_customers(company)")
        .ilike("email", email)
        .maybeSingle();
      if (contactMatch) {
        personName = personName || contactMatch.name;
        company = (contactMatch as { cportal_customers?: { company?: string } }).cportal_customers?.company ?? null;
      }
    }

    const who = personName ? `${personName} (${email})` : email;
    const companyLine = company
      ? `<p><strong>Company:</strong> ${esc(company)}</p>`
      : "";

    const subject = company
      ? `Portal activated: ${company}`
      : `Portal activated: ${who}`;

    const html = brandedEmail({
      preheader: `${who} just activated their Hydro-Wates portal account.`,
      title: "A customer accepted their invitation",
      bodyHtml: `
        <p>A customer has just set up their account and can now sign in to the Hydro-Wates Customer Portal.</p>
        <p><strong>Name:</strong> ${esc(personName || "—")}</p>
        <p><strong>Email:</strong> ${esc(email)}</p>
        ${companyLine}
      `,
      ctaLabel: "Open the portal",
      ctaUrl: PORTAL_URL,
      footnote: "You're receiving this because portal-acceptance alerts go to this shared inbox.",
    });

    await sendViaGraph(NOTIFY_TO, subject, html);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    // Log but don't fail loudly — the trigger fires async via pg_net and a
    // 500 here would just be retried/dropped; we never want to block a
    // customer's sign-in over a notification.
    console.error("notify-invite-accepted failed:", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
