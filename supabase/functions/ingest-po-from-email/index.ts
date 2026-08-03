// Supabase Edge Function: ingest-po-from-email
//
// Receives forwarded PO / drawing emails via Microsoft Power Automate. The
// intended flow:
//
//   1. Customer emails a PO and/or engineering drawings to a Hydro-Wates
//      (or Sentinel Instruments) project manager.
//   2. PM forwards the email (and its attachments) to automation@hydrowates.com.
//   3. Power Automate watches that inbox. For every new message with
//      attachments it POSTs here with subject, body, sender, and attachments.
//   4. Zip attachments are extracted in-function — some customers send POs
//      zipped — and each entry joins the attachment list like it had been
//      attached directly. (One level deep; a zip inside a zip is skipped.)
//   5. Each attachment is classified by Claude vision as a PO, a drawing, a
//      photo, or something else. POs, drawings, and photos get stored; the
//      rest are skipped. Native CAD files (.dwg/.dxf/.step/...) are treated
//      as drawings without a classifier call — the extension is unambiguous.
//      Likewise camera formats the vision API can't read (.heic/.tiff/...)
//      are filed as photos by extension.
//   6. The job code — HWI-NN-NNN for Hydro-Wates projects, QYYNNN (e.g.
//      Q26001) for Sentinel Instruments jobs — is taken (in this order):
//      from a document itself (Claude extracts it), or the email subject,
//      or the email body. If none is found, we bounce back asking for it.
//   7. Each PO file is stored as kind='purchase_order' and mirrored to
//      SharePoint via upload-po-to-sharepoint (which files Hydro-Wates and
//      Sentinel jobs into their respective Commercial Proposals trees).
//      Drawings are stored as kind='drawing' (portal Drawings tab) and
//      photos as kind='photo' (portal Photos tab) — no SharePoint mirror,
//      which is PO-specific.
//   8. We return a structured result so Power Automate can email the PM
//      back with either a success confirmation or a clear failure reason.
//
// Auth: a shared secret (env PO_INGEST_TOKEN) passed in the X-Ingest-Token
// header. Power Automate stores the same value in its HTTP connector.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unzipSync } from "https://esm.sh/fflate@0.8.2";

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

// Extract the first job code from a chunk of text: HWI-NN-NNN for
// Hydro-Wates projects, or QYYNNN (e.g. Q26001) for Sentinel Instruments
// jobs. Case insensitive, tolerates noise like "PO for HWI-26-254 attached".
// HWI wins if both appear — Q\d{5} is the looser pattern.
function extractJobCode(text: string): string | null {
  if (!text) return null;
  const hwi = text.match(/HWI-\d{2}-\d+/i);
  if (hwi) return hwi[0].toUpperCase();
  const q = text.match(/\bQ\d{5}\b/i);
  return q ? q[0].toUpperCase() : null;
}

// Heuristic: which attachments are even worth classifying? Skip inline
// signature images (logos, etc.) up front so we don't waste a Claude
// call on every email signature graphic.
function isClassifiable(filename: string, contentType?: string): boolean {
  const lower = (filename || "").toLowerCase();
  const ct = (contentType || "").toLowerCase();
  // PDFs always.
  if (ct === "application/pdf" || lower.endsWith(".pdf")) return true;
  // Images by contentType OR extension — Outlook reports many forwarded
  // image attachments as application/octet-stream, so the declared type
  // alone can't be trusted. Larger images may be scanned POs; tiny
  // signature images get filtered by Claude itself if they sneak through.
  const looksLikeImage = ct.startsWith("image/") || /\.(jpe?g|png|gif|webp)$/i.test(lower);
  if (looksLikeImage && !lower.match(/signature|logo|icon/)) return true;
  return false;
}

// The vision API accepts exactly these image media types. Derive a valid
// one from the declared contentType or, failing that, the filename
// extension. Returns null if neither yields a type the API can ingest.
const VALID_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
function imageMediaTypeFor(filename: string, contentType?: string): string | null {
  const ct = (contentType || "").toLowerCase();
  if (ct === "image/jpg") return "image/jpeg"; // nonstandard but common
  if (VALID_IMAGE_MEDIA_TYPES.has(ct)) return ct;
  const byName = contentTypeFromName(filename);
  return VALID_IMAGE_MEDIA_TYPES.has(byName) ? byName : null;
}

