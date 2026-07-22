// Supabase Edge Function: notify-project-note
// Fired by the portal whenever a project note is added or updated. We:
//   1. Authenticate the caller (must already be able to access the project)
//   2. Identify whether the author is an admin or a customer
//   3. Email the *other* side via Microsoft Graph:
//        - admin authored  -> notify project's customer(s) + members
//        - customer authored -> notify the Hydro-Wates team mailbox
// Honors the app_settings.emails_paused kill switch and each profile's
// email_notifications preference.

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

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Branded email wrapper + project-info block (inlined copies of the
//     _shared helpers so this function deploys as one self-contained file) --
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

interface ProjectContext {
  name: string;
  description?: string | null;
  lead_comments?: string | null;
}

function escMultiline(s: string): string {
  return esc(s).replace(/\r?\n/g, "<br>");
}

const SCOPE_LIMIT = 600;

function clamp(s: string, max: number): { text: string; truncated: boolean } {
  const trimmed = s.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  const slice = trimmed.slice(0, max);
  const lastBreak = slice.lastIndexOf(" ");
  const cut = lastBreak > max * 0.7 ? slice.slice(0, lastBreak) : slice;
  return { text: cut.trim() + "…", truncated: true };
}

function renderProjectInfoBlock(p: ProjectContext): string {
  const description = (p.description ?? "").trim();
  const scope = (p.lead_comments ?? "").trim();
  if (!description && !scope) return "";

  const parts: string[] = [];
  if (description) {
    parts.push(
      `<div style="font-size:13px;color:#374151;line-height:1.5;margin-bottom:${scope ? "10px" : "0"};">
         <span style="display:inline-block;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Description</span><br>
         ${esc(description)}
       </div>`,
    );
  }
  if (scope) {
    const { text, truncated } = clamp(scope, SCOPE_LIMIT);
    parts.push(
      `<div style="font-size:13px;color:#374151;line-height:1.5;">
         <span style="display:inline-block;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Project scope</span><br>
         ${escMultiline(text)}${truncated ? ` <span style=\"color:#6b7280;font-style:italic;\">(full scope in the portal)</span>` : ""}
       </div>`,
    );
  }

  return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-left:3px solid #2563eb;border-radius:6px;padding:14px 16px;margin:16px 0;">
            <div style="font-size:12px;font-weight:600;color:#1e293b;margin-bottom:8px;">${esc(p.name)}</div>
            ${parts.join("")}
          </div>`;
}

// --- Microsoft Graph (app-only) email sender -------------------------------
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
              replyTo: [{ emailAddress: { address: REPLY_TO } }],
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Caller must be logged in.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 401);

  try {
    const { projectId, noteId, isUpdate, portalUrl, mentionedUserIds, internal } = await req.json();
    if (!projectId) return json({ error: "projectId is required" }, 400);

    // Fetch the project (we'll need name + customer linkage for routing).
    const { data: project } = await admin
      .from("cportal_projects").select("name, customer_id, description, lead_comments").eq("id", projectId).single();
    if (!project) return json({ error: "Project not found" }, 404);

    // The calling user is the note author.
    const { data: authorProfile } = await admin
      .from("cportal_profiles").select("full_name, email, role").eq("id", user.id).single();
    if (!authorProfile) return json({ error: "Author profile not found" }, 404);
    const authorName = authorProfile.full_name || authorProfile.email || "Someone";

    // Fetch the note content for the email body. If a specific noteId was
    // passed, use it; otherwise fall back to the most recent note on this
    // project (covers the "just added" case).
    let noteContent = "";
    if (noteId) {
      const { data: note } = await admin
        .from("cportal_project_notes").select("content").eq("id", noteId).maybeSingle();
      if (note) noteContent = note.content;
    } else {
      const { data: latest } = await admin
        .from("cportal_project_notes").select("content")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();
      if (latest) noteContent = latest.content;
    }

    // --- @mentions: record each mention (drives the in-app red dot) and send
    //     the mentioned person a targeted email. These addresses are then
    //     excluded from the general note email below so nobody gets two.
    const mentionedEmails = new Set<string>();
    const rawMentionIds: string[] = Array.isArray(mentionedUserIds)
      ? mentionedUserIds.filter((x: unknown): x is string => typeof x === "string")
      : [];
    let mentionCount = 0;
    if (noteId && rawMentionIds.length) {
      // Fetch role too so we can ENFORCE that an internal (team-only) note
      // never tags or emails a customer — that would leak the private note's
      // content to someone who can't even see it in the portal. This backs up
      // the same rule in the UI, in case the client is bypassed.
      const { data: mentionedProfiles } = await admin
        .from("cportal_profiles").select("id, email, role, email_notifications").in("id", rawMentionIds);
      const allowed = (mentionedProfiles ?? []).filter((p) =>
        !internal || p.role === "admin" || p.role === "service_tech"
      );
      if (allowed.length) {
        await admin.from("cportal_note_mentions").upsert(
          allowed.map((p) => ({ note_id: noteId, project_id: projectId, mentioned_user_id: p.id })),
          { onConflict: "note_id,mentioned_user_id", ignoreDuplicates: true },
        );
      }
      const mLink = portalUrl ? `${portalUrl}/projects/${projectId}` : "";
      for (const person of allowed) {
        if (!person.email) continue;
        const em = person.email.toLowerCase();
        mentionedEmails.add(em);
        if (em === authorProfile.email.toLowerCase()) continue;   // don't notify yourself
        if (person.email_notifications === false) continue;
        mentionCount++;
        const mSubject = `${authorName} mentioned you on ${project.name}`;
        await sendEmail(admin, [person.email], mSubject, brandedEmail({
          preheader: `${authorName} mentioned you in a note on ${project.name}.`,
          title: mSubject,
          bodyHtml: `<p><strong>${esc(authorName)}</strong> mentioned you in a note on project <strong>${esc(project.name)}</strong>:</p>
                     <blockquote style="border-left:3px solid #d1d5db;padding-left:12px;margin:12px 0;color:#4b5563;white-space:pre-wrap;background:#f9fafb;padding:12px 16px;border-radius:0 6px 6px 0;">${esc(noteContent)}</blockquote>
                     ${renderProjectInfoBlock(project)}`,
          ctaLabel: mLink ? "Open project" : undefined,
          ctaUrl: mLink || undefined,
        }));
      }
    }

    // Build the recipient set. The author themselves is always excluded.
    // Service techs are routed the same as admins — they're on the company
    // side, so a tech leaving a note should email the customer, not the
    // shared team mailbox.
    const authorIsTeam = authorProfile.role === "admin" || authorProfile.role === "service_tech";
    const recipients = new Set<string>();
    if (authorIsTeam) {
      // Team member authored -> notify customer + project members
      if (project.customer_id) {
        const { data: cust } = await admin.from("cportal_customers").select("email").eq("id", project.customer_id).single();
        if (cust?.email && cust.email.toLowerCase() !== authorProfile.email.toLowerCase()) {
          const { data: prof } = await admin
            .from("cportal_profiles").select("email, email_notifications")
            .ilike("email", cust.email).maybeSingle();
          if (!prof || prof.email_notifications !== false) recipients.add(cust.email);
        }
      }
      const { data: members } = await admin.from("cportal_project_members").select("user_id").eq("project_id", projectId);
      if (members && members.length) {
        const { data: profs } = await admin
          .from("cportal_profiles")
          .select("email, email_notifications")
          .in("id", members.map((m) => m.user_id));
        for (const p of profs ?? []) {
          if (p.email
              && p.email_notifications !== false
              && p.email.toLowerCase() !== authorProfile.email.toLowerCase()) {
            recipients.add(p.email);
          }
        }
      }
    } else {
      // Customer authored -> notify the Hydro-Wates team mailbox
      const teamEmail = Deno.env.get("ADMIN_NOTIFY_EMAIL") || "sales@hydrowates.com";
      recipients.add(teamEmail);
    }

    const action = isUpdate ? "updated a note" : "added a note";
    const projectLink = portalUrl ? `${portalUrl}/projects/${projectId}` : "";
    const subject = `${authorName} ${action} on ${project.name}`;
    const html = brandedEmail({
      preheader: `${authorName} ${action} on ${project.name}.`,
      title: subject,
      bodyHtml: `<p><strong>${esc(authorName)}</strong> ${action} on project <strong>${esc(project.name)}</strong>:</p>
                 <blockquote style="border-left:3px solid #d1d5db;padding-left:12px;margin:12px 0;color:#4b5563;white-space:pre-wrap;background:#f9fafb;padding:12px 16px;border-radius:0 6px 6px 0;">${esc(noteContent)}</blockquote>
                 ${renderProjectInfoBlock(project)}`,
      ctaLabel: projectLink ? "Open project" : undefined,
      ctaUrl: projectLink || undefined,
    });

    // General note email goes to the other side — but never for an internal
    // (team-only) note, and never to anyone who already got a mention email.
    const generalRecipients = internal
      ? []
      : [...recipients].filter((r) => !mentionedEmails.has(r.toLowerCase()));
    if (generalRecipients.length) {
      await sendEmail(admin, generalRecipients, subject, html);
    }
    return json({ ok: true, sent: generalRecipients.length, mentioned: mentionCount });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
