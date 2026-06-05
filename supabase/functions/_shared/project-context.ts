// Shared helper for outbound emails that have a project context. Pulls the
// project's name, description, and scope (lead_comments — populated from
// the SharePoint Lead List) and renders an HTML block that every email
// can drop into its bodyHtml so recipients get more than just an HWI
// number when they open the message.

export interface ProjectContext {
  name: string;
  description?: string | null;
  lead_comments?: string | null;
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Render plain text with newlines preserved as <br>, after escaping HTML.
function escMultiline(s: string): string {
  return esc(s).replace(/\r?\n/g, "<br>");
}

// Hard cap so a long scope doesn't dominate the email body. Customers can
// always see the full scope in the portal.
const SCOPE_LIMIT = 600;

function clamp(s: string, max: number): { text: string; truncated: boolean } {
  const trimmed = s.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  // Cut at the last whitespace before the limit so we don't split a word.
  const slice = trimmed.slice(0, max);
  const lastBreak = slice.lastIndexOf(" ");
  const cut = lastBreak > max * 0.7 ? slice.slice(0, lastBreak) : slice;
  return { text: cut.trim() + "…", truncated: true };
}

// Returns an HTML block summarizing the project. Safe to drop into any
// brandedEmail bodyHtml. Returns an empty string if there's nothing
// substantive to show (e.g. just a project name with no description and
// no scope) so emails stay clean for older or under-documented projects.
export function renderProjectInfoBlock(p: ProjectContext): string {
  const description = (p.description ?? "").trim();
  const scope = (p.lead_comments ?? "").trim();
  if (!description && !scope) return "";

  const parts: string[] = [];
  if (description) {
    parts.push(
      `<div style="font-size:13px;color:#374151;line-height:1.5;margin-bottom:${scope ? "10px" : "0"};">
         <span style="display:inline-block;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Description</span><br>
         ${esc(description)}
       </div>`
    );
  }
  if (scope) {
    const { text, truncated } = clamp(scope, SCOPE_LIMIT);
    parts.push(
      `<div style="font-size:13px;color:#374151;line-height:1.5;">
         <span style="display:inline-block;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px;">Project scope</span><br>
         ${escMultiline(text)}${truncated ? ` <span style=\"color:#6b7280;font-style:italic;\">(full scope in the portal)</span>` : ""}
       </div>`
    );
  }

  return `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-left:3px solid #2563eb;border-radius:6px;padding:14px 16px;margin:16px 0;">
            <div style="font-size:12px;font-weight:600;color:#1e293b;margin-bottom:8px;">${esc(p.name)}</div>
            ${parts.join("")}
          </div>`;
}

// Plain-text variant (used when you also need a non-HTML body — most
// senders are HTML-only, so this is optional).
export function renderProjectInfoText(p: ProjectContext): string {
  const description = (p.description ?? "").trim();
  const scope = (p.lead_comments ?? "").trim();
  if (!description && !scope) return "";
  const lines = [`Project: ${p.name}`];
  if (description) lines.push("", "Description:", description);
  if (scope) {
    const { text } = clamp(scope, SCOPE_LIMIT);
    lines.push("", "Project scope:", text);
  }
  return lines.join("\n");
}