// Native CAD formats the vision classifier can't read, but whose extension
// alone tells us the file is a drawing.
function isCadFile(filename: string): boolean {
  return /\.(dwg|dxf|step|stp|iges|igs)$/i.test(filename || "");
}

// Camera/image formats the vision API can't ingest (it accepts JPEG, PNG,
// GIF, and WebP only). On a project email these are near-certainly job-site
// photos — iPhones attach .heic by default — so file them as photos by
// extension or declared type, same pattern as CAD files above.
function isPhotoOnlyFormat(filename: string, contentType?: string): boolean {
  const ct = (contentType || "").toLowerCase();
  return /\.(heic|heif|tif|tiff|bmp)$/i.test(filename || "") ||
    /^image\/(heic|heif|tiff?|bmp)$/.test(ct);
}

// Zip archives get extracted in-function — several customers' purchasing
// systems email POs as zips.
function isZipFile(filename: string, contentType?: string): boolean {
  const ct = (contentType || "").toLowerCase();
  return /\.zip$/i.test(filename || "") ||
    ct === "application/zip" ||
    ct === "application/x-zip-compressed";
}

// Guess a MIME type from a filename extension. Used for zip entries (which
// carry no contentType) and to repair attachments whose declared type is
// missing or a generic application/octet-stream.
function contentTypeFromName(name: string): string {
  const lower = (name || "").toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".heic")) return "image/heic";
  if (lower.endsWith(".heif")) return "image/heif";
  if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
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
  document_type: string; // "purchase_order" | "invoice" | "quote" | "certificate" | "drawing" | "photo" | "other"
  po_number: string | null;
  customer_name: string | null;
  total_amount: string | null;
  job_code: string | null; // HWI-NN-NNN or QYYNNN if visible on the document
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
  const isPdf = contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
  // Normalize to a media type the vision API accepts — the declared
  // contentType is often application/octet-stream or image/jpg.
  const imageMediaType = isPdf ? null : imageMediaTypeFor(filename, contentType);

  const sourceBlock = isPdf
    ? {
        type: "document",
        source: {
          type: "base64",
          media_type: "application/pdf",
          data: contentBase64,
        },
      }
    : imageMediaType
    ? {
        type: "image",
        source: {
          type: "base64",
          media_type: imageMediaType,
          data: contentBase64,
        },
      }
    : null;

  if (!sourceBlock) return null;

  const prompt = `You are reviewing one attachment from a forwarded business email.

CONTEXT — read this carefully before classifying:
- Hydro-Wates is a service vendor that provides proof-load testing services to industrial customers (maritime, petroleum, heavy construction).
- Sentinel Instruments is Hydro-Wates' sister company: it sells and recalibrates torque/tension instruments (RTC-800 / RT-800 units and accessories) to the same kind of customers.
- Customers PURCHASE services or equipment by issuing a Purchase Order TO Hydro-Wates or TO Sentinel Instruments.
- Hydro-Wates project codes look like "HWI-26-254" (HWI dash two digits dash a number).
- Sentinel Instruments job codes look like "Q26001" (Q, two-digit year, three-digit sequence).

WHAT COUNTS AS A PURCHASE ORDER (is_po = true):
- A document issued BY a customer (or end-buyer) TO Hydro-Wates, TO its subsidiary "Scofield Group, LLC", or TO its sister company "Sentinel Instruments"
- The customer's letterhead is on the document, NOT Hydro-Wates' or Sentinel Instruments' letterhead
- The document authorizes purchase of equipment or services
- Has a PO number, line items, total amount, "Purchase Order" or "PO" in the title or header
- Direction is: CUSTOMER → HYDRO-WATES (or CUSTOMER → SENTINEL INSTRUMENTS)

WHAT IS NOT A PURCHASE ORDER (is_po = false):
- A Quote / Quotation / Proposal issued BY Hydro-Wates or Sentinel Instruments TO a customer (their letterhead at the top)
- An Invoice issued BY Hydro-Wates or Sentinel Instruments TO a customer
- A Certificate of testing/calibration issued BY Hydro-Wates or Sentinel Instruments
- An engineering Drawing
- Email body text with no formal PO document attached

DRAWINGS (is_po = false, document_type = "drawing"):
- An engineering or technical drawing: general arrangement, rigging/test setup, structural detail, or any CAD-produced sheet with a title block
- Drawings often show the job code (HWI-NN-NNN or QYYNNN) or a project name in the title block — extract the job code if clearly readable

PHOTOS (is_po = false, document_type = "photo"):
- A photograph (camera image) of equipment, rigging, a job site, a test setup, damaged or worn parts, nameplates/data plates, or anything else physical
- The test vs drawings: a photo is captured by a camera; a drawing is a produced technical sheet. A photo OF a drawing (e.g. a snapshot of a printed sheet) counts as a drawing if the sheet fills the frame and is legible, otherwise a photo
- If the image shows physical equipment, rigging, a vessel, a work site, or anything else in the physical world, it IS a photo — even when blurry, dark, partial, or hard to identify. When torn between "photo" and "other" for a camera image, choose "photo"
- Company logos, email-signature graphics, and marketing banners are NOT photos — classify those as "other"

The key test: who is the BUYER on this document?
- If the buyer is a customer (and Hydro-Wates or Sentinel Instruments is the vendor receiving the order) → is_po = true
- If the buyer is one of Hydro-Wates' suppliers, or the document doesn't have a buyer-seller structure → is_po = false

Reply with ONLY a JSON object in this exact shape (no markdown, no commentary):

{
  "is_po": true | false,
  "document_type": "purchase_order" | "invoice" | "quote" | "certificate" | "drawing" | "photo" | "other",
  "po_number": "string or null",
  "customer_name": "the customer (buyer) name, or null",
  "total_amount": "string or null",
  "job_code": "HWI-NN-NNN or QYYNNN or null",
  "reasoning": "one short sentence"
}

For job_code: only set it if you can clearly read "HWI-" followed by digits, or a Q followed by five digits (e.g. Q26001), on the document itself. Don't guess.`;

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

