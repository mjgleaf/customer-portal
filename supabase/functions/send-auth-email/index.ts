// Supabase Edge Function: send-auth-email
//
// Supabase Auth "Send Email Hook". Replaces Supabase's built-in mailer with
// our own Microsoft Graph pipeline so every auth email (invite, recovery,
// magic link, signup confirmation, email change) goes out the same channel
// as our note/upload notifications — from notifications@hydrowates.com
// through the Hydro-Wates Microsoft 365 tenant.
//
// Why this instead of SMTP: the existing Graph app already has the
// Mail.Send permission on notifications@hydrowates.com (used by
// notify-project-note + notify-upload), so we sidestep the need to enable
// SMTP AUTH per-mailbox AND we get to brand the emails with our existing
// brandedEmail template.
//
// Webhook signature: Supabase signs each request with a shared secret
// using the Standard Webhooks spec. The function rejects any unsigned
// request with a 401.

import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

// Supabase Auth stores the secret as `v1,whsec_<base64>`. The
// standardwebhooks library expects just the base64 portion.
const RAW_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET") || "";
const HOOK_SECRET = RAW_SECRET.replace(/^v1,whsec_/, "");

const MAIL_SENDER = Deno.env.get("MAIL_SENDER") || "notifications@hydrowates.com";
const PORTAL_URL = Deno.env.get("PORTAL_URL") || "https://connect.hydrowates.com";

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

// --- Email rendering per action type --------------------------------------
interface SupabaseHookPayload {
  user: { email: string; new_email?: string };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: string;
    site_url: string;
    token_new?: string;
    token_hash_new?: string;
  };
}

interface RenderedEmail {
  to: string;
  subject: string;
  html: string;
}

// Build a link to our OWN /accept landing page rather than Supabase's
// /auth/v1/verify endpoint. The verify endpoint consumes the single-use
// token on the first GET, so email security scanners (Microsoft Defender
// Safe Links, Mimecast, etc.) that pre-fetch links were burning the token
// before the human clicked. The /accept page only calls verifyOtp on an
// explicit button click, so a scanner fetching it leaves the token intact.
function buildAcceptUrl(tokenHash: string, type: string): string {
  const params = new URLSearchParams({ token_hash: tokenHash, type });
  return `${PORTAL_URL}/accept?${params.toString()}`;
}

function buildVerifyUrl(_siteUrl: string, tokenHash: string, type: string, redirectTo: string): string {
  // Use the Supabase project URL from env (not site_url from the webhook
  // payload — that one already includes /auth/v1 and double-prefixed when
  // we appended /auth/v1/verify, plus the verify endpoint expects an
  // apikey query param to authorize the request).
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const apikey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const params = new URLSearchParams({
    token: tokenHash,
    type,
    redirect_to: redirectTo,
  });
  if (apikey) params.set("apikey", apikey);
  return `${supabaseUrl}/auth/v1/verify?${params.toString()}`;
}

