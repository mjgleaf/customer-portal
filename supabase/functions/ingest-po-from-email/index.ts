// Supabase Edge Function: ingest-po-from-email
//
// Receives forwarded PO emails via Microsoft Power Automate. The intended
// flow:
//
//   1. Customer emails a PO to a Hydro-Wates project manager.
//   2. PM forwards the email (and its attachments) to automation@hydrowates.com.
//      No trigger word required — the AI classifier figures it out.
//   3. Power Automate watches that inbox. For every new message with
//      attachments it POSTs here with subject, body, sender, and attachments.
//   4. For each attachment we ask Claude Haiku 4.5 vision: "is this a PO?".
//      Only attachments classified as POs get stored.
//   5. The HWI project code is taken (in this order): from the document
//      itself (Claude extracts it), or the email subject, or the email body.
//      If none is found anywhere, we bounce back to the PM asking for it.
//   6. Each PO file is stored as kind='purchase_order' and the existing
//      upload-po-to-sharepoint mirror is triggered in the background.
//   7. We return a structured result so Power Automate can email the PM
//      back with either a success confirmation or a clear failure reason.
//
// Auth: a shared secret (env PO_INGEST_TOKEN) passed in the X-Ingest-Token
// header. Power Automate stores the same value in its HTTP connector.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-ingest-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Opus 4.7 with adaptive thinking. Picked over Haiku 4.5 because Haiku had
// OCR slips on dense PO numbers (e.g. reading "BVCI21019005" as
// "BVCI2I019005"). Still cheap at our volume — ~$0.10-0.30 per PO at 20/mo.
const CLASSIFIER_MODEL = "claude-opus-4-7";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Extract the first HWI-NN-NNN sequence from a chunk of text. Case
// insensitive, tolerates noise like "PO for HWI-26-254 attached".
function extractHwiCode(text: string): string | null {
  if (!text) return null;
  const m = text.match(/HWI-\d{2}-\d+/i);
  return m ? m[0].toUpperCase() : null;
}

// Heuristic: which attachments are even worth classifying? Skip inline
// signature images (logos, etc.) up front so we don't waste a Claude
// call on every email signature graphic.
function isClassifiable(filename: string, contentType?: string): boolean {
  const lower = (filename || "").toLowerCase();
  const ct = (contentType || "").toLowerCase();
  // PDFs always.
  if (ct === "application/pdf" || lower.endsWith(".pdf")) return true;
  // Larger images may be scanned POs; tiny signature images get filtered
  // by Claude itself if they sneak through.
  if (ct.startsWith("image/") && !lower.match(/signature|logo|icon/)) return true;
  return false;
}

