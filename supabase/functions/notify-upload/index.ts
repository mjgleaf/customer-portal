// Supabase Edge Function: notify-upload
// Called by the app right after a file is uploaded to a project. Emails the
// right party via Resend:
//   - admin uploaded   -> notify the project's customer(s)
//   - customer uploaded -> notify the Hydro-Wates team (ADMIN_NOTIFY_EMAIL)
// Best-effort; no-op if RESEND_API_KEY is unset.

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

async function sendEmail(to: string[], subject: string, html: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const list = to.filter(Boolean);
  if (!apiKey || list.length === 0) return;
  const from = Deno.env.get("NOTIFY_FROM") || "Hydro-Wates Portal <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: list, subject, html }),
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

  // Caller must be a logged-in user.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 403);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 403);

  try {
    const { projectId, fileName, portalUrl } = await req.json();
    if (!projectId) return json({ error: "projectId is required" }, 400);

    const { data: uploader } = await admin
      .from("profiles").select("role, full_name, email").eq("id", user.id).single();
    const { data: project } = await admin
      .from("projects").select("name, customer_id").eq("id", projectId).single();
    if (!project) return json({ error: "Project not found" }, 404);

    const link = portalUrl ? `<p><a href="${portalUrl}">Open the portal</a></p>` : "";
    const file = fileName || "a file";

    if (uploader?.role === "admin") {
      // Notify the project's customer(s).
      const recipients = new Set<string>();
      if (project.customer_id) {
        const { data: cust } = await admin.from("customers").select("email").eq("id", project.customer_id).single();
        if (cust?.email) recipients.add(cust.email);
      }
      const { data: members } = await admin.from("project_members").select("user_id").eq("project_id", projectId);
      if (members && members.length) {
        const { data: profs } = await admin.from("profiles").select("email").in("id", members.map((m) => m.user_id));
        for (const p of profs ?? []) if (p.email) recipients.add(p.email);
      }
      await sendEmail(
        [...recipients],
        `New document on ${project.name}`,
        `<p>A new document <strong>${file}</strong> has been added to your project <strong>${project.name}</strong>.</p>${link}`,
      );
    } else {
      // Customer uploaded -> notify the team.
      const adminEmail = Deno.env.get("ADMIN_NOTIFY_EMAIL") || "kkim@hydrowates.com";
      const who = uploader?.full_name || uploader?.email || "A customer";
      await sendEmail(
        [adminEmail],
        `Customer uploaded a file to ${project.name}`,
        `<p><strong>${who}</strong> uploaded <strong>${file}</strong> to <strong>${project.name}</strong>.</p>${link}`,
      );
    }

    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
