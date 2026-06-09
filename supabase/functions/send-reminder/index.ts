// Supabase Edge Function: send-reminder
// Admin clicks "Remind" next to a missing required document on a project.
// We email the project's customer (and any portal-member profiles) via
// Microsoft Graph (as the shared sales@ mailbox), nudging them to upload that
// document. Best-effort; no-op if the Graph mail credentials are unset.

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
  // paused — admin flips it active from the portal's Account page.
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

  // Caller must be an admin.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 403);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 403);
  const { data: caller } = await admin.from("cportal_profiles").select("role").eq("id", user.id).single();
  if (caller?.role !== "admin") return json({ error: "Admin only" }, 403);

  try {
    const { projectId, documentLabel, documentKey, recipients: explicitRecipients, portalUrl } = await req.json();
    if (!projectId || !documentLabel) return json({ error: "projectId and documentLabel are required" }, 400);

    const { data: project } = await admin
      .from("cportal_projects").select("name, customer_id, description, lead_comments").eq("id", projectId).single();
    if (!project) return json({ error: "Project not found" }, 404);

    // Build the recipient set. If the admin explicitly chose recipients in
    // the confirmation modal, trust their choice — they've already seen the
    // list and unchecked anyone they didn't want to email. Otherwise fall
    // back to auto-gather: project's customer + every portal member,
    // respecting each profile's email_notifications opt-out preference.
    const recipients = new Set<string>();
    if (Array.isArray(explicitRecipients) && explicitRecipients.length > 0) {
      for (const e of explicitRecipients) {
        if (typeof e === "string" && e.trim()) recipients.add(e.trim());
      }
    } else {
      if (project.customer_id) {
        const { data: cust } = await admin.from("cportal_customers").select("email").eq("id", project.customer_id).single();
        if (cust?.email) {
          const { data: prof } = await admin.from("cportal_profiles").select("email, email_notifications").ilike("email", cust.email).maybeSingle();
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
          if (p.email && p.email_notifications !== false) recipients.add(p.email);
        }
      }
    }

    // Log the reminder intent (admin clicked + confirmed) regardless of
    // whether an email actually goes out. The frontend reads from this table
    // to show "Reminded Xd ago" so admins don't double-remind. Delivery is a
    // separate concern — pause switch on, no recipients, Graph failure all
    // still constitute "we tried to remind" for UX purposes.
    await admin.from("cportal_reminders").insert({
      project_id: projectId,
      document_key: documentKey || documentLabel,
      document_label: documentLabel,
      sent_by: user.id,
    });

    if (recipients.size === 0) return json({ ok: true, sent: 0, note: "No recipients (or all opted out)." });

    await sendEmail(
      admin,
      [...recipients],
      `Reminder: ${documentLabel} still needed for ${project.name}`,
      brandedEmail({
        preheader: `${documentLabel} is still needed for ${project.name}.`,
        title: `Reminder: ${documentLabel} needed`,
        bodyHtml: `<p>Hi,</p>
                   <p>This is a friendly reminder that <strong>${documentLabel}</strong> is still needed for your project <strong>${project.name}</strong>.</p>
                   ${renderProjectInfoBlock(project)}
                   <p>You can upload it directly through the Hydro-Wates customer portal.</p>`,
        ctaLabel: portalUrl ? "Upload document" : undefined,
        ctaUrl: portalUrl || undefined,
        footnote: "Thanks for keeping your project moving — the Hydro-Wates team.",
      }),
    );

    return json({ ok: true, sent: recipients.size });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
