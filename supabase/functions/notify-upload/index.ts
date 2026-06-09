// Supabase Edge Function: notify-upload
// Called by the app right after a file is uploaded to a project. Emails the
// right party via Microsoft Graph (sends as the shared sales@ mailbox):
//   - admin uploaded   -> notify the project's customer(s)
//   - customer uploaded -> notify the Hydro-Wates team (ADMIN_NOTIFY_EMAIL)
// Best-effort; no-op if the Graph mail credentials are unset.

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

// --- Microsoft Graph (app-only) email sender -------------------------------
// Sends as the shared mailbox sales@hydrowates.com using a client-credentials
// app (the same kind used for SharePoint). Requires Mail.Send (Application)
// consent + an Application Access Policy scoping the app to sales@. Set
// dedicated GRAPH_* secrets, or reuse the existing SHAREPOINT_* ones.
const MAIL_SENDER = Deno.env.get("MAIL_SENDER") || "sales@hydrowates.com";
// When a customer hits "Reply" in their email client, the reply goes here
// instead of the sender. We point at the sales@ M365 Group so the whole
// team sees customer responses, even though sales@ can't be the sender.
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
  // Admin-controlled kill switch via app_settings.emails_paused. Defaults to
  // paused — the admin flips it active from the portal's Account page when
  // they're ready to start sending customer emails.
  const { data: setting } = await admin
    .from("cportal_app_settings").select("value").eq("key", "emails_paused").maybeSingle();
  if (setting?.value !== "false") {
    console.log(`[emails paused] would send "${subject}" to: ${to.join(", ")}`);
    return;
  }
  const list = to.filter(Boolean);
  if (list.length === 0) return;
  let token: string;
  try {
    token = await graphToken();
  } catch (e) {
    console.error("Graph token failed:", e);
    return;
  }
  // Send one message per recipient so customers never see each other's
  // addresses, and one failure doesn't block the rest.
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

  // Caller must be a logged-in user.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 403);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 403);

  try {
    const { projectId, fileName, portalUrl } = await req.json();
    if (!projectId) return json({ error: "projectId is required" }, 400);

    const { data: uploader } = await admin
      .from("cportal_profiles").select("role, full_name, email").eq("id", user.id).single();
    const { data: project } = await admin
      .from("cportal_projects").select("name, customer_id, description, lead_comments").eq("id", projectId).single();
    if (!project) return json({ error: "Project not found" }, 404);

    const file = fileName || "a file";
    const projectLink = portalUrl ? `${portalUrl}` : "";

    if (uploader?.role === "admin") {
      // Notify the project's customer(s) — but respect their email_notifications
      // preference (true / null = send, false = skip).
      const recipients = new Set<string>();
      if (project.customer_id) {
        const { data: cust } = await admin.from("cportal_customers").select("email").eq("id", project.customer_id).single();
        if (cust?.email) {
          const { data: custProf } = await admin
            .from("cportal_profiles").select("email, email_notifications").ilike("email", cust.email).maybeSingle();
          if (!custProf || custProf.email_notifications !== false) recipients.add(cust.email);
        }
      }
      const { data: members } = await admin.from("cportal_project_members").select("user_id").eq("project_id", projectId);
      if (members && members.length) {
        const { data: profs } = await admin
          .from("cportal_profiles")
          .select("email, email_notifications")
          .in("id", members.map((m) => m.user_id));
        for (const p of profs ?? []) {
          if (p.email && p.email_notifications !== false) recipients.add(p.email);
        }
      }
      await sendEmail(
        admin,
        [...recipients],
        `New document on ${project.name}`,
        brandedEmail({
          preheader: `${file} was just added to your project.`,
          title: `New document on ${project.name}`,
          bodyHtml: `<p>A new document <strong>${file}</strong> has been added to your project <strong>${project.name}</strong> by the Hydro-Wates team.</p>
                     ${renderProjectInfoBlock(project)}`,
          ctaLabel: projectLink ? "View in portal" : undefined,
          ctaUrl: projectLink || undefined,
        }),
      );
    } else {
      // Customer uploaded -> notify the team's sales mailbox.
      const adminEmail = Deno.env.get("ADMIN_NOTIFY_EMAIL") || "sales@hydrowates.com";
      const who = uploader?.full_name || uploader?.email || "A customer";
      await sendEmail(
        admin,
        [adminEmail],
        `Customer uploaded a file to ${project.name}`,
        brandedEmail({
          preheader: `${who} uploaded ${file}.`,
          title: `Customer upload on ${project.name}`,
          bodyHtml: `<p><strong>${who}</strong> uploaded <strong>${file}</strong> to project <strong>${project.name}</strong>.</p>
                     ${renderProjectInfoBlock(project)}`,
          ctaLabel: projectLink ? "Review in portal" : undefined,
          ctaUrl: projectLink || undefined,
        }),
      );
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