// Base64-encode a Uint8Array without blowing the call stack on larger files.
// Zip entries get re-encoded so they can flow through the same pipeline as
// the base64 attachments Power Automate sends.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
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
  const poFiles: Classified[] = [];
  const drawingFiles: Classified[] = [];
  const photoFiles: Classified[] = [];
  const skippedNonPo: Array<{ filename: string; document_type: string; reasoning: string }> = [];

  // (1a) Expand zip attachments into their entries so a zipped PO flows
  // through the same classify/file pipeline as a direct attachment. One
  // level deep only — a zip inside a zip is skipped with a note.
  type Incoming = { filename: string; contentBase64: string; contentType?: string };
  const expandedAttachments: Incoming[] = [];
  for (const att of attachments) {
    const filename = att.filename || "attachment";
    if (!att.contentBase64) {
      skippedNonPo.push({
        filename,
        document_type: "no-content",
        reasoning: "Attachment arrived without file content in the payload",
      });
      continue;
    }
    if (!isZipFile(filename, att.contentType)) {
      expandedAttachments.push({ filename, contentBase64: att.contentBase64, contentType: att.contentType });
      continue;
    }
    try {
      const entries = unzipSync(decodeBase64(att.contentBase64));
      let extracted = 0;
      for (const [entryPath, entryBytes] of Object.entries(entries)) {
        if (entryPath.endsWith("/")) continue; // directory marker
        const bare = entryPath.split("/").pop() ?? "";
        // Skip macOS resource-fork junk and hidden files zips often carry.
        if (!bare || bare.startsWith(".") || entryPath.startsWith("__MACOSX/")) continue;
        if (entryBytes.length === 0) continue;
        if (isZipFile(bare)) {
          skippedNonPo.push({
            filename: `${filename} → ${bare}`,
            document_type: "nested-zip",
            reasoning: "Zip inside a zip — not extracted; attach the inner files directly",
          });
          continue;
        }
        expandedAttachments.push({
          filename: bare,
          contentBase64: bytesToBase64(entryBytes),
          contentType: contentTypeFromName(bare),
        });
        extracted++;
      }
      if (extracted === 0) {
        skippedNonPo.push({
          filename,
          document_type: "zip",
          reasoning: "Zip contained no usable files",
        });
      }
    } catch (e) {
      skippedNonPo.push({
        filename,
        document_type: "unreadable-zip",
        reasoning: `Could not extract the zip: ${String((e as Error)?.message ?? e).slice(0, 120)}`,
      });
    }
  }

  // One inventory line per email so silent drops are diagnosable from logs.
  console.log(
    "attachment inventory: " +
      (expandedAttachments
        .map((a) => `${a.filename} (${a.contentType || "no type"}, ~${Math.round((a.contentBase64.length * 3) / 4 / 1024)} KB)`)
        .join("; ") || "none"),
  );

  for (const att of expandedAttachments) {
    const filename = att.filename;

    // Native CAD files skip the vision classifier — the extension is proof
    // enough that it's a drawing (and Claude can't read the format anyway).
    if (isCadFile(filename)) {
      drawingFiles.push({
        filename,
        contentBase64: att.contentBase64,
        contentType: att.contentType ?? "application/octet-stream",
        verdict: {
          is_po: false,
          document_type: "drawing",
          po_number: null,
          customer_name: null,
          total_amount: null,
          job_code: null,
          reasoning: "Native CAD file extension",
        },
      });
      continue;
    }

    // Camera formats the vision API can't read (.heic etc.) are filed as
    // photos by extension — must run BEFORE the classifier, whose API call
    // would just fail on these media types.
    if (isPhotoOnlyFormat(filename, att.contentType)) {
      photoFiles.push({
        filename,
        contentBase64: att.contentBase64,
        contentType: att.contentType ?? "application/octet-stream",
        verdict: {
          is_po: false,
          document_type: "photo",
          po_number: null,
          customer_name: null,
          total_amount: null,
          job_code: null,
          reasoning: "Camera image format the classifier can't read",
        },
      });
      continue;
    }

    if (!isClassifiable(filename, att.contentType)) {
      // Signature graphics are skipped silently on purpose; everything else
      // gets surfaced so the PM's reply email names what wasn't filed.
      if (!/signature|logo|icon/.test(filename.toLowerCase())) {
        skippedNonPo.push({
          filename,
          document_type: "unrecognized",
          reasoning: `File type I can't read (contentType: ${att.contentType || "not provided"})`,
        });
      }
      continue;
    }

    // Best-guess MIME for storing the file: prefer a normalized image type,
    // then the declared type, then the extension.
    const storedType = imageMediaTypeFor(filename, att.contentType) ??
      att.contentType ?? contentTypeFromName(filename);
    const approxBytes = Math.round((att.contentBase64.length * 3) / 4);

    const verdict = await classifyAttachment(
      apiKey,
      filename,
      att.contentBase64,
      att.contentType ?? "application/pdf",
    );
    if (!verdict) {
      // Classifier unavailable or rejected the file (e.g. an image over the
      // vision API's 5 MB / 8000 px limits). A substantial image on a project
      // email is near-certainly a job-site photo — file it rather than drop
      // it. Small failed images are signature-graphic territory; skip those
      // with a note.
      if (imageMediaTypeFor(filename, att.contentType) && approxBytes >= 200_000) {
        photoFiles.push({
          filename,
          contentBase64: att.contentBase64,
          contentType: storedType,
          verdict: {
            is_po: false,
            document_type: "photo",
            po_number: null,
            customer_name: null,
            total_amount: null,
            job_code: null,
            reasoning: "Classifier couldn't read it — filed as photo by size and format",
          },
        });
      } else {
        skippedNonPo.push({
          filename,
          document_type: "unclassified",
          reasoning: "Couldn't classify this file (classifier error)",
        });
      }
      continue;
    }

    // Always log what the classifier decided and why — "other" verdicts are
    // invisible in the reply email beyond their count, so this is the only
    // way to diagnose a misclassification after the fact.
    console.log(
      `verdict: ${filename} → ${verdict.document_type}${verdict.is_po ? " (PO)" : ""} — ${verdict.reasoning}`,
    );

    // A substantial image that Claude labels "other" is far more likely a
    // mislabeled job-site photo than signature junk (which is tiny). File it
    // as a photo; the size floor keeps logos and banners out.
    if (
      !verdict.is_po &&
      verdict.document_type === "other" &&
      imageMediaTypeFor(filename, att.contentType) &&
      approxBytes >= 200_000
    ) {
      console.log(`override: ${filename} reclassified other → photo (${Math.round(approxBytes / 1024)} KB image)`);
      verdict.document_type = "photo";
      verdict.reasoning = `Large image on a project email — filed as photo despite "other" verdict. Original: ${verdict.reasoning}`;
    }

    if (verdict.is_po) {
      poFiles.push({
        filename,
        contentBase64: att.contentBase64,
        contentType: storedType,
        verdict,
      });
    } else if (verdict.document_type === "drawing") {
      drawingFiles.push({
        filename,
        contentBase64: att.contentBase64,
        contentType: storedType,
        verdict,
      });
    } else if (verdict.document_type === "photo") {
      photoFiles.push({
        filename,
        contentBase64: att.contentBase64,
        contentType: storedType,
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

  if (poFiles.length === 0 && drawingFiles.length === 0 && photoFiles.length === 0) {
    // Nothing in the email looked like a PO, drawing, or photo. Tell the PM what
    // we DID see so they can decide whether to re-forward with a different attachment.
    const seenSummary = skippedNonPo.length === 0
      ? "I couldn't identify any of the attachments as Purchase Orders, drawings, or photos."
      : "I reviewed the attachments but none looked like a Purchase Order, drawing, or photo. Here's what I saw: " +
        skippedNonPo.map((s) => `${s.filename} (${s.document_type})`).join("; ");
    return json({
      ok: false,
      reason: "no-po-found",
      classified: skippedNonPo,
      message: `${seenSummary} If a PO, drawing, or photo was attached, please re-forward and the system will try again.`,
    }, 200);
  }

  // (2) Decide which job code to use. Prefer the code printed on a
  // document itself (POs first); fall back to subject; fall back to body.
  const codeFromDoc = [...poFiles, ...drawingFiles, ...photoFiles].map((c) => c.verdict.job_code).find((c) => c) ?? null;
  const codeFromSubject = extractJobCode(subject);
  const codeFromBody = extractJobCode(body);
  const jobCode = (extractJobCode(codeFromDoc ?? "")) // normalize doc code through the same regex (handles odd formats)
    ?? codeFromSubject
    ?? codeFromBody;

  if (!jobCode) {
    const poNumbers = poFiles.map((c) => c.verdict.po_number).filter(Boolean).join(", ");
    const recognized = [
      poFiles.length > 0
        ? `${poFiles.length} Purchase Order file${poFiles.length === 1 ? "" : "s"}${poNumbers ? ` (PO ${poNumbers})` : ""}`
        : null,
      drawingFiles.length > 0
        ? `${drawingFiles.length} drawing${drawingFiles.length === 1 ? "" : "s"}`
        : null,
      photoFiles.length > 0
        ? `${photoFiles.length} photo${photoFiles.length === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean).join(" and ");
    return json({
      ok: false,
      reason: "no-hwi-code",
      classified: [...poFiles, ...drawingFiles, ...photoFiles].map((c) => ({ filename: c.filename, verdict: c.verdict })),
      message: `I recognized ${recognized} but couldn't find the job code anywhere — not on the documents, not in the subject, not in the body. Please reply with the job code (e.g. HWI-26-254, or Q26001 for Sentinel Instruments jobs) or re-forward with it added.`,
    }, 200);
  }

  // (3) Look up the project by job-code prefix. (The response key stays
  // `hwiCode` even for Sentinel Q-codes — Power Automate's Parse JSON
  // schema and email template reference it by that name.)
  const { data: projects } = await admin
    .from("cportal_projects")
    .select("id, name, customer:cportal_customers(company, name)")
    .ilike("name", `${jobCode}%`)
    .limit(1);
  const project = projects?.[0];
  if (!project) {
    return json({
      ok: false,
      reason: "project-not-found",
      hwiCode: jobCode,
      classified: [...poFiles, ...drawingFiles, ...photoFiles].map((c) => ({ filename: c.filename, verdict: c.verdict })),
      message: `No project starting with "${jobCode}" found in the portal. Create the project first, then re-forward this email.`,
    }, 200);
  }

  // (4) Upload each recognized attachment. POs get kind='purchase_order' and
  // a synchronous SharePoint mirror (so the confirmation email accurately
  // reflects what happened). Drawings get kind='drawing' (project Drawings
  // tab) and photos kind='photo' (project Photos tab); the SharePoint mirror
  // is PO-specific so it's skipped for both.
  type UploadOutcome = {
    name: string;
    fileId: string;
    kind: "purchase_order" | "drawing" | "photo";
    po_number: string | null;
    sharepoint: "mirrored" | "emailed-to-sales" | "failed" | "n/a";
    sharepoint_path: string | null;
    sharepoint_note: string | null;
  };
  const uploaded: UploadOutcome[] = [];
  const failures: Array<{ name: string; error: string }> = [];

  const toIngest = [
    ...poFiles.map((c) => ({ ...c, kind: "purchase_order" as const })),
    ...drawingFiles.map((c) => ({ ...c, kind: "drawing" as const })),
    ...photoFiles.map((c) => ({ ...c, kind: "photo" as const })),
  ];

  for (const c of toIngest) {
    try {
      const bytes = decodeBase64(c.contentBase64);

      // Power Automate sometimes fires two runs for the same email a few ms
      // apart, and PMs sometimes re-forward an email after a partial failure.
      // Skip anything identical (same name, size, kind) already stored in the
      // last 24 hours — deleting the file in the portal clears the match, so
      // a deliberate re-file after deletion still works.
      const { data: dupe } = await admin
        .from("cportal_files")
        .select("id")
        .eq("project_id", project.id)
        .eq("name", c.filename)
        .eq("size", bytes.length)
        .eq("kind", c.kind)
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .limit(1);
      if (dupe && dupe.length > 0) {
        skippedNonPo.push({
          filename: c.filename,
          document_type: "duplicate",
          reasoning: "Identical file was already filed minutes ago (duplicate flow run)",
        });
        continue;
      }

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
          kind: c.kind,
        })
        .select("id")
        .single();
      if (insErr || !insertedFile) {
        await admin.storage.from("cportal-project-files").remove([storagePath]);
        failures.push({ name: c.filename, error: `files insert failed: ${insErr?.message}` });
        continue;
      }

      // Synchronously call the SharePoint mirror (POs only). We use direct
      // fetch (not admin.functions.invoke) because invoke() doesn't reliably
      // pass the service-role token in the Authorization header that the
      // mirror function checks. Edge functions also kill detached promises on
      // return, so this has to await. Stays well under Power Automate's
      // 120-sec HTTP timeout.
      let spOutcome: UploadOutcome["sharepoint"] = c.kind === "purchase_order" ? "failed" : "n/a";
      let spPath: string | null = null;
      let spNote: string | null = null;
      if (c.kind === "purchase_order") {
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
      }

      uploaded.push({
        name: c.filename,
        fileId: insertedFile.id,
        kind: c.kind,
        po_number: c.kind === "purchase_order" ? c.verdict.po_number : null,
        sharepoint: spOutcome,
        sharepoint_path: spPath,
        sharepoint_note: spNote,
      });
    } catch (e) {
      failures.push({ name: c.filename, error: String((e as Error)?.message ?? e) });
    }
  }

  if (uploaded.length === 0) {
    const dupeCount = skippedNonPo.filter((s) => s.document_type === "duplicate").length;
    if (dupeCount > 0 && failures.length === 0) {
      return json({
        ok: true,
        reason: "duplicate-run",
        hwiCode: jobCode,
        projectName: project.name,
        message: `All ${dupeCount} file${dupeCount === 1 ? "" : "s"} in this email were already filed to ${jobCode} within the last few minutes — this looks like a duplicate delivery, so nothing was stored twice.`,
      }, 200);
    }
    return json({
      ok: false,
      reason: "all-uploads-failed",
      hwiCode: jobCode,
      projectName: project.name,
      failures,
      message: `Found project ${jobCode} and identified ${toIngest.length} file${toIngest.length === 1 ? "" : "s"}, but couldn't store any of them. See failures.`,
    }, 200);
  }

  // (5) Success — return enough info for Power Automate to write a nice
  // confirmation email back to the PM.
  const customerCompany = (project.customer as { company?: string; name?: string } | null)?.company
    || (project.customer as { company?: string; name?: string } | null)?.name
    || null;
  const uploadedPos = uploaded.filter((u) => u.kind === "purchase_order");
  const uploadedDrawings = uploaded.filter((u) => u.kind === "drawing");
  const uploadedPhotos = uploaded.filter((u) => u.kind === "photo");
  const poNumberList = uploadedPos.map((u) => u.po_number).filter(Boolean).join(", ");
  const skippedNote = skippedNonPo.length > 0
    ? ` I also saw ${skippedNonPo.length} other attachment${skippedNonPo.length === 1 ? "" : "s"} (${skippedNonPo.map((s) => s.document_type).join(", ")}) which I didn't file.`
    : "";

  // Compose an accurate SharePoint status sentence from the per-file PO
  // outcomes (drawings don't mirror to SharePoint).
  const mirrored = uploadedPos.filter((u) => u.sharepoint === "mirrored").length;
  const emailedToSales = uploadedPos.filter((u) => u.sharepoint === "emailed-to-sales").length;
  const spFailed = uploadedPos.filter((u) => u.sharepoint === "failed").length;
  let sharepointSentence = "";
  if (uploadedPos.length === 0) {
    sharepointSentence = "";
  } else if (mirrored === uploadedPos.length) {
    sharepointSentence = " The PO was also copied to SharePoint.";
  } else if (emailedToSales > 0 && mirrored + spFailed === 0) {
    sharepointSentence = " No SharePoint folder yet for this project — the PO was emailed to sales@hydrowates.com for manual filing.";
  } else {
    const parts: string[] = [];
    if (mirrored > 0) parts.push(`${mirrored} copied to SharePoint`);
    if (emailedToSales > 0) parts.push(`${emailedToSales} emailed to sales@ for manual filing`);
    if (spFailed > 0) parts.push(`${spFailed} couldn't be mirrored (the file is still in the portal — please drop it into the SharePoint folder manually)`);
    sharepointSentence = " SharePoint status (POs): " + parts.join("; ") + ".";
  }

  const uploadedSummary = [
    uploadedPos.length > 0
      ? `${uploadedPos.length} PO file${uploadedPos.length === 1 ? "" : "s"}${poNumberList ? ` (PO ${poNumberList})` : ""}`
      : null,
    uploadedDrawings.length > 0
      ? `${uploadedDrawings.length} drawing${uploadedDrawings.length === 1 ? "" : "s"}`
      : null,
    uploadedPhotos.length > 0
      ? `${uploadedPhotos.length} photo${uploadedPhotos.length === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean).join(" and ");

  return json({
    ok: true,
    hwiCode: jobCode,
    projectName: project.name,
    customer: customerCompany,
    uploaded,
    skippedNonPo,
    failures: failures.length ? failures : undefined,
    fromEmail,
    message: `Uploaded ${uploadedSummary} to project ${jobCode}${customerCompany ? ` (${customerCompany})` : ""}.${sharepointSentence}${skippedNote}`,
  }, 200);
});