function render(payload: SupabaseHookPayload): RenderedEmail {
  const { user, email_data } = payload;
  const { email_action_type, token_hash, redirect_to, site_url, token } = email_data;
  const verifyUrl = buildVerifyUrl(site_url, token_hash, email_action_type, redirect_to);

  switch (email_action_type) {
    case "invite": {
      const subject = "You've been invited to the Hydro-Wates portal";
      const html = brandedEmail({
        preheader: "Set your password to access your project files, certificates, and invoices.",
        title: "Welcome to the Hydro-Wates portal",
        bodyHtml: `
          <p>You've been invited to access the Hydro-Wates Customer Portal — a single place to view your project files, test certificates, invoices, and request new quotes.</p>
          <p>Click the button below to set your password and sign in.</p>
        `,
        ctaLabel: "Set my password",
        ctaUrl: buildAcceptUrl(token_hash, "invite"),
        footnote: "This invitation link works once and expires in 24 hours.",
      });
      return { to: user.email, subject, html };
    }

    case "recovery": {
      // Route through our /accept landing page; it sends recovery links on
      // to /reset-password after the human clicks, so the single-use token
      // survives email scanners (see buildAcceptUrl).
      const subject = "Reset your Hydro-Wates portal password";
      const html = brandedEmail({
        preheader: "Tap the link to choose a new password.",
        title: "Reset your password",
        bodyHtml: `
          <p>Someone (hopefully you) asked to reset the password on your Hydro-Wates portal account.</p>
          <p>Click below to choose a new password. If you didn't request this, you can safely ignore this email — your current password still works.</p>
        `,
        ctaLabel: "Reset password",
        ctaUrl: buildAcceptUrl(token_hash, "recovery"),
        footnote: "This link expires in 1 hour.",
      });
      return { to: user.email, subject, html };
    }

    case "magiclink": {
      const subject = "Your Hydro-Wates portal sign-in link";
      const html = brandedEmail({
        preheader: "Click to sign in — no password needed.",
        title: "Sign in to the portal",
        bodyHtml: `
          <p>Click below to sign in to the Hydro-Wates Customer Portal. No password required.</p>
        `,
        ctaLabel: "Sign in",
        ctaUrl: buildAcceptUrl(token_hash, "magiclink"),
        footnote: "This link expires in 1 hour. If you didn't request it, you can ignore this email.",
      });
      return { to: user.email, subject, html };
    }

    case "signup": {
      const subject = "Confirm your Hydro-Wates portal account";
      const html = brandedEmail({
        preheader: "One click to confirm your email.",
        title: "Confirm your account",
        bodyHtml: `
          <p>Thanks for signing up to the Hydro-Wates Customer Portal. Click below to confirm your email and finish creating your account.</p>
        `,
        ctaLabel: "Confirm my email",
        ctaUrl: buildAcceptUrl(token_hash, "signup"),
      });
      return { to: user.email, subject, html };
    }

    case "email_change":
    case "email_change_current":
    case "email_change_new": {
      // Supabase fires this once per side of the change. For the "new"
      // confirmation we email the new address; for everything else we
      // email the user's known address.
      const recipient =
        email_action_type === "email_change_new" ? (user.new_email || user.email) : user.email;
      const subject = "Confirm your new email address";
      const html = brandedEmail({
        preheader: "Tap the link to confirm the change.",
        title: "Confirm email change",
        bodyHtml: `
          <p>Click below to confirm the change of your Hydro-Wates portal email address. If you didn't ask to change it, ignore this email and contact us.</p>
        `,
        ctaLabel: "Confirm change",
        ctaUrl: verifyUrl,
      });
      return { to: recipient, subject, html };
    }

    case "reauthentication": {
      // No verify URL — the user enters the OTP code from the email body.
      const subject = "Confirm it's you — Hydro-Wates portal";
      const html = brandedEmail({
        preheader: "Enter this code to continue.",
        title: "Confirm it's you",
        bodyHtml: `
          <p>Enter the code below in the portal to confirm a sensitive change on your account:</p>
          <p style="font-size:22px;font-weight:600;letter-spacing:4px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:14px 18px;text-align:center;font-family:'Menlo','Consolas',monospace;">${esc(token)}</p>
        `,
      });
      return { to: user.email, subject, html };
    }

    default: {
      // Unknown type: fall back to a generic mail so we don't silently drop.
      const subject = "A new sign-in request on your Hydro-Wates account";
      const html = brandedEmail({
        preheader: "Action required on your account.",
        title: "Sign-in request",
        bodyHtml: `
          <p>There's a new action waiting on your Hydro-Wates portal account. Click below to continue.</p>
        `,
        ctaLabel: "Open portal",
        ctaUrl: verifyUrl || PORTAL_URL,
      });
      return { to: user.email, subject, html };
    }
  }
}

// --- Server ---------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok");
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  const headers = Object.fromEntries(req.headers);

  // Verify the webhook signature so only Supabase Auth can call us.
  if (!HOOK_SECRET) {
    console.error("SEND_EMAIL_HOOK_SECRET is not set");
    return new Response("Server not configured", { status: 500 });
  }
  let payload: SupabaseHookPayload;
  try {
    const wh = new Webhook(HOOK_SECRET);
    payload = wh.verify(raw, headers) as SupabaseHookPayload;
  } catch (e) {
    console.error("Webhook signature verification failed:", (e as Error).message);
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const email = render(payload);
    await sendViaGraph(email.to, email.subject, email.html);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    // Returning a non-2xx will make Supabase consider the email failed,
    // and the inviting admin will see "email rate limit" / generic error.
    // Log the real reason for ourselves.
    console.error("send-auth-email failed:", (e as Error).message);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