// Strip path components from a filename and replace anything not safe for
// Supabase Storage keys.
function safeFilename(name: string): string {
  const bare = name.split(/[\\\/]/).pop() || "po.pdf";
  return bare.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// What Claude returns about each attachment. We keep it tight so the
// classifier doesn't waste tokens guessing fields we don't need.
interface ClassifierVerdict {
  is_po: boolean;
  document_type: string; // "purchase_order" | "invoice" | "quote" | "certificate" | "other"
  po_number: string | null;
  customer_name: string | null;
  total_amount: string | null;
  hwi_code: string | null; // HWI-NN-NNN if visible on the document
  reasoning: string;
}

// Ask Claude Haiku 4.5 vision to classify one attachment. Returns null if
// the API call fails — caller treats that as "couldn't classify, skip".
async function classifyAttachment(
  apiKey: string,
  filename: string,
  contentBase64: string,
  contentType: string,
): Promise<ClassifierVerdict | null> {
  const isImage = contentType.startsWith("image/");
  const isPdf = contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

  const sourceBlock = isPdf
    ? {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: contentBase64,
        },
      }
    : isImage
    ? {
        type: "image",
        source: {
          type: "base64",
          media_type: contentType,
          data: contentBase64,
        },
      }
    : null;

  if (!sourceBlock) return null;

  const prompt = `You are reviewing one attachment from a forwarded business email.

CONTEXT — read this carefully before classifying:
- Hydro-Wates is a service vendor that provides proof-load testing services to industrial customers (maritime, petroleum, heavy construction).
- Customers PURCHASE services from Hydro-Wates by issuing a Purchase Order TO Hydro-Wates.
- Hydro-Wates project codes look like "HWI-26-254" (HWI dash two digits dash a number).

WHAT COUNTS AS A PURCHASE ORDER (is_po = true):
- A document issued BY a customer (or end-buyer) TO Hydro-Wates (or to Hydro-Wates' subsidiary "Scofield Group, LLC")
- The customer's letterhead is on the document, NOT Hydro-Wates' letterhead
- The document authorizes purchase of equipment or services
- Has a PO number, line items, total amount, "Purchase Order" or "PO" in the title or header
- Direction is: CUSTOMER → HYDRO-WATES

WHAT IS NOT A PURCHASE ORDER (is_po = false):
- A Quote / Quotation / Proposal issued BY Hydro-Wates TO a customer (Hydro-Wates' letterhead at the top)
- An Invoice issued BY Hydro-Wates TO a customer
- A Certificate of testing/calibration issued BY Hydro-Wates
- An engineering Drawing
- Email body text with no formal PO document attached

The key test: who is the BUYER on this document?
- If the buyer is Hydro-Wates' customer (and Hydro-Wates is the vendor receiving the order) → is_po = true
- If the buyer is one of Hydro-Wates' suppliers, or the document doesn't have a buyer-seller structure → is_po = false

Reply with ONLY a JSON object in this exact shape (no markdown, no commentary):

{
  "is_po": true | false,
  "document_type": "purchase_order" | "invoice" | "quote" | "certificate" | "drawing" | "other",
  "po_number": "string or null",
  "customer_name": "the customer (buyer) name, or null",
  "total_amount": "string or null",
  "hwi_code": "HWI-NN-NNN or null",
  "reasoning": "one short sentence"
}

For hwi_code: only set it if you can clearly read "HWI-" followed by digits on the document itself. Don't guess.`;

  try {
    const resp = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        // Bumped from 400 to 4000 because adaptive thinking blocks count
        // against max_tokens. JSON output is tiny (~200 tokens); the rest
        // is headroom for the model's reasoning.
        max_tokens: 4000,
        // Adaptive thinking lets Opus decide its own reasoning budget.
        // For a classification task like this, it'll usually use very
        // little — but having it available makes edge cases more reliable.
        thinking: { type: "adaptive" },
        messages: [
          {
            role: "user",
            content: [sourceBlock, { type: "text", text: prompt }],
          },
        ],
      }),
    });
    if (!resp.ok) {
      console.warn(`Classifier API error for ${filename}: ${resp.status} ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    // Find the text block in the response. With adaptive thinking, the first
    // content block may be a `thinking` block, so grab the first `text` one.
    const contentBlocks = (data?.content ?? []) as Array<{ type: string; text?: string }>;
    const textBlock = contentBlocks.find((b) => b.type === "text");
    const text = (textBlock?.text ?? "") as string;
    // Pull the first JSON object out of the response (tolerates surrounding text).
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      console.warn(`Classifier didn't return JSON for ${filename}: ${text.slice(0, 200)}`);
      return null;
    }
    return JSON.parse(match[0]) as ClassifierVerdict;
  } catch (e) {
    console.warn(`Classifier threw for ${filename}:`, e);
    return null;
  }
}

