// Branded HTML email wrapper used by every customer-facing notification
// function (notify-upload, send-reminder, sync-zoho, notify-project-note).
//
// Reliable across Outlook / Gmail / Apple Mail because everything uses
// inline styles + table-based layout (the email standard from the 2000s
// that still works in 2026 because Outlook's rendering engine is Word's).
//
// The header logo loads from `EMAIL_LOGO_URL` (Supabase secret). When that
// secret isn't set we fall back to a styled text wordmark so the email
// still looks branded — never a broken image.

export interface BrandedEmailOptions {
  /** Hidden text shown in the inbox preview snippet (Gmail, etc.). */
  preheader?: string;
  /** Big heading inside the email body. */
  title: string;
  /** Main content as HTML (paragraphs, lists, etc.). */
  bodyHtml: string;
  /** Optional call-to-action button label. */
  ctaLabel?: string;
  /** Optional call-to-action button URL. */
  ctaUrl?: string;
  /** Optional small footnote shown just above the system footer. */
  footnote?: string;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function brandedEmail(opts: BrandedEmailOptions): string {
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
              Manage email preferences in the portal under <strong>Account → Email notifications</strong>.
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
