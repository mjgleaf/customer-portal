// Builds "Customer Portal Admin Guide.docx" from the content below.
// KEPT in the repo so the guide can be updated as features change:
//   1. edit the relevant children.push(...) section
//   2. run:  node scripts/build-admin-guide.cjs   (from the project root)
// Requires the `docx` npm package (npm install docx).
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  AlignmentType, LevelFormat, TableOfContents, HeadingLevel, BorderStyle,
  WidthType, ShadingType, PageNumber, Footer, PageBreak,
} = require('docx');

const BLUE = "1E3A8A";
const LIGHT = "DCE6F4";
const GREY = "6B7280";
const CW = 9360;

const h1 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(t)] });
const h2 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(t)] });
const h3 = (t) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(t)] });
const p = (t) => new Paragraph({ spacing: { after: 120 }, children: typeof t === 'string' ? [new TextRun(t)] : t });
const lead = (label, rest) => new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: label, bold: true }), new TextRun(rest)] });
const bullet = (t) => new Paragraph({ numbering: { reference: "b", level: 0 }, spacing: { after: 60 }, children: typeof t === 'string' ? [new TextRun(t)] : t });
const num = (t) => new Paragraph({ numbering: { reference: "n", level: 0 }, spacing: { after: 60 }, children: typeof t === 'string' ? [new TextRun(t)] : t });
const spacer = () => new Paragraph({ spacing: { after: 60 }, children: [new TextRun("")] });

const border = { style: BorderStyle.SINGLE, size: 1, color: "BFBFBF" };
const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
const cellMargins = { top: 60, bottom: 60, left: 110, right: 110 };

function tcell(text, width, opts = {}) {
  const runs = (Array.isArray(text) ? text : [text]).map((t) =>
    new Paragraph({ children: [new TextRun({ text: String(t), bold: !!opts.bold, color: opts.color })] }));
  return new TableCell({
    width: { size: width, type: WidthType.DXA }, borders, margins: cellMargins,
    shading: opts.fill ? { fill: opts.fill, type: ShadingType.CLEAR, color: "auto" } : undefined,
    children: runs,
  });
}
function table(widths, header, rows) {
  const headRow = new TableRow({ tableHeader: true, children: header.map((h, i) => tcell(h, widths[i], { bold: true, fill: BLUE, color: "FFFFFF" })) });
  const bodyRows = rows.map((r) => new TableRow({ children: r.map((c, i) => tcell(c, widths[i])) }));
  return new Table({ width: { size: CW, type: WidthType.DXA }, columnWidths: widths, rows: [headRow, ...bodyRows] });
}

const children = [];