// Decode a base64 string (with or without data:URL prefix) to bytes.
function decodeBase64(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^;]+;base64,/, "").replace(/\s+/g, "");
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Shared-secret auth. Power Automate sends the same value we configured in
  // the function's PO_INGEST_TOKEN env var.
  const expectedToken = Deno.env.get("PO_INGEST_TOKEN");
  if (!expectedToken) {
    return json({ ok: false, reason: "server-misconfigured", message: "Ingest function is missing PO_INGEST_TOKEN." }, 500);
  }
  const providedToken = req.headers.get("X-Ingest-Token") ?? "";
  if (providedToken !== expectedToken) {
    return json({ ok: false, reason: "unauthorized", message: "Invalid or missing X-Ingest-Token." }, 401);
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return json({ ok: false, reason: "server-misconfigured", message: "Ingest function is missing ANTHROPIC_API_KEY." }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  let payload: {
    subject?: string;
    body?: string;
    fromEmail?: string;
    fromName?: string;
    attachments?: Array<{ filename?: string; contentBase64?: string; contentType?: string }>;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, reason: "bad-json", message: "Request body is not valid JSON." }, 400);
  }

  const subject = String(payload.subject ?? "");
  const body = String(payload.body ?? "");
  const fromEmail = String(payload.fromEmail ?? "").trim();
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];

  if (attachments.length === 0) {
    return json({
      ok: false,
      reason: "no-attachments",
      message: "The forwarded email had no attachments. Please attach the PO and forward again.",
    }, 200);
  }

  // (1) Classify every attachment that's worth a Claude call.
  type Classified = {
    filename: string;
    contentBase64: string;
    contentType: string;
    verdict: ClassifierVerdict;
  };
  const classified: Classified[] = [];
  const skippedNonPo: Array<{ filename: string; document_type: string; reasoning: string }> = [];

  for (const att of attachments) {
    const filename = att.filename || "attachment";
    if (!att.contentBase64) continue;
    if (!isClassifiable(filename, att.contentType)) continue;

    const verdict = await classifyAttachment(
      apiKey,
      filename,
      att.contentBase64,
      att.contentType ?? "application/pdf",
    );
    if (!verdict) continue;

    if (verdict.is_po) {
      classified.push({
        filename,
        contentBase64: att.contentBase64,
        contentType: att.contentType ?? "application/pdf",
        verdict,
      });
    } else {
      skippedNonPo.push({
        filename,
        document_type: verdict.document_type,
        reasoning: verdict.reasoning,
      });
    }
  }

  if (classified.length === 0) {
    // Nothing in the email looked like a PO. Tell the PM what we DID see so
    // they can decide whether to re-forward with a different attachment.
    const seenSummary = skippedNonPo.length === 0
      ? "I couldn't identify any of the attachments as Purchase Orders."
      : "I reviewed the attachments but none looked like a Purchase Order. Here's what I saw: " +
        skippedNonPo.map((s) => `${s.filename} (${s.document_type})`).join("; ");
    return json({
      ok: false,
      reason: "no-po-found",
      classified: skippedNonPo,
      message: `${seenSummary} If a PO was attached, please re-forward and the system will try again.`,
    }, 200);
  }

  // (2) Decide which HWI code to use. Prefer the code printed on the
  // document itself; fall back to subject; fall back to body.
  const codeFromDoc = classified.map((c) => c.verdict.hwi_code).find((c) => c) ?? null;
  const codeFromSubject = extractHwiCode(subject);
  const codeFromBody = extractHwiCode(body);
  const hwiCode = (extractHwiCode(codeFromDoc ?? "")) // normalize doc code through the same regex (handles odd formats)
    ?? codeFromSubject
    ?? codeFromBody;

  if (!hwiCode) {
    const poNumbers = classified.map((c) => c.verdict.po_number).filter(Boolean).join(", ");
    return json({
      ok: false,
      reason: "no-hwi-code",
      classified: classified.map((c) => ({ filename: c.filename, verdict: c.verdict })),
      message: `I recognized ${classified.length} Purchase Order file${classified.length === 1 ? "" : "s"}${poNumbers ? ` (PO ${poNumbers})` : ""} but couldn't find the HWI project code anywhere — not on the PO, not in the subject, not in the body. Please reply with the HWI code (e.g. HWI-26-254) or re-forward with it added.`,
    }, 200);
  }

  // (3) Look up the project by HWI code prefix.
  const { data: projects } = await admin
    .from("cportal_projects")
    .select("id, name, customer:cportal_customers(company, name)")
    .ilike("name", `${hwiCode}%`)
    .limit(1);
  const project = projects?.[0];
  if (!project) {
    return json({
      ok: false,
      reason: "project-not-found",
      hwiCode,
      classified: classified.map((c) => ({ filename: c.filename, verdict: c.verdict })),
      message: `No project starting with "${hwiCode}" found in the portal. Create the project first, then re-forward this email.`,
    }, 200);
  }

  // (4) Upload each PO attachment. Mark with kind='purchase_order' and
  // synchronously mirror to SharePoint so the confirmation email accurately
  // reflects what happened.
  type UploadOutcome = {
    name: string;
    fileId: string;
    po_number: string | null;
    sharepoint: "mirrored" | "emailed-to-sales" | "failed";
    sharepoint_path: string | null;
    sharepoint_note: string | null;
  };
  const uploaded: UploadOutcome[] = [];
  const failures: Array<{ name: string; error: string }> = [];

  for (const c of classified) {
    try {
      const bytes = decodeBase64(c.contentBase64);
      const safeName = safeFilename(c.filename);
      const storagePath = `${project.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;

      const { error: upErr } = await admin.storage
        .from("cportal-project-files")
        .upload(storagePath, bytes, {
          contentType: c.contentType,
          upsert: false,
        });
      if (upErr) {
        failures.push({ name: c.filename, error: `storage upload failed: ${upErr.message}` });
        continue;
      }

      const { data: insertedFile, error: insErr } = await admin
        .from("cportal_files")
        .insert({
          project_id: project.id,
          name: c.filename,
          storage_path: storagePath,
          size: bytes.length,
          mime_type: c.contentType,
          kind: "purchase_order",
        })
        .select("id")
        .single();
      if (insErr || !insertedFile) {
        await admin.storage.from("cportal-project-files").remove([storagePath]);
        failures.push({ name: c.filename, error: `files insert failed: ${insErr?.message}` });
        continue;
      }

      // Synchronously call the SharePoint mirror. We use direct fetch (not
      // admin.functions.invoke) because invoke() doesn't reliably pass the
      // service-role token in the Authorization header that the mirror
      // function checks. Edge functions also kill detached promises on
      // return, so this has to await. Stays well under Power Automate's
      // 120-sec HTTP timeout.
      let spOutcome: UploadOutcome["sharepoint"] = "failed";
      let spPath: string | null = null;
      let spNote: string | null = null;
      try {
        const mirrorResp = await fetch(`${supabaseUrl}/functions/v1/upload-po-to-sharepoint`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${serviceKey}`,
            "apikey": serviceKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fileId: insertedFile.id }),
        });
        if (!mirrorResp.ok) {
          const errText = await mirrorResp.text();
          spNote = `mirror returned ${mirrorResp.status}: ${errText.slice(0, 200)}`;
        } else {
          // The mirror function updates files.sharepoint_path itself; re-read
          // to find out which path it took (real folder vs emailed-to-sales).
          const { data: refetched } = await admin
            .from("cportal_files")
            .select("sharepoint_path, sharepoint_error")
            .eq("id", insertedFile.id)
            .single();
          if (refetched?.sharepoint_path === "emailed-to-sales") {
            spOutcome = "emailed-to-sales";
            spPath = null;
            spNote = "No SharePoint folder yet for this project — PO was emailed to sales@hydrowates.com for manual filing.";
          } else if (refetched?.sharepoint_path) {
            spOutcome = "mirrored";
            spPath = refetched.sharepoint_path;
          } else if (refetched?.sharepoint_error) {
            spNote = refetched.sharepoint_error;
          } else {
            // Mirror returned 2xx but didn't update the row — treat as success
            // since the function's own JSON said ok.
            spOutcome = "mirrored";
            const mirrorJson = await mirrorResp.clone().json().catch(() => null);
            if (mirrorJson?.path) spPath = mirrorJson.path;
          }
        }
      } catch (e) {
        spNote = `mirror call threw: ${String((e as Error)?.message ?? e)}`;
      }

      uploaded.push({
        name: c.filename,
        fileId: insertedFile.id,
        po_number: c.verdict.po_number,
        sharepoint: spOutcome,
        sharepoint_path: spPath,
        sharepoint_note: spNote,
      });
    } catch (e) {
      failures.push({ name: c.filename, error: String((e as Error)?.message ?? e) });
    }
  }

  if (uploaded.length === 0) {
    return json({
      ok: false,
      reason: "all-uploads-failed",
      hwiCode,
      projectName: project.name,
      failures,
      message: `Found project ${hwiCode} and identified ${classified.length} PO file${classified.length === 1 ? "" : "s"}, but couldn't store any of them. See failures.`,
    }, 200);
  }

  // (5) Success — return enough info for Power Automate to write a nice
  // confirmation email back to the PM.
  const customerCompany = (project.customer as { company?: string; name?: string } | null)?.company
    || (project.customer as { company?: string; name?: string } | null)?.name
    || null;
  const poNumberList = uploaded.map((u) => u.po_number).filter(Boolean).join(", ");
  const skippedNote = skippedNonPo.length > 0
    ? ` I also saw ${skippedNonPo.length} non-PO attachment${skippedNonPo.length === 1 ? "" : "s"} (${skippedNonPo.map((s) => s.document_type).join(", ")}) which I didn't file.`
    : "";

  // Compose an accurate SharePoint status sentence from the per-file outcomes.
  const mirrored = uploaded.filter((u) => u.sharepoint === "mirrored").length;
  const emailedToSales = uploaded.filter((u) => u.sharepoint === "emailed-to-sales").length;
  const spFailed = uploaded.filter((u) => u.sharepoint === "failed").length;
  let sharepointSentence = "";
  if (mirrored === uploaded.length) {
    sharepointSentence = " Also copied to SharePoint.";
  } else if (emailedToSales > 0 && mirrored + spFailed === 0) {
    sharepointSentence = " No SharePoint folder yet for this project — the PO was emailed to sales@hydrowates.com for manual filing.";
  } else {
    const parts: string[] = [];
    if (mirrored > 0) parts.push(`${mirrored} copied to SharePoint`);
    if (emailedToSales > 0) parts.push(`${emailedToSales} emailed to sales@ for manual filing`);
    if (spFailed > 0) parts.push(`${spFailed} couldn't be mirrored (the file is still in the portal — please drop it into the SharePoint folder manually)`);
    sharepointSentence = " SharePoint status: " + parts.join("; ") + ".";
  }

  return json({
    ok: true,
    hwiCode,
    projectName: project.name,
    customer: customerCompany,
    uploaded,
    skippedNonPo,
    failures: failures.length ? failures : undefined,
    fromEmail,
    message: `Uploaded ${uploaded.length} PO file${uploaded.length === 1 ? "" : "s"}${poNumberList ? ` (PO ${poNumberList})` : ""} to project ${hwiCode}${customerCompany ? ` (${customerCompany})` : ""}.${sharepointSentence}${skippedNote}`,
  }, 200);
});
