// Supabase Edge Function: invite-customer
// Sends a portal invitation email to a synced Zoho customer. Admin-only.
// On accepting, the customer sets a password and (because their email matches
// their Zoho contact) automatically sees their own projects and invoices.

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Authorize: caller must be an admin user.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  let allowed = false;
  if (token && token !== serviceKey) {
    const { data: { user } } = await admin.auth.getUser(token);
    if (user) {
      const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).single();
      if (profile?.role === "admin") allowed = true;
    }
  }
  if (!allowed) return json({ error: "Not authorized" }, 403);

  try {
    const { email, name, redirectTo } = await req.json();
    if (!email) return json({ error: "Email is required" }, 400);

    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: name ?? null },
      redirectTo: redirectTo || undefined,
    });
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true, user_id: data.user?.id ?? null });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