// Title page
children.push(
  new Paragraph({ spacing: { before: 2600, after: 0 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Hydro-Wates Customer Portal", bold: true, size: 56, color: BLUE })] }),
  new Paragraph({ spacing: { before: 120, after: 0 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Administrator & Onboarding Guide", size: 32, color: GREY })] }),
  new Paragraph({ spacing: { before: 2200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Internal reference for Hydro-Wates employees", italics: true, color: GREY })] }),
  new Paragraph({ spacing: { before: 80 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: "Live portal:  connect.hydrowates.com", color: GREY })] }),
  new Paragraph({ children: [new PageBreak()] }),
);

// TOC
children.push(
  new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: "Contents", bold: true, size: 32, color: BLUE })] }),
  new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
  new Paragraph({ children: [new PageBreak()] }),
);

// 1. Introduction
children.push(h1("1. Introduction & Purpose"));
children.push(p("The Hydro-Wates Customer Portal (live at connect.hydrowates.com) is a secure web application that gives our customers one place to follow their proof-load testing jobs — and gives Hydro-Wates staff a back office to manage those jobs end to end."));
children.push(h2("What problem it solves"));
children.push(p("Project paperwork — test certificates, drawings, purchase orders, invoices — used to live in email threads and SharePoint folders that customers couldn't reach. The portal centralizes all of it, so customers self-serve and staff spend less time forwarding files."));
children.push(h2("What customers can do"));
children.push(bullet("See every project for their company, with status and key dates."));
children.push(bullet("Download test certificates and drawings, and see retest due dates."));
children.push(bullet("View and download invoices (pulled live from Zoho Books)."));
children.push(bullet("Upload documents we've requested (e.g. signed POs) and see what's still outstanding."));
children.push(bullet("Request a new quote through a self-service form."));
children.push(h2("What Hydro-Wates staff can do"));
children.push(bullet("Manage every customer, project, contact, and invoice in one console."));
children.push(bullet("Invite customers and teammates to the portal."));
children.push(bullet("Send document reminders, post notes, and review purchase orders (with AI assistance)."));
children.push(bullet("Triage incoming quote requests."));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 2. Architecture
children.push(h1("2. How the System Is Built (Architecture)"));
children.push(p("The portal is made of two halves plus several outside systems it pulls data from."));
children.push(h2("The two halves"));
children.push(lead("Front end (what you see): ", "A React web app hosted on Vercel at connect.hydrowates.com. Vercel rebuilds the site automatically from the GitHub repository (reidscofield/connect). Source edits made in the shared OneDrive folder must reach that GitHub repo before they go live."));
children.push(lead("Back end (the engine): ", "Supabase — which provides the database (PostgreSQL), user logins (Auth), file storage, and a set of small server programs called Edge Functions. The Supabase project ID is vpdcikiyaifppkkantrb."));
children.push(h2("Outside systems it connects to"));
children.push(table([2300, 7060], ["System", "Role in the portal"], [
  ["Zoho Books", "Accounting system. The source of truth for customers, contacts, projects, and invoices."],
  ["SharePoint / Microsoft 365", "File storage (certificates, drawings, POs) and the “Lead List” that enriches projects. Also the email pipeline (Microsoft Graph)."],
  ["Power Automate", "Microsoft's automation tool. Watches an inbox for emailed purchase orders and forwards quote requests."],
  ["Anthropic Claude", "AI used to read purchase-order PDFs — classifying them and extracting key fields."],
]));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 3. Roles
children.push(h1("3. Who Uses It — User Roles"));
children.push(p("Every account has one of three roles. The role decides what a person can see and do. Roles are stored on the user's profile and enforced by the database (see Security)."));
children.push(table([1700, 7660], ["Role", "What they can do"], [
  ["Customer", "The default. Sees only their own company's projects, certificates, and invoices. Can upload requested documents, post notes, and request quotes."],
  ["Admin", "Hydro-Wates staff with full access. Manages all customers, projects, team members, quote requests, and settings. Can invite users and change roles."],
  ["Service Tech", "Field technicians. Read-only access to all Service-type projects (across companies) for logistics, plus a team directory. Cannot upload, manage users, or see admin-only items."],
]));
children.push(spacer());
children.push(h2("Capability summary"));
children.push(table([3960, 1800, 1800, 1800], ["Feature", "Customer", "Admin", "Service Tech"], [
  ["Dashboard (projects)", "Own only", "All", "All (read-only)"],
  ["Customers & contacts admin", "No", "Yes", "No"],
  ["Certificates view", "Own", "All", "Own-scope"],
  ["Invoices view", "Own", "All", "No"],
  ["Upload files to a project", "Yes", "Yes", "No (view)"],
  ["Internal project notes", "No", "Yes", "View only"],
  ["Send document reminders", "No", "Yes", "No"],
  ["Request a quote", "Yes", "No", "No"],
  ["Quote-request queue", "No", "Yes", "No"],
  ["Team management", "No", "Yes", "View only"],
  ["Invite users / change roles", "No", "Yes", "No"],
]));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 4. Sign in & access
children.push(h1("4. Signing In & Granting Access"));
children.push(h2("Ways to sign in"));
children.push(lead("Email & password: ", "The standard method for customers. Used on the login page."));
children.push(lead("Microsoft sign-in (SSO): ", "For Hydro-Wates employees. The “Sign in with Microsoft” button signs in with the company Microsoft 365 account, keeping the role assigned when they were invited."));
children.push(h2("Inviting someone to the portal"));
children.push(p("People don't sign themselves up — an admin invites them. Customers are invited from the Customers page (or a contact's row); staff are invited from the Team page."));
children.push(num("The admin clicks Invite. The system creates the account and emails an invitation."));
children.push(num("The recipient clicks the button in the email and lands on a “welcome” page (the /accept page)."));
children.push(num("They click “Set up my account,” choose a password, and they're in."));
children.push(h2("The /accept page — why it exists (important)"));
children.push(p("Invitation and password-reset links contain a one-time token that only works once. Many corporate email systems (Microsoft Defender “Safe Links,” Mimecast, etc.) automatically open every link in an email to scan it — which used to “use up” that one-time token before the customer ever clicked, producing a “link expired” error."));
children.push(p("To prevent this, every invite/reset link now points to an in-between page (/accept) that does nothing on its own. The token is only spent when a real person clicks the button. Automated scanners load the page but never click, so the link survives for the customer."));
children.push(h2("Forgot / reset password"));
children.push(p("A user clicks “Forgot password?” on the login page and enters their email. They get a reset email that goes through the same /accept page, then to a “choose a new password” screen."));
children.push(h2("Acceptance notifications"));
children.push(p("When a customer activates their account for the first time, the portal automatically emails a Hydro-Wates shared inbox so the team knows the customer is now set up."));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 5. Pages
children.push(h1("5. The Portal Pages"));
children.push(p("A walkthrough of each screen and what it does. “Admin” notes call out staff-only behaviour."));

children.push(h2("Dashboard ( / )"));
children.push(p("The landing page after sign-in. Admins see every project grouped alphabetically by company, an outstanding-invoices total, a “last synced” indicator, and a manual sync button. Customers see only their company's projects as cards, with an “action needed” banner for documents they still owe. A red dot appears on any project where someone has mentioned you in a note (see “Mentioning people in notes” below)."));

children.push(h2("Project detail ( /projects/:id )"));
children.push(p("The hub for a single project, organized into tabs:"));
children.push(bullet("Documents — upload, download, and preview project files."));
children.push(bullet("Drawings — drawing files only."));
children.push(bullet("Certificates — equipment test certificates, with “overdue” / “due soon” retest badges."));
children.push(bullet("Invoices — invoices linked to this project; click to open the PDF (fetched live from Zoho)."));
children.push(bullet("Notes — a comment thread; staff can mark notes “internal” so customers never see them."));
children.push(bullet("Members — who has access to the project. Each row is marked Member (they've signed in) or Invited (invited but hasn't signed in yet), matching the Customers-list status."));
children.push(lead("Admin: ", "can edit project details, add required-document checklists, add/remove members, send reminders, and write internal notes."));

children.push(h3("Mentioning people in notes (@mentions)"));
children.push(p("In a project note, type “@” and pick a person on that project to tag them. When the note is posted, anyone tagged gets a dedicated email — “[Name] mentioned you on HWI-XX-XXX” — plus a red dot on their dashboard and on the project's Notes tab. The red dot clears when they open the notes."));
children.push(lead("Who you can tag — this is the key rule:", ""));
children.push(bullet("Shared note: anyone on the project — Hydro-Wates staff or the customer."));
children.push(bullet("Private (team-only) note: STAFF ONLY. A customer can never be tagged in a private note, so a private note's contents are never emailed or shown to them."));
children.push(p("Note: the red dot is always recorded, but the mention email only sends when the global email switch is on (Section 8)."));

children.push(h2("Customers ( /customers ) — admin only"));
children.push(p("A searchable list of every customer synced from Zoho. Each row shows that person's account status and how many email addresses are on file per company. The status is one of:"));
children.push(bullet("Invite (blue button) — no account yet; click to send an invitation."));
children.push(bullet("Invited (amber) — they've been invited but haven't signed in yet."));
children.push(bullet("Active (green) — they've signed in and have portal access."));

children.push(h2("Customer detail ( /customers/:id ) — admin only"));
children.push(p("Everything about one company: its projects and a unified Contacts list combining the primary email, manually added contacts, and contacts synced from Zoho and SharePoint. Admins can add contacts, and each contact shows its access status — Invite (no account), Invited + Resend (invited but not signed in), or Active / Has access (signed in)."));
children.push(h3("Giving a contact access to company projects"));
children.push(p("For a contact who has a portal account, three controls grant project access — handy when one person (e.g. a PM) runs the jobs for a company:"));
children.push(bullet("“All company projects (incl. future)” toggle — standing access: they see every current project AND any new one synced later. Turning it off removes that access."));
children.push(bullet("“+ Add to current jobs” — a one-time add to every project the company has right now, without auto-including future jobs."));
children.push(bullet("“Choose projects…” — opens a checklist of the company's projects so you can grant access to a specific subset (e.g. just 3 of the jobs). Re-opening it shows what they currently have; saving syncs to your selection."));
children.push(p("These controls appear only for contacts who have been invited (access needs a login — invite them first if needed). Access is delivered through normal project membership, so it also covers that project's files, certificates, notes, and invoices."));

children.push(h2("Certificates ( /certificates )"));
children.push(p("Every test certificate the user is allowed to see, flattened into one searchable list with retest-due badges and inline preview. Customers see only their company's; admins see all."));

children.push(h2("Invoices ( /invoices )"));
children.push(p("All invoices in one list, with status badges (Paid, Overdue, Partially Paid, Open). Clicking a row opens the live PDF from Zoho Books. (Draft invoices in Zoho are not shown — an invoice reaches the portal only once it has been finalized/sent.)"));

children.push(h2("Request a Quote ( /request-quote )"));
children.push(p("A self-service form where customers ask for a quote (load test, rent, purchase, or “help me decide”). It pre-fills their details, accepts up to three attachments, saves the request, and notifies the sales team."));

children.push(h2("Quote Requests ( /quote-requests ) — admin only"));
children.push(p("The queue of submitted quote requests with statuses (New, In Review, Quoted, Closed), expandable detail, attachments, and an admin-notes field."));

children.push(h2("Team ( /team )"));
children.push(p("Admins manage staff accounts here — invite members, change roles, or remove access, and see who has signed in. Service techs see a read-only directory with click-to-call / email links."));

children.push(h2("Account ( /account )"));
children.push(p("Personal settings: name, phone, password, and a personal email-notifications toggle. Admins also get the system-wide email pause switch (see Section 8)."));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 6. Data sources
children.push(h1("6. Where All the Data Comes From"));
children.push(p("The portal does not hold a separate “master” of customers or projects — it pulls from the systems Hydro-Wates already uses and keeps them in sync. Here is every source."));
children.push(h2("Zoho Books — customers, contacts, projects, invoices"));
children.push(p("Zoho Books is the accounting system and the source of truth for the commercial data. A sync job (sync-zoho) pulls:"));
children.push(bullet("Customers (companies and their billing/shipping addresses)."));
children.push(bullet("Contacts (the people at each company)."));
children.push(bullet("Projects (name, description, status)."));
children.push(bullet("Invoices (amounts, balances, due dates, paid status). Drafts are excluded — an invoice flows in only once finalized/sent."));
children.push(p("Invoice PDFs themselves are fetched live from Zoho when a user opens one — they are not stored in the portal."));
children.push(h2("SharePoint / Microsoft 365 — files and project enrichment"));
children.push(p("Project files live in SharePoint, organized by HWI project folders. Sync jobs pull:"));
children.push(bullet("Files — purchase orders, quotes, and certificate PDFs from each project folder (sync-files-from-sharepoint)."));
children.push(bullet("Equipment certificates — located by following the job's equipment list (Load Out List → Hydro-Wates Inventory → the equipment's folder)."));
children.push(bullet("Lead List enrichment (sync-leads) — adds the ship-to address, on-site contact, project type, and lead comments to each project, matched by quote/HWI number."));
children.push(lead("Reference-only files: ", "To save space, most SharePoint files are not copied into the portal. The portal stores only a reference, and generates a fresh, short-lived download link from Microsoft each time someone clicks."));
children.push(h2("Emailed purchase orders — Power Automate + AI"));
children.push(p("When a customer emails a PO, staff forward it to an automation inbox. Power Automate sends it to the portal (ingest-po-from-email), where Claude reads each attachment, decides whether it's really a PO, extracts the HWI project code, files it under the right project, and mirrors it back to SharePoint."));
children.push(h2("Created inside the portal — manual entry"));
children.push(bullet("Uploaded documents (customers and admins)."));
children.push(bullet("Quote requests (the self-service form)."));
children.push(bullet("Project notes, document-requirement checklists, and manually added contacts."));
children.push(h2("Artificial intelligence (Claude)"));
children.push(p("Anthropic's Claude is used in two places: classifying emailed POs (above), and the admin “Analyze with AI” button, which reads a PO PDF and returns a summary, possible concerns, and extracted fields. This costs a few cents per analysis and is admin-only."));
children.push(h2("How often each source syncs"));
children.push(table([3100, 3100, 3160], ["Source / job", "Trigger", "Timing"], [
  ["Zoho (sync-zoho)", "Scheduled + manual button", "Regularly / on demand"],
  ["SharePoint Lead List (sync-leads)", "Scheduled + manual button", "Regularly / on demand"],
  ["SharePoint files & certificates", "Opening a project page", "On demand"],
  ["Emailed POs", "Power Automate (email arrives)", "Real-time"],
  ["Quote requests", "Customer submits form", "Real-time"],
  ["Invoice PDFs", "User opens an invoice", "Live fetch"],
]));
children.push(spacer());
children.push(lead("Important — HWI naming: ", "File syncing and PO filing rely on each project being named with its HWI code (e.g. HWI-26-264). If a project isn't named correctly, the system can't find its SharePoint folder, and files won't sync."));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 7. Security
children.push(h1("7. Security"));
children.push(p("Security has several layers so that customers can only ever see their own company's data, and sensitive actions are limited to staff."));
children.push(h2("Authentication (proving who you are)"));
children.push(p("Logins are handled by Supabase Auth using secure, token-based sessions, plus Microsoft sign-in for employees. Passwords are never stored by the portal in readable form. Invitation and reset emails use single-use links protected by the /accept page (Section 4)."));
children.push(h2("How a customer is matched to their data"));
children.push(p("A customer is linked to their company by email address. When they sign in, the system finds the Zoho customer (or contact) whose email matches theirs, and shows only that company's projects, certificates, and invoices."));
children.push(lead("Company-peer access: ", "Because Zoho lists each person at a company as a separate record, the portal also grants access by matching company name — so two colleagues at the same company can see the same projects even though they're different records."));
children.push(lead("Company-wide access grants: ", "Admins can also explicitly give one person access to all of a company's projects (Section 5). This uses normal project membership behind the scenes — no special exception to the rules below."));
children.push(h2("Row-Level Security (the core protection)"));
children.push(p("The database itself enforces access with Row-Level Security (RLS) — rules attached to every table that filter rows by who is asking. Even if someone tried to request data directly, the database returns only the rows they're allowed to see. In short:"));
children.push(bullet("Customers: only rows for their own company (by email or company match), project membership, and only non-internal notes."));
children.push(bullet("Service techs: all Service-type projects plus the team directory; not other companies' equipment projects or admin-only data."));
children.push(bullet("Admins: full access."));
children.push(h2("Private notes & @mentions"));
children.push(p("Notes marked “private” are visible only to Hydro-Wates staff and are hidden from customers by RLS. To protect that, a customer can never be @mentioned in a private note — enforced both in the notes box and on the server — so a private note's content is never emailed or surfaced to a customer."));
children.push(h2("Role protection"));
children.push(p("A safeguard in the database prevents anyone from promoting themselves — only an admin can change a person's role. Roles are set during the invite by trusted server functions, never by the user."));
children.push(h2("Email pipeline & secrets"));
children.push(p("All portal email (invites, resets, reminders, notifications) is sent through Microsoft 365 via Microsoft Graph, from a Hydro-Wates mailbox, using a branded template. Server-to-server connections (Power Automate, the acceptance-notification trigger, the Supabase email hook) are protected by shared secrets and signature checks so outsiders can't trigger them."));
children.push(p("Sensitive credentials — Zoho keys, Microsoft Graph keys, the Anthropic key, and webhook secrets — are stored as protected settings in Supabase (environment secrets and the Supabase Vault), never in the website code."));
children.push(h2("Other safeguards"));
children.push(bullet("Scanner-proof invite/reset links (the /accept page)."));
children.push(bullet("Short-lived (minutes) download links for files, so links can't be reused or leaked."));
children.push(bullet("Internal notes hidden from customers; private notes can't tag customers."));
children.push(bullet("AI purchase-order analysis is admin-only and never visible to customers."));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 8. Emails
children.push(h1("8. Email Notifications & the Pause Switch"));
children.push(p("The portal sends emails for several events:"));
children.push(bullet("A customer is invited, or accepts their invite."));
children.push(bullet("A file is uploaded or a project note is added (the other side is notified)."));
children.push(bullet("Someone is @mentioned in a note (the tagged person is emailed)."));
children.push(bullet("An admin sends a document reminder."));
children.push(bullet("A new invoice (finalized in Zoho) or project status change is synced."));
children.push(bullet("A quote request is submitted."));
children.push(h2("The global pause switch"));
children.push(lead("Emails are paused by default. ", "There is a system-wide switch (Account page, admin only) that turns all customer-facing email on or off. It must be switched on for customers to receive notifications. This is a safety valve to avoid accidental email blasts (e.g. right after a big sync)."));
children.push(h2("Per-person preference"));
children.push(p("Each user can also turn their own email notifications off on their Account page, independent of the global switch."));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 9. Common admin tasks
children.push(h1("9. Common Admin Tasks"));
children.push(h3("Invite a customer"));
children.push(p("Customers page → find the company → Invite → confirm. They receive an email to set a password. (Or invite a specific person from the customer's Contacts list.)"));
children.push(h3("Invite a teammate"));
children.push(p("Team page → Invite new member → enter email, name, and role (admin or service tech)."));
children.push(h3("Give one person all of a company's projects"));
children.push(p("Customer detail page → find the contact (invite them first if they have no account) → turn on “All company projects” for standing access including future jobs, or click “+ Add to current jobs” for a one-time add."));
children.push(h3("Pull the latest data"));
children.push(p("Use the manual Sync button on the Dashboard to refresh from Zoho and SharePoint, or wait for the scheduled sync. (Certificates/files for a specific job refresh when you open that project.)"));
children.push(h3("Chase a missing document"));
children.push(p("Open the project → Documents → Remind on the outstanding item. (Requires the global email switch to be on.)"));
children.push(h3("Mention someone in a note"));
children.push(p("Open the project → Notes → type @ and pick a person. They get an email and a red dot. Use a Private note for team-only context — customers can't be tagged there."));
children.push(h3("Review a purchase order with AI"));
children.push(p("Open the PO file → Analyze with AI → read the summary, concerns, and extracted fields."));
children.push(h3("Handle a quote request"));
children.push(p("Quote Requests page → expand the request → update its status and add admin notes."));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 10. Troubleshooting
children.push(h1("10. Troubleshooting"));
children.push(table([3200, 6160], ["Symptom", "Likely cause & fix"], [
  ["Customer says the invite link “expired” or didn't work", "Their email scanner consumed the one-time link. This is handled by the /accept page; make sure the latest front end is deployed, then re-invite."],
  ["No notification emails are going out", "The global email switch is off (it's off by default). Turn it on from an admin's Account page."],
  ["A customer can't see their projects/invoices", "Their login email must match a Zoho contact for that company (or a contact / same company name), OR add them via project membership / company-wide access. Add their email as a contact and re-check."],
  ["Files or certificates aren't appearing for a project", "The project must be named with its HWI code so the SharePoint folder can be found; equipment certs also need the Load Out List + Inventory folder + a PDF. Confirm naming, then re-open the project."],
  ["A customer got an invoice email but isn't signed up", "Invoice emails now go only to customers with a portal account, and only for finalized (non-draft) invoices. Make sure the latest sync-zoho is deployed."],
  ["A new feature was “deployed” but isn't live", "The front end deploys from GitHub via Vercel. New source files must reach GitHub (not just OneDrive) and the Vercel build must succeed."],
]));
children.push(new Paragraph({ children: [new PageBreak()] }));

// 11. Reference
children.push(h1("11. Reference"));
children.push(h2("Key database tables (all named cportal_*)"));
children.push(table([3000, 6360], ["Table", "Holds"], [
  ["cportal_profiles", "Portal accounts: name, role, company, notification preference."],
  ["cportal_customers", "Companies/contacts synced from Zoho, with addresses."],
  ["cportal_customer_contacts", "Multiple people per company (Zoho, SharePoint, manual)."],
  ["cportal_projects", "Projects from Zoho, enriched by the SharePoint Lead List."],
  ["cportal_project_members", "Who has access to a project (incl. company-wide grants)."],
  ["cportal_invoices", "Invoices synced from Zoho."],
  ["cportal_files", "Documents, drawings, certificates, and POs."],
  ["cportal_project_notes", "Project comment threads (with internal flag)."],
  ["cportal_note_mentions", "Who was @mentioned in a note + read state (the red dot)."],
  ["cportal_company_access", "Standing 'all projects' grants for a person at a company."],
  ["cportal_quote_requests", "Submitted quote-request forms."],
  ["cportal_po_reviews", "AI analysis of purchase orders (admin-only)."],
  ["cportal_app_settings", "System settings, including the email pause switch."],
]));
children.push(spacer());
children.push(h2("Server programs (Supabase Edge Functions)"));
children.push(table([3000, 6360], ["Function", "Purpose"], [
  ["sync-zoho", "Pull customers, contacts, projects, invoices from Zoho."],
  ["sync-leads", "Pull SharePoint Lead List enrichment onto projects."],
  ["sync-files-from-sharepoint", "Pull project files & certificates from SharePoint."],
  ["ingest-po-from-email", "Receive emailed POs, classify with AI, file them."],
  ["submit-quote-request", "Save quote requests and notify sales."],
  ["invite-customer", "Create accounts and send invitations."],
  ["send-auth-email", "Send all login emails via Microsoft Graph (uses /accept links)."],
  ["notify-invite-accepted", "Alert staff when a customer activates their account."],
  ["notify-project-note", "Note + @mention notifications to the right people."],
  ["notify-upload / send-reminder", "Upload and document-reminder emails."],
  ["review-po / invoice-pdf / get-sharepoint-download-url", "AI PO review, live invoice PDFs, secure file links."],
]));
children.push(spacer());
children.push(h2("Glossary"));
children.push(table([2200, 7160], ["Term", "Meaning"], [
  ["HWI code", "A project's identifier (e.g. HWI-26-264). Used to match SharePoint folders."],
  ["RLS", "Row-Level Security — database rules that limit which rows each user can see."],
  ["SSO", "Single sign-on — logging in with a Microsoft 365 account."],
  ["RFQ", "Request for quote — a customer's quote request."],
  ["PO", "Purchase order."],
  ["Edge Function", "A small server program in Supabase that runs portal logic."],
  ["Supabase Vault", "Encrypted storage for secrets inside Supabase."],
]));
children.push(spacer());
children.push(new Paragraph({ spacing: { before: 240 }, children: [new TextRun({ text: "This guide describes the portal as built. Specific URLs, project IDs, and mailbox names are configuration that may change over time.", italics: true, color: GREY })] }));

const doc = new Document({
  creator: "Hydro-Wates",
  title: "Customer Portal Administrator Guide",
  styles: {
    default: { document: { run: { font: "Arial", size: 22 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 30, bold: true, font: "Arial", color: BLUE },
        paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: LIGHT, space: 4 } } } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 25, bold: true, font: "Arial", color: "111827" },
        paragraph: { spacing: { before: 200, after: 100 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 22, bold: true, font: "Arial", color: "374151" },
        paragraph: { spacing: { before: 140, after: 80 }, outlineLevel: 2 } },
    ],
  },
  numbering: { config: [
    { reference: "b", levels: [
      { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } },
      { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1080, hanging: 280 } } } },
    ] },
    { reference: "n", levels: [
      { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 280 } } } },
    ] },
  ] },
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
      new TextRun({ text: "Hydro-Wates Customer Portal — Administrator Guide      Page ", color: GREY, size: 18 }),
      new TextRun({ children: [PageNumber.CURRENT], color: GREY, size: 18 }),
    ] })] }) },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync("Customer Portal Admin Guide.docx", buf);
  console.log("WROTE Customer Portal Admin Guide.docx (" + buf.length + " bytes)");
});
