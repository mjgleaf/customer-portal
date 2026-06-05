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
import { brandedEmail } from "../_shared/email-template.ts";
import { renderProjectInfoBlock } from "../_shared/project-context.ts";

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
    .from("app_settings").select("value").eq("key", "emails_paused").maybeSingle();
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
    const { projectId, noteId, isUpdate, portalUrl } = await req.json();
    if (!projectId) return json({ error: "projectId is required" }, 400);

    // Fetch the project (we'll need name + customer linkage for routing).
    const { data: project } = await admin
      .from("projects").select("name, customer_id, description, lead_comments").eq("id", projectId).single();
    if (!project) return json({ error: "Project not found" }, 404);

    // The calling user is the note author.
    const { data: authorProfile } = await admin
      .from("profiles").select("full_name, email, role").eq("id", user.id).single();
    if (!authorProfile) return json({ error: "Author profile not found" }, 404);

    // Fetch the note content for the email body. If a specific noteId was
    // passed, use it; otherwise fall back to the most recent note on this
    // project (covers the "just added" case).
    let noteContent = "";
    if (noteId) {
      const { data: note } = await admin
        .from("project_notes").select("content").eq("id", noteId).maybeSingle();
      if (note) noteContent = note.content;
    } else {
      const { data: latest } = await admin
        .from("project_notes").select("content")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();
      if (latest) noteContent = latest.content;
    }

    // Build the recipient set. The author themselves is always excluded.
    const recipients = new Set<string>();
    if (authorProfile.role === "admin") {
      // Admin authored -> notify customer + project members
      if (project.customer_id) {
        const { data: cust } = await admin.from("customers").select("email").eq("id", project.customer_id).single();
        if (cust?.email && cust.email.toLowerCase() !== authorProfile.email.toLowerCase()) {
          const { data: prof } = await admin
            .from("profiles").select("email, email_notifications")
            .ilike("email", cust.email).maybeSingle();
          if (!prof || prof.email_notifications !== false) recipients.add(cust.email);
        }
      }
      const { data: members } = await admin.from("project_members").select("user_id").eq("project_id", projectId);
      if (members && members.length) {
        const { data: profs } = await admin
          .from("profiles")
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

    if (recipients.size === 0) return json({ ok: true, sent: 0, note: "No recipients (or all opted out)." });

    const authorName = authorProfile.full_name || authorProfile.email || "Someone";
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

    await sendEmail(admin, [...recipients], subject, html);
    return json({ ok: true, sent: recipients.size });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
