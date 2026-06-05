// Supabase Edge Function: review-po
// Admin clicks "Analyze with AI" on a Purchase Order file row. We:
//   1. Authenticate the caller (must be admin)
//   2. Look up the file + verify it's a PO (kind='purchase_order')
//   3. Generate a short-lived signed URL for the file in Supabase Storage
//   4. Pass that URL to the Anthropic Messages API (Claude reads the PDF
//      natively via vision)
//   5. Parse Claude's structured JSON response
//   6. Upsert the result into public.po_reviews
//   7. Return the review for the UI to show inline
//
// Costs ~few cents per analysis. Requires ANTHROPIC_API_KEY secret.

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

const MODEL = "claude-opus-4-7";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

// Domain-specific prompt — Hydro-Wates is a proof-load / industrial-equipment
// testing company, so the AI is told what kind of PO to expect and what's
// worth flagging from that domain's perspective.
const REVIEW_PROMPT = `You are reviewing a Purchase Order (PO) document on behalf of Hydro-Wates, a proof-load testing and industrial-equipment services company that performs load testing on cranes, hoists, slings, lifting equipment, and similar gear.

Your job is to help the Hydro-Wates sales/operations team quickly understand and accept (or push back on) this PO. Specifically:

1. Provide a brief summary (1-2 sentences) of what the customer is asking Hydro-Wates to do.
2. Identify any concerns, ambiguities, or missing details that someone at Hydro-Wates should clarify with the customer before accepting the PO.
3. Extract key fields when present.

Common concerns to watch for:
- Missing or unclear PO number
- Missing customer/billing/shipping address
- Past-due or missing issue/effective dates
- Vague equipment description (no capacity, type, manufacturer, or quantity)
- Missing site or job-location address
- Document appears unsigned or unauthorized
- Total amount unclear, missing, or wildly inconsistent with the line items
- Scope of work doesn't match typical Hydro-Wates services (proof-load testing, equipment rental, equipment purchase, or consultative load advice)
- Unusual payment terms or delivery requirements

Respond with JSON ONLY (no markdown code fences, no surrounding prose), with exactly this structure:

{
  "summary": "Brief 1-2 sentence summary of what the customer is requesting",
  "concerns": ["concern 1", "concern 2"],
  "extracted": {
    "po_number": null,
    "customer": null,
    "total_amount": null,
    "issue_date": null,
    "due_date": null,
    "equipment": null,
    "site_location": null
  }
}

For any field not clearly present in the PO, use null. If there are no concerns, return an empty array for "concerns".`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Caller must be an admin.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not authorized" }, 401);
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "Not authorized" }, 401);
  const { data: caller } = await admin.from("profiles").select("role").eq("id", user.id).single();
  if (caller?.role !== "admin") return json({ error: "Admin only" }, 403);

  try {
    const { fileId } = await req.json();
    if (!fileId) return json({ error: "fileId is required" }, 400);

    // Look up the file
    const { data: file } = await admin
      .from("files")
      .select("id, project_id, name, kind, storage_path")
      .eq("id", fileId)
      .single();
    if (!file) return json({ error: "File not found" }, 404);
    if (file.kind !== "purchase_order") {
      return json({ error: "Only Purchase Order files can be reviewed" }, 400);
    }

    // Anthropic API key must be present.
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return json({
        error: "ANTHROPIC_API_KEY secret is not set. Add it in Supabase Dashboard → Edge Functions → Manage secrets.",
      }, 500);
    }

    // Generate a signed URL Claude can fetch. 5 minutes is well beyond a
    // typical API call duration but expires before any meaningful exposure.
    const { data: urlData, error: urlErr } = await admin.storage
      .from("project-files")
      .createSignedUrl(file.storage_path, 300);
    if (urlErr || !urlData?.signedUrl) {
      return json({ error: `Could not generate signed URL: ${urlErr?.message ?? "unknown"}` }, 500);
    }

    // Call the Anthropic Messages API. Claude reads the PDF natively via the
    // url-source document block — no separate base64 step needed. Adaptive
    // thinking lets the model decide its own reasoning budget.
    const anthResp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "url",
                  url: urlData.signedUrl,
                },
              },
              {
                type: "text",
                text: REVIEW_PROMPT,
              },
            ],
          },
        ],
      }),
    });

    if (!anthResp.ok) {
      const errText = await anthResp.text();
      console.error("Anthropic API error:", anthResp.status, errText);
      return json({ error: `Anthropic API error (${anthResp.status}): ${errText}` }, 500);
    }

    const anthData = await anthResp.json();

    // Find the text content block — adaptive thinking puts the actual answer
    // after any thinking blocks. We want the first non-thinking content with text.
    const textBlock = (anthData.content ?? []).find(
      (b: { type: string; text?: string }) => b.type === "text" && b.text,
    );
    if (!textBlock?.text) {
      return json({ error: "Empty response from Claude", raw: anthData }, 500);
    }

    // Parse the JSON. Strip any accidental markdown code fences just in case.
    let parsed: { summary?: string; concerns?: string[]; extracted?: Record<string, unknown> };
    try {
      const cleaned = textBlock.text
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/\s*```\s*$/i, "")
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON parse failed:", e, "raw:", textBlock.text);
      return json({
        error: "Could not parse Claude's response as JSON",
        raw_response: textBlock.text,
      }, 500);
    }

    // Upsert the review (one row per file_id; re-analyze overwrites).
    const { data: review, error: upsertErr } = await admin
      .from("po_reviews")
      .upsert(
        {
          file_id: fileId,
          summary: parsed.summary ?? null,
          concerns: Array.isArray(parsed.concerns) ? parsed.concerns : [],
          extracted_fields: parsed.extracted ?? {},
          model: MODEL,
          reviewed_at: new Date().toISOString(),
          reviewed_by: user.id,
        },
        { onConflict: "file_id" },
      )
      .select()
      .single();

    if (upsertErr) {
      console.error("Upsert failed:", upsertErr);
      return json({ error: `Failed to save review: ${upsertErr.message}` }, 500);
    }

    return json({ ok: true, review });
  } catch (e) {
    console.error("review-po failed:", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
