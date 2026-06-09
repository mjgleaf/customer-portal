import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Upload, Download, Trash2, FileText, Users, Edit2, X, Check, Plus, Receipt, ExternalLink, ClipboardList, Award, Eye, Send, MessageSquare, Sparkles, MapPin, Lock, User, Phone } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Project, ProjectFile, ProjectMember, Profile, Invoice, DocumentRequest } from '../types'

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Compact relative time for "Reminded X ago" labels.
function formatRelativeTime(d: string) {
  const ms = Date.now() - new Date(d).getTime()
  const mins = Math.floor(ms / 60000)
  const hours = Math.floor(mins / 60)
  const days = Math.floor(hours / 24)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 30) return `${days}d ago`
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount == null) return '—'
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(amount)
  } catch {
    return String(amount)
  }
}

function invoiceStatusColor(status: string | null): string {
  if (status === 'paid') return 'text-green-700 bg-green-100'
  if (status === 'overdue') return 'text-red-700 bg-red-100'
  if (status === 'partially_paid') return 'text-yellow-700 bg-yellow-100'
  return 'text-gray-600 bg-gray-100'
}

// Badge for a certificate's re-test due date (only when overdue or within 30 days).
function retestInfo(due: string | null | undefined): { label: string; color: string } | null {
  if (!due) return null
  const days = Math.ceil((new Date(due + 'T00:00:00').getTime() - Date.now()) / 86400000)
  if (days < 0) return { label: 'Overdue', color: 'text-red-700 bg-red-100' }
  if (days <= 30) return { label: days === 0 ? 'Due today' : `Due in ${days}d`, color: 'text-amber-700 bg-amber-100' }
  return null
}

// Decide how (or whether) we can preview a file inline in the browser.
function previewKind(file: ProjectFile): 'pdf' | 'image' | 'unsupported' {
  const name = file.name.toLowerCase()
  const mime = (file.mime_type ?? '').toLowerCase()
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) return 'image'
  return 'unsupported'
}

// Inline preview modal — shows PDFs in an iframe, images directly, and falls
// back to a download prompt for anything else (e.g. .docx, .xlsx).
function FilePreviewModal({ file, url, onClose, onDownload }: {
  file: ProjectFile
  url: string
  onClose: () => void
  onDownload: () => void
}) {
  const kind = previewKind(file)
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-5xl h-[90vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0">
          <p className="text-sm font-medium text-gray-900 truncate pr-4">{file.name}</p>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={onDownload} className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
              <Download size={18} />
            </button>
            <button onClick={onClose} className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors" title="Close">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-hidden bg-gray-100 rounded-b-2xl">
          {kind === 'pdf' && (
            <iframe src={url} title={file.name} className="w-full h-full border-0" />
          )}
          {kind === 'image' && (
            <div className="w-full h-full flex items-center justify-center overflow-auto">
              <img src={url} alt={file.name} className="max-w-full max-h-full object-contain" />
            </div>
          )}
          {kind === 'unsupported' && (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-gray-500 text-sm">
              <FileText size={48} className="text-gray-300" />
              <p>Preview isn't available for this file type.</p>
              <button onClick={onDownload} className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors">
                <Download size={16} /> Download to open
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}


type TabKey ='documents' | 'drawings' | 'certificates' | 'invoices' | 'notes' | 'members'

type ProjectNote = {
  id: string
  project_id: string
  author_id: string
  content: string
  internal: boolean
  created_at: string
  updated_at: string
  author?: { full_name: string | null; email: string; role: string } | null
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const isAdmin = profile?.role === 'admin'
  // Service techs use the portal as a logistics view. They read everything
  // (scope, ship-to, equipment certs, notes, files) but don't interact with
  // customer/admin workflows like uploading docs or sending reminders.
  const isServiceTech = profile?.role === 'service_tech'
  // canUpload covers anyone who actively manages docs (customers + admins).
  // Service techs are intentionally excluded — keeps the UI focused on
  // "where am I going + what do I need" instead of paperwork.
  const canUpload = isAdmin || profile?.role === 'customer'
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadCtx = useRef<{ kind: string; requirementId: string | null }>({ kind: 'general', requirementId: null })

  const [project, setProject] = useState<Project | null>(null)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [documentRequests, setDocumentRequests] = useState<DocumentRequest[]>([])
  const [newRequirement, setNewRequirement] = useState('')
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [openingInvoice, setOpeningInvoice] = useState<string | null>(null)
  const [invoiceError, setInvoiceError] = useState('')
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [availableProfiles, setAvailableProfiles] = useState<Profile[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [dragZone, setDragZone] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState<{ file: ProjectFile; url: string } | null>(null)
  const [pendingUpload, setPendingUpload] = useState<{
    files: File[]
    ctx: { kind: string; requirementId: string | null }
    notify: boolean
  } | null>(null)
  const [uploaderById, setUploaderById] = useState<Record<string, Profile>>({})
  const [reminderState, setReminderState] = useState<{ key: string; status: 'sending' | 'sent' | 'error' } | null>(null)
  const [pendingReminder, setPendingReminder] = useState<{ documentLabel: string; key: string } | null>(null)
  // Map of document_key -> ISO timestamp of the most recent reminder we sent
  // for that document on this project. Admin-only; populated from the
  // `reminders` log table on mount and updated optimistically on send.
  const [lastReminderByKey, setLastReminderByKey] = useState<Record<string, string>>({})
  // Emails the admin has selected to receive the pending reminder.
  // Defaults to every eligible recipient (customer + members) when the modal
  // opens; admin can uncheck individuals before clicking Send reminder.
  const [selectedReminderEmails, setSelectedReminderEmails] = useState<string[]>([])
  // Every Zoho customer contact at this project's company, with status info
  // so the Members tab can show "Member" / "Has account" / "Not signed up"
  // and let the admin act on each (Invite / Add to project / nothing).
  type CompanyContact = {
    customerId: string
    name: string | null
    email: string | null
    status: 'member' | 'has_account' | 'pending'
    userId?: string
  }
  const [companyContacts, setCompanyContacts] = useState<CompanyContact[]>([])
  const [contactActionId, setContactActionId] = useState<string | null>(null)
  const [contactActionMsg, setContactActionMsg] = useState<string>('')
  // Confirmation modal before any company-contact invite actually fires.
  const [pendingContactInvite, setPendingContactInvite] = useState<CompanyContact | null>(null)
  // Confirmation modal before adding an existing-account contact as a member.
  // Mirrors the invite confirmation so an accidental click can't silently
  // grant project access.
  const [pendingAddMember, setPendingAddMember] = useState<CompanyContact | null>(null)
  // Confirmation modal before removing a member. Carries enough info to show
  // who's being removed without an extra lookup. Mirrors the other confirmations.
  const [pendingRemoveMember, setPendingRemoveMember] = useState<{
    memberId: string
    name: string | null
    email: string | null
  } | null>(null)
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null)
  // Confirmation modal before deleting a file. Used by every Delete button
  // on the page (PO, requirements, certs, quotes, drawings, other docs).
  const [pendingDeleteFile, setPendingDeleteFile] = useState<ProjectFile | null>(null)
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null)
  // Background sync that runs automatically when the project page loads.
  // Shows a small indicator at the top — pulsing blue while running,
  // steady green with timestamp when done, amber if the call failed so
  // admins can see something is wrong (instead of silently hiding).
  const [autoSyncing, setAutoSyncing] = useState(false)
  // Timestamp of the most recent successful auto-sync.
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null)
  // True if the last auto-sync errored (network blip, Graph error, etc.).
  // Shown as an amber indicator. Refreshing the page retries.
  const [lastSyncFailed, setLastSyncFailed] = useState(false)

  // AI Purchase-Order review (admin-only): Claude's summary + concerns
  // for the current project's PO file, if it exists.
  type POReview = {
    id: string
    file_id: string
    summary: string | null
    concerns: string[]
    extracted_fields: Record<string, unknown> | null
    model: string | null
    reviewed_at: string
    reviewed_by: string | null
  }
  const [poReview, setPoReview] = useState<POReview | null>(null)
  const [analyzingPO, setAnalyzingPO] = useState(false)
  const [analyzeError, setAnalyzeError] = useState('')
  const [showExtracted, setShowExtracted] = useState(false)

  // Project notes — shared comment thread. Notes marked `internal` are
  // hidden from customers; admins + techs both see and can author them.
  const [notes, setNotes] = useState<ProjectNote[]>([])
  const [newNoteContent, setNewNoteContent] = useState('')
  const [newNoteInternal, setNewNoteInternal] = useState(false)
  const [addingNote, setAddingNote] = useState(false)
  const [noteError, setNoteError] = useState('')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [editingNoteContent, setEditingNoteContent] = useState('')
  const [activeTab, setActiveTab] = useState<TabKey>('documents')

  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')

  const [showAddMember, setShowAddMember] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState('')

  useEffect(() => {
    if (!id) return
    fetchProject()
    fetchFiles()
    fetchDocumentRequests()
    fetchNotes()
    if (isAdmin) {
      fetchMembers()
      fetchAvailableProfiles()
      fetchLastReminders()
    }
  }, [id, isAdmin])

  // Auto-sync from SharePoint in the background whenever the project loads.
  // Fires once per (project id) — non-blocking, so the page renders existing
  // files immediately and the list updates if any new ones land. Only runs
  // when the project name starts with an HWI code (the sync function needs
  // it to locate the matching SharePoint folder).
  useEffect(() => {
    if (!id || !project?.name) return
    if (!/^HWI-\d{2}-\d+/i.test(project.name)) return
    void autoSyncFromSharePoint(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, project?.name])

  // Whenever the reminder confirmation card opens, default the recipient
  // picker to every eligible recipient (the project's customer + every
  // member with an email). Admin can uncheck individuals before sending.
  useEffect(() => {
    if (!pendingReminder) return
    const emails: string[] = []
    if (project?.customer?.email) emails.push(project.customer.email)
    for (const m of members) {
      const e = m.profile?.email
      if (e && !emails.some(x => x.toLowerCase() === e.toLowerCase())) emails.push(e)
    }
    setSelectedReminderEmails(emails)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingReminder])

  // Pull POs, certificates, and quotes from this project's matching
  // SharePoint folder. Runs automatically on every project page load (both
  // admins and customers — the edge function permits members to sync their
  // own projects). Dedupes by SharePoint item id so re-running just picks
  // up new files. Tracks success / failure so the header can show an
  // accurate state indicator without needing a manual button.
  async function autoSyncFromSharePoint(projectId: string) {
    setAutoSyncing(true)
    setLastSyncFailed(false)
    try {
      const { data, error } = await supabase.functions.invoke('sync-files-from-sharepoint', {
        body: { projectId },
      })
      if (error || data?.error) {
        console.warn('Auto-sync failed:', error?.message || data?.error)
        setLastSyncFailed(true)
        return
      }
      // Tally new files; if any landed, refresh the file list.
      let addedAny = false
      if (data?.summary) {
        for (const stats of Object.values(data.summary as Record<string, { added: number }>)) {
          if (stats.added > 0) { addedAny = true; break }
        }
      }
      if (addedAny) await fetchFiles()
      setLastSyncedAt(new Date())
    } catch (e) {
      console.warn('Auto-sync error:', e)
      setLastSyncFailed(true)
    } finally {
      setAutoSyncing(false)
    }
  }

  // AI PO review: fetch the current saved review (if any) for the PO file.
  // Skips silently for customers (RLS blocks the read; setPoReview(null) is fine).
  async function fetchPOReview(fileId: string) {
    if (!isAdmin) { setPoReview(null); return }
    const { data } = await supabase
      .from('cportal_po_reviews')
      .select('*')
      .eq('file_id', fileId)
      .maybeSingle()
    setPoReview((data ?? null) as POReview | null)
  }

  async function analyzePO(fileId: string) {
    setAnalyzingPO(true)
    setAnalyzeError('')
    try {
      const { data, error } = await supabase.functions.invoke('review-po', {
        body: { fileId },
      })
      if (error || data?.error) {
        setAnalyzeError(error?.message || data?.error || 'Unknown error')
        return
      }
      if (data?.review) setPoReview(data.review as POReview)
    } catch (e) {
      setAnalyzeError((e as Error).message)
    } finally {
      setAnalyzingPO(false)
    }
  }

  // Project notes: fetch the thread and enrich each row with its author's
  // profile (name, email, role) so the UI can label them appropriately.
  async function fetchNotes() {
    if (!id) return
    const { data: rows } = await supabase
      .from('cportal_project_notes')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
    const list = (rows ?? []) as ProjectNote[]
    if (list.length === 0) { setNotes([]); return }
    const authorIds = Array.from(new Set(list.map(n => n.author_id)))
    const { data: profs } = await supabase
      .from('cportal_profiles')
      .select('id, full_name, email, role')
      .in('id', authorIds)
    const byId = new Map((profs ?? []).map(p => [p.id, p]))
    setNotes(list.map(n => ({ ...n, author: byId.get(n.author_id) ?? null })))
  }

  async function addNote() {
    if (!user || !id || !newNoteContent.trim()) return
    setAddingNote(true)
    setNoteError('')
    const trimmed = newNoteContent.trim()
    // Customers can never insert an internal note (RLS blocks it anyway,
    // but the checkbox isn't even rendered for them).
    const internalFlag = newNoteInternal && (isAdmin || isServiceTech)
    const { error } = await supabase
      .from('cportal_project_notes')
      .insert({ project_id: id, author_id: user.id, content: trimmed, internal: internalFlag })
    setAddingNote(false)
    if (error) { setNoteError(error.message); return }
    setNewNoteContent('')
    setNewNoteInternal(false)
    fetchNotes()
    // Best-effort: notify the other side via Microsoft Graph. Skip on
    // internal notes — customers shouldn't be pinged about a note they
    // can't see, and team-to-team notifications aren't wired up.
    if (!internalFlag) {
      void supabase.functions.invoke('notify-project-note', {
        body: { projectId: id, portalUrl: window.location.origin },
      }).catch(() => { /* notification is best-effort */ })
    }
  }

  async function saveEditedNote(noteId: string) {
    if (!editingNoteContent.trim()) return
    const trimmed = editingNoteContent.trim()
    const { error } = await supabase
      .from('cportal_project_notes')
      .update({ content: trimmed, updated_at: new Date().toISOString() })
      .eq('id', noteId)
    if (error) { setNoteError(error.message); return }
    setEditingNoteId(null)
    setEditingNoteContent('')
    fetchNotes()
    void supabase.functions.invoke('notify-project-note', {
      body: { projectId: id, noteId, isUpdate: true, portalUrl: window.location.origin },
    }).catch(() => { /* best-effort */ })
  }

  async function deleteNote(noteId: string) {
    if (!confirm('Delete this note?')) return
    const { error } = await supabase.from('cportal_project_notes').delete().eq('id', noteId)
    if (error) { setNoteError(error.message); return }
    fetchNotes()
  }

  // Pull the latest reminder per document_key for this project so we can
  // show "Reminded Xd ago" next to each missing-document row.
  async function fetchLastReminders() {
    if (!id) return
    const { data } = await supabase
      .from('cportal_reminders')
      .select('document_key, sent_at')
      .eq('project_id', id)
      .order('sent_at', { ascending: false })
    const map: Record<string, string> = {}
    for (const r of data ?? []) {
      if (!map[r.document_key]) map[r.document_key] = r.sent_at
    }
    setLastReminderByKey(map)
  }

  async function fetchProject() {
    const { data } = await supabase
      .from('cportal_projects')
      .select('*, customer:cportal_customers(company, name, email, shipping_address, shipping_city, shipping_state, shipping_zip, shipping_country, billing_address, billing_city, billing_state, billing_zip, billing_country)')
      .eq('id', id)
      .single()
    if (!data) { navigate('/'); return }
    setProject(data)
    setEditName(data.name)
    setEditDesc(data.description ?? '')
    fetchInvoices(data.customer_id ?? null)
    setLoading(false)
  }

  async function fetchFiles() {
    const { data } = await supabase
      .from('cportal_files')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
    const list = (data ?? []) as ProjectFile[]
    setFiles(list)
    // Fetch the names of everyone who uploaded a file here, so we can show
    // "by Jane Doe" next to each row.
    const ids = Array.from(new Set(list.map(f => f.uploaded_by).filter((v): v is string => !!v)))
    if (ids.length === 0) { setUploaderById({}); return }
    const { data: profs } = await supabase.from('cportal_profiles').select('*').in('id', ids)
    const next: Record<string, Profile> = {}
    for (const p of profs ?? []) next[p.id] = p
    setUploaderById(next)
  }

  async function fetchDocumentRequests() {
    const { data } = await supabase
      .from('cportal_document_requests')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: true })
    setDocumentRequests((data ?? []) as DocumentRequest[])
  }

  async function fetchInvoices(customerId: string | null) {
    if (!customerId) { setInvoices([]); return }
    const { data } = await supabase
      .from('cportal_invoices')
      .select('*')
      .eq('customer_id', customerId)
      .order('invoice_date', { ascending: false })
    setInvoices((data ?? []) as Invoice[])
  }

  async function viewInvoice(inv: Invoice) {
    setOpeningInvoice(inv.id)
    setInvoiceError('')
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/invoice-pdf`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
        },
        body: JSON.stringify({ invoiceId: inv.id }),
      })
      if (!res.ok) {
        let msg = 'Could not open this invoice.'
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* response was not json */ }
        setInvoiceError(msg)
        return
      }
      const blob = await res.blob()
      window.open(URL.createObjectURL(blob), '_blank')
    } catch {
      setInvoiceError('Could not open this invoice.')
    } finally {
      setOpeningInvoice(null)
    }
  }

  async function fetchMembers() {
    const { data: rows } = await supabase
      .from('cportal_project_members')
      .select('id, project_id, user_id, created_at')
      .eq('project_id', id)
    const list = rows ?? []
    if (list.length === 0) { setMembers([]); return }
    // project_members.user_id points at auth.users, not profiles, so we can't
    // embed the profile directly — fetch profiles separately and merge.
    const { data: profs } = await supabase
      .from('cportal_profiles')
      .select('*')
      .in('id', list.map(r => r.user_id))
    const byId = new Map((profs ?? []).map(p => [p.id, p]))
    setMembers(list.map(r => ({ ...r, profile: byId.get(r.user_id) })) as ProjectMember[])
  }

  async function fetchAvailableProfiles() {
    const { data: allProfiles } = await supabase.from('cportal_profiles').select('*').eq('role', 'customer')
    const { data: currentMembers } = await supabase.from('cportal_project_members').select('user_id').eq('project_id', id)
    const memberIds = new Set(currentMembers?.map(m => m.user_id) ?? [])
    setAvailableProfiles((allProfiles ?? []).filter(p => !memberIds.has(p.id)))
  }

  // Pull every Zoho customer contact whose company matches this project's
  // company, then enrich with status info (member / has account / pending)
  // so the Members tab can render the right action per row.
  async function fetchCompanyContacts() {
    const company = project?.customer?.company
    if (!company) { setCompanyContacts([]); return }
    const { data: customers } = await supabase
      .from('cportal_customers')
      .select('id, name, email, company')
      .eq('company', company)
    if (!customers || customers.length === 0) { setCompanyContacts([]); return }
    const emails = customers.map(c => c.email).filter((e): e is string => !!e)
    let profileByEmail = new Map<string, string>()
    if (emails.length > 0) {
      const { data: profs } = await supabase
        .from('cportal_profiles').select('id, email').in('email', emails)
      profileByEmail = new Map((profs ?? [])
        .filter((p): p is { id: string; email: string } => !!p.email)
        .map(p => [p.email.toLowerCase(), p.id]))
    }
    const memberUserIds = new Set(members.map(m => m.user_id))
    const contacts: CompanyContact[] = customers.map(c => {
      const userId = c.email ? profileByEmail.get(c.email.toLowerCase()) : undefined
      let status: CompanyContact['status']
      if (userId && memberUserIds.has(userId)) status = 'member'
      else if (userId) status = 'has_account'
      else status = 'pending'
      return { customerId: c.id, name: c.name, email: c.email, status, userId }
    })
    setCompanyContacts(contacts)
  }

  // Recompute company contacts whenever the project or members change,
  // so status badges stay in sync after Invite / Add / Remove actions.
  useEffect(() => {
    if (project) fetchCompanyContacts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, members])

  // Whenever the PO file changes (uploaded, replaced), refetch its AI review.
  useEffect(() => {
    const po = files.find(f => f.kind === 'purchase_order')
    if (po && isAdmin) {
      fetchPOReview(po.id)
    } else {
      setPoReview(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, isAdmin])

  // Invite a customer who doesn't have a portal account yet AND immediately
  // add them as a project member. invite-customer returns the auth user_id
  // (Supabase's inviteUserByEmail creates the auth.users row right away,
  // even before the customer accepts), so we can insert into project_members
  // in the same click. By the time they accept the invite and log in for
  // the first time, this project is already linked to their account — no
  // separate "accept project" step required.
  async function inviteContact(contact: CompanyContact) {
    if (!contact.email || !id) return
    setContactActionId(contact.customerId)
    setContactActionMsg('')
    const { data, error } = await supabase.functions.invoke('invite-customer', {
      body: { email: contact.email, name: contact.name, redirectTo: `${window.location.origin}/set-password` },
    })
    if (error || data?.error) {
      setContactActionId(null)
      setContactActionMsg(`Invite failed: ${error?.message || data?.error}`)
      return
    }

    // Add to project_members immediately if we got back a user_id. We swallow
    // the unique-constraint case silently — if someone else already linked
    // them, the invite is still useful (they may have lost the email).
    const newUserId = data?.user_id as string | undefined
    if (newUserId) {
      const { error: memberError } = await supabase
        .from('cportal_project_members')
        .insert({ project_id: id, user_id: newUserId })
      if (memberError && !memberError.message?.toLowerCase().includes('duplicate')) {
        setContactActionId(null)
        setContactActionMsg(`Invited, but couldn't add to project: ${memberError.message}`)
        return
      }
    }

    setContactActionId(null)
    setContactActionMsg(`${contact.name || contact.email} invited and added to this project.`)
    setTimeout(() => setContactActionMsg(''), 4000)
    fetchMembers()
    fetchAvailableProfiles()
  }

  // Promote a customer who already has a portal account into a member of
  // this specific project. Adds the row to project_members and refreshes.
  async function addContactAsMember(contact: CompanyContact) {
    if (!contact.userId || !id) return
    setContactActionId(contact.customerId)
    const { error } = await supabase
      .from('cportal_project_members')
      .insert({ project_id: id, user_id: contact.userId })
    setContactActionId(null)
    if (error) {
      setContactActionMsg(`Add failed: ${error.message}`)
      return
    }
    setContactActionMsg(`${contact.name || contact.email} added.`)
    setTimeout(() => setContactActionMsg(''), 4000)
    fetchMembers()
    fetchAvailableProfiles()
  }

  // --- Uploads (shared input, driven by uploadCtx) ---
  function triggerUpload(ctx: { kind: string; requirementId: string | null }) {
    uploadCtx.current = ctx
    fileInputRef.current?.click()
  }

  async function handleFileInput(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (files && files.length) startUpload(Array.from(files), uploadCtx.current)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Admins get an in-between confirmation modal with a "Notify customer?"
  // toggle (default OFF). Customers just upload straight away — the team is
  // always notified via notify-upload.
  function startUpload(files: File[], ctx: { kind: string; requirementId: string | null }) {
    if (files.length === 0) return
    if (isAdmin) {
      setPendingUpload({ files, ctx, notify: false })
    } else {
      void uploadFiles(files, ctx, true)
    }
  }

  async function uploadFiles(
    files: File[],
    ctx: { kind: string; requirementId: string | null },
    notify: boolean,
  ) {
    if (!id || !user || files.length === 0) return
    setUploading(true)
    setUploadError('')

    let uploaded = 0
    const insertedPoFileIds: string[] = []
    for (const file of files) {
      const storagePath = `${id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${file.name}`
      const { error: storageError } = await supabase.storage.from('cportal-project-files').upload(storagePath, file)
      if (storageError) {
        setUploadError(storageError.message)
        continue
      }
      const { data: insertedFile } = await supabase.from('cportal_files').insert({
        project_id: id,
        name: file.name,
        storage_path: storagePath,
        size: file.size,
        mime_type: file.type,
        uploaded_by: user.id,
        kind: ctx.kind,
        document_request_id: ctx.requirementId,
      }).select('id').single()
      if (insertedFile && ctx.kind === 'purchase_order') {
        insertedPoFileIds.push(insertedFile.id)
      }
      uploaded++
    }

    if (uploaded > 0 && notify) {
      void supabase.functions.invoke('notify-upload', {
        body: {
          projectId: id,
          fileName: uploaded === 1 ? files[0].name : `${uploaded} files`,
          portalUrl: window.location.origin,
        },
      }).catch(() => { /* best-effort */ })
    }

    // Fire-and-forget SharePoint sync for any uploaded POs. Refetch files
    // once it returns so the "Saved to SharePoint" badge appears on the row
    // without the user having to refresh.
    for (const poFileId of insertedPoFileIds) {
      void supabase.functions.invoke('upload-po-to-sharepoint', {
        body: { fileId: poFileId },
      }).then(() => fetchFiles()).catch(() => { /* best-effort */ })
    }

    await fetchFiles()
    setUploading(false)
  }

  async function handleDownload(file: ProjectFile) {
    // SharePoint reference-only file: bytes live in SharePoint, storage_path is NULL.
    // Ask the edge function for a short-lived Graph download URL.
    if (file.sharepoint_source_id) {
      const { data, error } = await supabase.functions.invoke('get-sharepoint-download-url', {
        body: { fileId: file.id, mode: 'download' },
      })
      const url = (data as { url?: string; downloadUrl?: string } | null)?.url
        ?? (data as { downloadUrl?: string } | null)?.downloadUrl
      if (error || !url) {
        alert("Couldn't get download URL for this file. " + (error?.message ?? ''))
        return
      }
      const a = document.createElement('a')
      a.href = url
      a.download = file.name
      a.click()
      return
    }
    const { data } = await supabase.storage.from('cportal-project-files').createSignedUrl(file.storage_path, 60)
    if (data?.signedUrl) {
      const a = document.createElement('a')
      a.href = data.signedUrl
      a.download = file.name
      a.click()
    }
  }

  // Open the inline preview modal for any file (PDF / image / fallback).
  async function previewFile(file: ProjectFile) {
    // SharePoint reference-only file: use Graph's /preview endpoint, which
    // returns an embeddable iframe URL (same renderer SharePoint uses inline).
    if (file.sharepoint_source_id) {
      const { data, error } = await supabase.functions.invoke('get-sharepoint-download-url', {
        body: { fileId: file.id, mode: 'preview' },
      })
      const url = (data as { url?: string; downloadUrl?: string } | null)?.url
        ?? (data as { downloadUrl?: string } | null)?.downloadUrl
      if (error || !url) {
        alert("Couldn't load preview for this file. " + (error?.message ?? ''))
        return
      }
      setPreviewing({ file, url })
      return
    }
    const { data } = await supabase.storage.from('cportal-project-files').createSignedUrl(file.storage_path, 300)
    if (data?.signedUrl) setPreviewing({ file, url: data.signedUrl })
  }

  // Email the customer that a required document is still missing. Admin only.
  // Clicking the Remind button just queues a confirmation card so the admin
  // doesn't accidentally fire customer emails — the actual send happens in
  // confirmReminder() when they click "Send reminder" in the dialog.
  function sendReminder(documentLabel: string, key: string) {
    if (!id) return
    setPendingReminder({ documentLabel, key })
  }

  async function confirmReminder() {
    if (!id || !pendingReminder) return
    const { documentLabel, key } = pendingReminder
    setPendingReminder(null)
    setReminderState({ key, status: 'sending' })
    try {
      const { error } = await supabase.functions.invoke('send-reminder', {
        body: {
          projectId: id,
          documentLabel,
          documentKey: key,
          recipients: selectedReminderEmails,
          portalUrl: window.location.origin,
        },
      })
      setReminderState({ key, status: error ? 'error' : 'sent' })
      // Optimistically update the "Reminded X ago" label. The edge function
      // logs the actual row server-side; this just avoids a refetch.
      if (!error) {
        setLastReminderByKey(prev => ({ ...prev, [key]: new Date().toISOString() }))
      }
    } catch {
      setReminderState({ key, status: 'error' })
    }
    setTimeout(() => setReminderState(s => (s?.key === key ? null : s)), 4000)
  }

  // Render "by Jane Doe" under a file row.
  function uploaderLabel(file: ProjectFile): string {
    if (!file.uploaded_by) return ''
    const p = uploaderById[file.uploaded_by]
    if (!p) return ''
    return p.full_name || p.email || ''
  }

  // Opens the styled delete-confirmation modal. The actual deletion runs in
  // confirmDeleteFile when the user clicks the red Delete button.
  function handleDeleteFile(file: ProjectFile) {
    setPendingDeleteFile(file)
  }

  async function confirmDeleteFile(file: ProjectFile) {
    setDeletingFileId(file.id)
    await supabase.storage.from('cportal-project-files').remove([file.storage_path])
    await supabase.from('cportal_files').delete().eq('id', file.id)
    setDeletingFileId(null)
    fetchFiles()
  }

  async function updateRetestDue(fileId: string, due: string | null) {
    await supabase.from('cportal_files').update({ retest_due: due }).eq('id', fileId)
    fetchFiles()
  }

  async function addRequirement() {
    const label = newRequirement.trim()
    if (!label || !id) return
    await supabase.from('cportal_document_requests').insert({ project_id: id, label })
    setNewRequirement('')
    fetchDocumentRequests()
  }

  async function deleteRequirement(reqId: string) {
    await supabase.from('cportal_document_requests').delete().eq('id', reqId)
    fetchDocumentRequests()
  }

  async function handleSaveEdit() {
    if (!project) return
    await supabase.from('cportal_projects').update({
      name: editName.trim(),
      description: editDesc.trim() || null,
      updated_at: new Date().toISOString(),
    }).eq('id', project.id)
    setEditing(false)
    fetchProject()
  }

  async function handleAddMember() {
    if (!selectedUserId || !id) return
    await supabase.from('cportal_project_members').insert({ project_id: id, user_id: selectedUserId })
    setShowAddMember(false)
    setSelectedUserId('')
    fetchMembers()
    fetchAvailableProfiles()
  }

  async function handleRemoveMember(memberId: string) {
    setRemovingMemberId(memberId)
    await supabase.from('cportal_project_members').delete().eq('id', memberId)
    setRemovingMemberId(null)
    fetchMembers()
    fetchAvailableProfiles()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  if (!project) return null

  // Tabs are role-aware:
  //   admin       → everything (members + invoices + admin reminders)
  //   customer    → everything except members tab
  //   service_tech → logistics view: documents, drawings, certs, notes.
  //                  No invoices (billing isn't their concern), no members tab.
  const tabList: TabKey[] = isAdmin
    ? ['documents', 'drawings', 'certificates', 'invoices', 'notes', 'members']
    : isServiceTech
      ? ['documents', 'drawings', 'certificates', 'notes']
      : ['documents', 'drawings', 'certificates', 'invoices', 'notes']

  const certificates = files.filter(f => f.kind === 'certificate')
  const equipmentCertificates = files.filter(f => f.kind === 'equipment_certificate')
  const drawings = files.filter(f => f.kind === 'drawing')
  const poFile = files.find(f => f.kind === 'purchase_order')
  const quotes = files.filter(f => f.kind === 'quote')
  const generalDocs = files.filter(f =>
    f.kind !== 'certificate' && f.kind !== 'equipment_certificate' && f.kind !== 'drawing' && f.kind !== 'purchase_order' && f.kind !== 'quote' && !f.document_request_id
  )
  const fileByRequirement = new Map<string, ProjectFile>()
  for (const f of files) {
    if (f.document_request_id && !fileByRequirement.has(f.document_request_id)) {
      fileByRequirement.set(f.document_request_id, f)
    }
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Shared hidden file input for all uploads */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileInput} />

      <Link to="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-6 transition-colors">
        <ArrowLeft size={16} />
        Back to Dashboard
      </Link>

      {/* Project header */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-6">
        {editing ? (
          <div className="space-y-3">
            <input
              value={editName}
              onChange={e => setEditName(e.target.value)}
              className="w-full text-xl font-bold text-gray-900 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <textarea
              value={editDesc}
              onChange={e => setEditDesc(e.target.value)}
              rows={2}
              className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Description..."
            />
            <div className="flex gap-2">
              <button onClick={handleSaveEdit} className="flex items-center gap-1 bg-blue-600 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-blue-700 transition-colors">
                <Check size={14} /> Save
              </button>
              <button onClick={() => setEditing(false)} className="flex items-center gap-1 border border-gray-300 text-gray-700 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-50 transition-colors">
                <X size={14} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">{project.name}</h1>
              {(project.customer?.company || project.customer?.name) && (
                <p className="text-blue-600 text-sm font-medium mb-1">{project.customer?.company || project.customer?.name}</p>
              )}
              {project.description && <p className="text-gray-500">{project.description}</p>}
              <p className="text-gray-400 text-sm mt-2">
                Last updated {formatDate(project.updated_at)}
                {autoSyncing ? (
                  <span className="ml-3 inline-flex items-center gap-1.5 text-blue-600">
                    <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                    Checking SharePoint for new files…
                  </span>
                ) : lastSyncFailed ? (
                  <span
                    className="ml-3 inline-flex items-center gap-1.5 text-amber-700"
                    title="The portal couldn't reach SharePoint on the last try. Refresh the page to retry, or check the Supabase function logs if this keeps happening."
                  >
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                    SharePoint sync failed — refresh to retry
                  </span>
                ) : lastSyncedAt ? (
                  <span className="ml-3 inline-flex items-center gap-1.5 text-gray-500">
                    <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                    SharePoint synced at {lastSyncedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                ) : null}
              </p>
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => setEditing(true)} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 border border-gray-200 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-50 transition-colors">
                  <Edit2 size={14} /> Edit
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Project scope (synced from SharePoint Lead List) */}
      {project.lead_comments && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Project scope</h2>
          <p className="text-gray-700 text-sm whitespace-pre-wrap">{project.lead_comments}</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-lg w-fit">
        {tabList.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${
              activeTab === tab ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Documents tab */}
      {activeTab === 'documents' && (
        <div className="space-y-6">
          {/* Required documents checklist */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center gap-2 p-5 border-b border-gray-100">
              <ClipboardList size={18} className="text-gray-400" />
              <h2 className="font-semibold text-gray-900">Required documents</h2>
            </div>

            <div className="divide-y divide-gray-50">
              {/* Purchase order — always required */}
              <div className="px-5 py-3.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    {poFile
                      ? <Check size={18} className="text-green-600 flex-shrink-0" />
                      : <div className="w-[18px] h-[18px] rounded-full border-2 border-gray-300 flex-shrink-0" />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        Purchase order <span className="text-xs font-normal text-gray-400">· required</span>
                      </p>
                      {poFile
                        ? <div className="text-xs text-gray-400 truncate">
                            <span className="truncate">{poFile.name} · {formatDate(poFile.source_created_at || poFile.created_at)}</span>
                            {uploaderLabel(poFile) && <span> · by {uploaderLabel(poFile)}</span>}
                            {isAdmin && poFile.sharepoint_synced_at && poFile.sharepoint_path === 'emailed-to-sales' && (
                              <span className="ml-1.5 text-amber-700">
                                · Emailed to sales team (no folder match yet)
                              </span>
                            )}
                            {isAdmin && poFile.sharepoint_synced_at && poFile.sharepoint_path !== 'emailed-to-sales' && (
                              <span className="ml-1.5 text-green-700">
                                · <Check size={11} className="inline -mt-0.5" /> Saved to SharePoint
                              </span>
                            )}
                            {isAdmin && !poFile.sharepoint_synced_at && poFile.sharepoint_error && (
                              <span
                                className="ml-1.5 text-red-600"
                                title={poFile.sharepoint_error}
                              >
                                · SharePoint sync failed (hover for details)
                              </span>
                            )}
                          </div>
                        : <p className="text-xs text-amber-600">
                            Awaiting upload
                            {isAdmin && lastReminderByKey['po'] && (
                              <span className="text-gray-400 font-normal ml-1.5">· Reminded {formatRelativeTime(lastReminderByKey['po'])}</span>
                            )}
                          </p>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                    {poFile && (
                      <>
                        <button onClick={() => previewFile(poFile)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Preview">
                          <Eye size={16} />
                        </button>
                        <button onClick={() => handleDownload(poFile)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                          <Download size={16} />
                        </button>
                      </>
                    )}
                    {!poFile && isAdmin && (
                      <button
                        onClick={() => sendReminder('Purchase order', 'po')}
                        disabled={reminderState?.key === 'po' && reminderState.status === 'sending'}
                        className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-blue-600 px-2 py-1 disabled:opacity-50"
                        title="Send reminder email"
                      >
                        {reminderState?.key === 'po' && reminderState.status === 'sent'
                          ? <><Check size={13} /> Sent</>
                          : <><Send size={13} /> Remind</>}
                      </button>
                    )}
                    <button
                      onClick={() => poFile ? handleDeleteFile(poFile) : triggerUpload({ kind: 'purchase_order', requirementId: null })}
                      disabled={uploading}
                      className={`text-xs font-semibold px-2 py-1 disabled:opacity-50 ${poFile ? 'text-red-600 hover:text-red-700' : 'text-blue-600 hover:text-blue-700'} ${!canUpload ? 'hidden' : ''}`}
                    >
                      {poFile ? 'Delete' : 'Upload'}
                    </button>
                  </div>
                </div>

                {/* AI Purchase-Order review (admin only) */}
                {poFile && isAdmin && (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    {poReview ? (
                      <div className="bg-gradient-to-br from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-3">
                        <div className="flex items-start gap-2.5">
                          <div className="w-6 h-6 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0 mt-0.5">
                            <Sparkles size={12} className="text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-baseline justify-between gap-2 mb-1">
                              <p className="text-xs font-semibold text-purple-900">AI review</p>
                              <span className="text-[10px] text-gray-500">{formatRelativeTime(poReview.reviewed_at)}</span>
                            </div>
                            {poReview.summary && (
                              <p className="text-sm text-gray-700 mb-2 leading-relaxed">{poReview.summary}</p>
                            )}
                            {poReview.concerns.length > 0 && (
                              <div className="bg-amber-50 border border-amber-200 rounded-md p-2.5 mb-2">
                                <p className="text-xs font-semibold text-amber-800 mb-1.5">Things to check ({poReview.concerns.length})</p>
                                <ul className="text-xs text-amber-900 space-y-1 list-disc list-inside marker:text-amber-600">
                                  {poReview.concerns.map((c, i) => <li key={i}>{c}</li>)}
                                </ul>
                              </div>
                            )}
                            <div className="flex items-center gap-3 mt-2">
                              <button
                                onClick={() => analyzePO(poFile.id)}
                                disabled={analyzingPO}
                                className="text-xs font-medium text-purple-700 hover:text-purple-900 disabled:opacity-50 transition-colors"
                              >
                                {analyzingPO ? 'Re-analyzing…' : 'Re-analyze'}
                              </button>
                              {poReview.extracted_fields && Object.keys(poReview.extracted_fields).length > 0 && (
                                <button
                                  onClick={() => setShowExtracted(s => !s)}
                                  className="text-xs text-gray-500 hover:text-gray-700"
                                >
                                  {showExtracted ? 'Hide extracted fields' : 'Show extracted fields'}
                                </button>
                              )}
                            </div>
                            {showExtracted && poReview.extracted_fields && (
                              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs bg-white border border-gray-200 rounded p-2">
                                {Object.entries(poReview.extracted_fields).map(([k, v]) => (
                                  <div key={k} className="min-w-0">
                                    <span className="text-gray-500 capitalize">{k.replace(/_/g, ' ')}:</span>{' '}
                                    <span className="text-gray-900 break-words">{v != null && v !== '' ? String(v) : '—'}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {analyzeError && <p className="text-xs text-red-600 mt-2">{analyzeError}</p>}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between gap-3 bg-gray-50 border border-gray-200 rounded-lg p-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <Sparkles size={14} className="text-purple-600 flex-shrink-0" />
                          <p className="text-xs text-gray-600 truncate">Use AI to summarize and check this PO.</p>
                        </div>
                        <button
                          onClick={() => analyzePO(poFile.id)}
                          disabled={analyzingPO}
                          className="bg-purple-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-purple-700 disabled:opacity-50 transition-colors flex-shrink-0 flex items-center gap-1.5"
                        >
                          <Sparkles size={12} />
                          {analyzingPO ? 'Analyzing…' : 'Analyze with AI'}
                        </button>
                      </div>
                    )}
                    {analyzeError && !poReview && <p className="text-xs text-red-600 mt-2">{analyzeError}</p>}
                  </div>
                )}
              </div>

              {/* Admin-defined required documents. Hidden from service techs
                  — they don't deal with the missing-docs workflow. */}
              {!isServiceTech && documentRequests.map(req => {
                const f = fileByRequirement.get(req.id)
                const reminderKey = `req-${req.id}`
                return (
                  <div key={req.id} className="flex items-center justify-between px-5 py-3.5">
                    <div className="flex items-center gap-3 min-w-0">
                      {f
                        ? <Check size={18} className="text-green-600 flex-shrink-0" />
                        : <div className="w-[18px] h-[18px] rounded-full border-2 border-gray-300 flex-shrink-0" />}
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{req.label}</p>
                        {f
                          ? <p className="text-xs text-gray-400 truncate">
                              {f.name} · {formatDate(f.source_created_at || f.created_at)}
                              {uploaderLabel(f) && ` · by ${uploaderLabel(f)}`}
                            </p>
                          : <p className="text-xs text-amber-600">
                              Awaiting upload
                              {isAdmin && lastReminderByKey[reminderKey] && (
                                <span className="text-gray-400 font-normal ml-1.5">· Reminded {formatRelativeTime(lastReminderByKey[reminderKey])}</span>
                              )}
                            </p>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                      {f && (
                        <>
                          <button onClick={() => previewFile(f)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Preview">
                            <Eye size={16} />
                          </button>
                          <button onClick={() => handleDownload(f)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                            <Download size={16} />
                          </button>
                        </>
                      )}
                      {!f && isAdmin && (
                        <button
                          onClick={() => sendReminder(req.label, reminderKey)}
                          disabled={reminderState?.key === reminderKey && reminderState.status === 'sending'}
                          className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-blue-600 px-2 py-1 disabled:opacity-50"
                          title="Send reminder email"
                        >
                          {reminderState?.key === reminderKey && reminderState.status === 'sent'
                            ? <><Check size={13} /> Sent</>
                            : <><Send size={13} /> Remind</>}
                        </button>
                      )}
                      <button
                        onClick={() => f ? handleDeleteFile(f) : triggerUpload({ kind: 'general', requirementId: req.id })}
                        disabled={uploading}
                        className={`text-xs font-semibold px-2 py-1 disabled:opacity-50 ${f ? 'text-red-600 hover:text-red-700' : 'text-blue-600 hover:text-blue-700'}`}
                      >
                        {f ? 'Delete' : 'Upload'}
                      </button>
                      {isAdmin && (
                        <button onClick={() => deleteRequirement(req.id)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Remove requirement">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {isAdmin && (
              <div className="flex gap-2 p-4 border-t border-gray-100">
                <input
                  value={newRequirement}
                  onChange={e => setNewRequirement(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addRequirement()}
                  placeholder="e.g. Method statement"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button onClick={addRequirement} disabled={!newRequirement.trim()} className="flex items-center gap-1 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  <Plus size={15} /> Add
                </button>
              </div>
            )}
          </div>

          {/* Quotes — synced from SharePoint, PDF only */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <div>
                <h2 className="font-semibold text-gray-900">Quotes &amp; proposals</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {isAdmin
                    ? 'Synced from this project\'s SharePoint Quote folder (PDFs only). Auto-syncs on every page load.'
                    : 'Proposal PDFs from Hydro-Wates for this project.'}
                </p>
              </div>
            </div>

            {quotes.length === 0 ? (
              <div className="text-center py-14">
                <FileText className="mx-auto text-gray-300 mb-3" size={40} />
                <p className="text-gray-500 text-sm font-medium">No quotes yet</p>
                <p className="text-gray-400 text-xs mt-1">
                  {isAdmin
                    ? 'Quote PDFs at the project root in SharePoint will sync here automatically. Refresh the page to retry.'
                    : 'Your proposal will appear here once Hydro-Wates sends it.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {quotes.map(file => (
                  <div key={file.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <button onClick={() => previewFile(file)} className="flex items-center gap-3 min-w-0 text-left flex-1">
                      <div className="w-9 h-9 bg-purple-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <FileText size={16} className="text-purple-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate hover:text-blue-600 transition-colors">{file.name}</p>
                        <p className="text-xs text-gray-400">
                          {formatBytes(file.size)} · {formatDate(file.source_created_at || file.created_at)}
                          {isAdmin && file.sharepoint_source_id && <span> · from SharePoint</span>}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                      <button onClick={() => previewFile(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Preview">
                        <Eye size={16} />
                      </button>
                      <button onClick={() => handleDownload(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                        <Download size={16} />
                      </button>
                      {isAdmin && (
                        <button onClick={() => handleDeleteFile(file)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Other documents */}
          <div
            onDragOver={e => { e.preventDefault(); setDragZone('general') }}
            onDragLeave={() => setDragZone(null)}
            onDrop={e => { e.preventDefault(); setDragZone(null); const fs = Array.from(e.dataTransfer.files); if (fs.length) startUpload(fs, { kind: 'general', requirementId: null }) }}
            className={`bg-white border rounded-xl transition-colors ${dragZone === 'general' ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200'}`}
          >
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Other documents</h2>
              <button
                onClick={() => triggerUpload({ kind: 'general', requirementId: null })}
                disabled={uploading}
                className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Upload size={15} />
                {uploading ? 'Uploading...' : 'Select files'}
              </button>
            </div>

            {uploadError && (
              <div className="mx-5 mt-4 bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{uploadError}</div>
            )}

            {generalDocs.length === 0 ? (
              <div className="text-center py-14">
                <FileText className="mx-auto text-gray-300 mb-3" size={40} />
                <p className="text-gray-500 text-sm font-medium">No other documents</p>
                <p className="text-gray-400 text-xs mt-1">Click "Select files" or drag files here</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {generalDocs.map(file => (
                  <div key={file.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <button onClick={() => previewFile(file)} className="flex items-center gap-3 min-w-0 text-left flex-1">
                      <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <FileText size={16} className="text-blue-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate hover:text-blue-600 transition-colors">{file.name}</p>
                        <p className="text-xs text-gray-400">
                          {formatBytes(file.size)} · {formatDate(file.source_created_at || file.created_at)}
                          {uploaderLabel(file) && ` · by ${uploaderLabel(file)}`}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                      <button onClick={() => previewFile(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Preview">
                        <Eye size={16} />
                      </button>
                      <button onClick={() => handleDownload(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                        <Download size={16} />
                      </button>
                      {(isAdmin || file.uploaded_by === user?.id) && (
                        <button onClick={() => handleDeleteFile(file)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Drawings tab */}
      {activeTab === 'drawings' && (
        <div
          onDragOver={e => { e.preventDefault(); setDragZone('drawing') }}
          onDragLeave={() => setDragZone(null)}
          onDrop={e => { e.preventDefault(); setDragZone(null); const fs = Array.from(e.dataTransfer.files); if (fs.length) startUpload(fs, { kind: 'drawing', requirementId: null }) }}
          className={`bg-white border rounded-xl transition-colors ${dragZone === 'drawing' ? 'border-blue-400 ring-2 ring-blue-200' : 'border-gray-200'}`}
        >
          <div className="flex items-center justify-between p-5 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Drawings</h2>
            <button
              onClick={() => triggerUpload({ kind: 'drawing', requirementId: null })}
              disabled={uploading}
              className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <Upload size={15} />
              {uploading ? 'Uploading...' : 'Upload drawings'}
            </button>
          </div>

          {uploadError && (
            <div className="mx-5 mt-4 bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{uploadError}</div>
          )}

          {drawings.length === 0 ? (
            <div className="text-center py-14">
              <FileText className="mx-auto text-gray-300 mb-3" size={40} />
              <p className="text-gray-500 text-sm font-medium">No drawings yet</p>
              <p className="text-gray-400 text-xs mt-1">Click "Upload drawings" or drag files here</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {drawings.map(file => (
                <div key={file.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                  <button onClick={() => previewFile(file)} className="flex items-center gap-3 min-w-0 text-left flex-1">
                    <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <FileText size={16} className="text-blue-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate hover:text-blue-600 transition-colors">{file.name}</p>
                      <p className="text-xs text-gray-400">
                        {formatBytes(file.size)} · {formatDate(file.source_created_at || file.created_at)}
                        {uploaderLabel(file) && ` · by ${uploaderLabel(file)}`}
                      </p>
                    </div>
                  </button>
                  <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                    <button onClick={() => previewFile(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Preview">
                      <Eye size={16} />
                    </button>
                    <button onClick={() => handleDownload(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                      <Download size={16} />
                    </button>
                    {(isAdmin || file.uploaded_by === user?.id) && (
                      <button onClick={() => handleDeleteFile(file)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Certificates tab */}
      {activeTab === 'certificates' && (() => {
        // Same row layout for both sections — extracted to avoid duplicating
        // ~45 lines of JSX. Uses the project page's existing helpers
        // (previewFile, handleDownload, updateRetestDue, etc.) via closure.
        const renderCertRow = (file: ProjectFile) => {
          const due = retestInfo(file.retest_due)
          return (
            <div key={file.id} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors">
              <button onClick={() => previewFile(file)} className="flex items-center gap-3 min-w-0 text-left">
                <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Award size={16} className="text-green-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate hover:text-blue-600 transition-colors">{file.name}</p>
                  <p className="text-xs text-gray-400">
                    {formatBytes(file.size)} · {formatDate(file.source_created_at || file.created_at)}
                    {uploaderLabel(file) && ` · by ${uploaderLabel(file)}`}
                  </p>
                </div>
              </button>
              <div className="flex items-center gap-3 flex-shrink-0">
                {isAdmin ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-gray-400 hidden sm:inline">Re-test due</span>
                    <input
                      type="date"
                      value={file.retest_due ?? ''}
                      onChange={e => updateRetestDue(file.id, e.target.value || null)}
                      className="border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                ) : (
                  file.retest_due && <span className="text-xs text-gray-500 whitespace-nowrap">Re-test due {formatDate(file.retest_due)}</span>
                )}
                {due && (
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${due.color}`}>{due.label}</span>
                )}
                <button onClick={() => previewFile(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Preview">
                  <Eye size={16} />
                </button>
                <button onClick={() => handleDownload(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                  <Download size={16} />
                </button>
                {isAdmin && (
                  <button onClick={() => handleDeleteFile(file)} className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors" title="Delete">
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          )
        }

        // Ship-to address. The SharePoint Lead List ("addressshipto") is the
        // authoritative source — Zoho Books shipping addresses are unreliable —
        // so prefer the project's synced ship_to_address and fall back to the
        // customer's Zoho shipping fields only when the Lead List has none.
        const ship = project?.customer
        const leadShipTo = (project?.ship_to_address ?? '').trim()
        const hasLeadShipTo = !!leadShipTo
        const hasShipAddr = !!(ship && (ship.shipping_address || ship.shipping_city || ship.shipping_state || ship.shipping_zip))
        const cityStateZip = ship
          ? [
              [ship.shipping_city, ship.shipping_state].filter(Boolean).join(', '),
              ship.shipping_zip,
            ].filter(Boolean).join(' ').trim()
          : ''

        return (
          <div className="space-y-5">
            {/* --- Ship-to address (read-only). Prefers the SharePoint Lead
                 List ("addressshipto"); falls back to the Zoho customer address. --- */}
            <div className="bg-white border border-gray-200 rounded-xl p-5">
              <div className="flex items-start gap-3">
                <MapPin size={18} className="text-gray-400 mt-1 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h3 className="text-sm font-semibold text-gray-900">Ship to</h3>
                    <span className="text-[10px] uppercase tracking-wide text-gray-400">{hasLeadShipTo ? 'From Lead List' : 'From Zoho Books'}</span>
                  </div>
                  {hasLeadShipTo ? (
                    <address className="text-sm text-gray-700 not-italic leading-relaxed">
                      {ship?.company && (
                        <div className="font-medium text-gray-900">{ship.company}</div>
                      )}
                      {ship?.name && ship.name !== ship.company && (
                        <div className="text-gray-700">{ship.name}</div>
                      )}
                      <div className="whitespace-pre-line">{leadShipTo}</div>
                    </address>
                  ) : hasShipAddr ? (
                    <address className="text-sm text-gray-700 not-italic leading-relaxed">
                      {ship?.company && (
                        <div className="font-medium text-gray-900">{ship.company}</div>
                      )}
                      {ship?.name && ship.name !== ship.company && (
                        <div className="text-gray-700">{ship.name}</div>
                      )}
                      {ship?.shipping_address && <div>{ship.shipping_address}</div>}
                      {cityStateZip && <div>{cityStateZip}</div>}
                      {ship?.shipping_country && (
                        <div className="text-gray-500">{ship.shipping_country}</div>
                      )}
                    </address>
                  ) : (
                    <p className="text-sm text-gray-500">
                      {isAdmin
                        ? 'No shipping address on file yet. Set the customer\'s shipping address in Zoho Books — it\'ll appear here after the next sync.'
                        : 'No shipping address on file. Contact Hydro-Wates to confirm where you want certificates shipped.'}
                    </p>
                  )}

                  {/* Site contact — pulled from the SharePoint Lead List
                      (ContactNameOnSite + ContactPhoneOnSite). Service-tech
                      view only; admins/customers don't need this on the
                      project page. */}
                  {isServiceTech && (project?.site_contact || project?.site_contact_phone) && (
                    <div className="mt-4 pt-4 border-t border-gray-100">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <User size={13} className="text-gray-400" />
                        <span className="text-[10px] uppercase tracking-wide text-gray-500 font-medium">Site contact</span>
                      </div>
                      {project?.site_contact && (
                        <p className="text-sm font-medium text-gray-900">{project.site_contact}</p>
                      )}
                      {project?.site_contact_phone && (
                        <a
                          href={`tel:${project.site_contact_phone.replace(/[^+\d]/g, '')}`}
                          className="inline-flex items-center gap-1.5 mt-1.5 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 rounded-lg px-3 py-1.5 transition-colors"
                        >
                          <Phone size={13} />
                          {project.site_contact_phone}
                        </a>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* --- Test certificates & reports --- */}
            <div className="bg-white border border-gray-200 rounded-xl">
              <div className="flex items-center justify-between p-5 border-b border-gray-100">
                <h2 className="font-semibold text-gray-900">Certificates &amp; reports</h2>
                {isAdmin && (
                  <button
                    onClick={() => triggerUpload({ kind: 'certificate', requirementId: null })}
                    disabled={uploading}
                    className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Upload size={15} />
                    {uploading ? 'Uploading...' : 'Upload certificate'}
                  </button>
                )}
              </div>

              {uploadError && (
                <div className="mx-5 mt-4 bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{uploadError}</div>
              )}

              {certificates.length === 0 ? (
                <div className="text-center py-14">
                  <Award className="mx-auto text-gray-300 mb-3" size={40} />
                  <p className="text-gray-500 text-sm font-medium">No certificates yet</p>
                  <p className="text-gray-400 text-xs mt-1">
                    {isAdmin ? 'Upload the proof-load test report here when it\'s ready.' : 'Your test reports will appear here once issued.'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {certificates.map(renderCertRow)}
                </div>
              )}
            </div>

            {/* --- Equipment certificates --- */}
            <div className="bg-white border border-gray-200 rounded-xl">
              <div className="flex items-center justify-between p-5 border-b border-gray-100">
                <h2 className="font-semibold text-gray-900">Equipment certificates</h2>
                {isAdmin && (
                  <button
                    onClick={() => triggerUpload({ kind: 'equipment_certificate', requirementId: null })}
                    disabled={uploading}
                    className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                  >
                    <Upload size={15} />
                    {uploading ? 'Uploading...' : 'Upload equipment cert'}
                  </button>
                )}
              </div>

              {equipmentCertificates.length === 0 ? (
                <div className="text-center py-14">
                  <Award className="mx-auto text-gray-300 mb-3" size={40} />
                  <p className="text-gray-500 text-sm font-medium">No equipment certificates yet</p>
                  <p className="text-gray-400 text-xs mt-1">
                    {isAdmin
                      ? 'Calibration certs, inspection reports, manufacturer documentation — anything specific to a piece of equipment.'
                      : 'Equipment certificates for any gear on this project will appear here.'}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {equipmentCertificates.map(renderCertRow)}
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Invoices tab */}
      {activeTab === 'invoices' && (
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="p-5 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Invoices</h2>
          </div>

          {invoiceError && (
            <div className="mx-5 mt-4 bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{invoiceError}</div>
          )}

          {invoices.length === 0 ? (
            <div className="text-center py-14">
              <Receipt className="mx-auto text-gray-300 mb-3" size={40} />
              <p className="text-gray-500 text-sm font-medium">No invoices yet</p>
              <p className="text-gray-400 text-xs mt-1">Invoices synced from Zoho Books will appear here</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {invoices.map(inv => (
                <button
                  key={inv.id}
                  type="button"
                  onClick={() => viewInvoice(inv)}
                  disabled={openingInvoice === inv.id}
                  title="View invoice PDF"
                  className="w-full text-left flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors disabled:opacity-60"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Receipt size={16} className="text-blue-500" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{inv.invoice_number || 'Invoice'}</p>
                      <p className="text-xs text-gray-400">
                        {inv.invoice_date ? formatDate(inv.invoice_date) : '—'}
                        {inv.due_date ? ` · due ${formatDate(inv.due_date)}` : ''}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 ml-4 flex-shrink-0">
                    <div className="text-right">
                      <p className="text-sm font-medium text-gray-900">{formatMoney(inv.total, inv.currency_code)}</p>
                      {inv.balance != null && inv.balance > 0 && inv.status !== 'void' && inv.status !== 'draft' && (
                        <p className="text-xs text-gray-400">{formatMoney(inv.balance, inv.currency_code)} due</p>
                      )}
                    </div>
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full capitalize ${invoiceStatusColor(inv.status)}`}>
                      {inv.status ? inv.status.replace(/_/g, ' ') : '—'}
                    </span>
                    {openingInvoice === inv.id
                      ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
                      : <ExternalLink size={16} className="text-gray-400" />}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Notes tab (visible to admins + project members) */}
      {activeTab === 'notes' && (
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="p-5 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Notes</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Headroom, water source, site access — anything everyone working on this project should know. Both sides can see and edit.
              {(isAdmin || isServiceTech) && (
                <> Use <span className="font-medium text-gray-700">Private</span> notes for team-only context — those stay hidden from the customer.</>
              )}
            </p>
          </div>

          {/* Compose */}
          <div className="p-5 border-b border-gray-100">
            <textarea
              value={newNoteContent}
              onChange={e => setNewNoteContent(e.target.value)}
              placeholder={
                newNoteInternal
                  ? 'Private note — visible to admins and service techs only…'
                  : 'Add a note (everyone on this project sees it)…'
              }
              rows={3}
              className={`w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 ${
                newNoteInternal
                  ? 'border-amber-300 bg-amber-50/40 focus:ring-amber-500'
                  : 'border-gray-300 focus:ring-blue-500'
              }`}
            />
            {noteError && <p className="text-red-600 text-xs mt-1">{noteError}</p>}
            <div className="flex items-center justify-between gap-3 mt-2 flex-wrap">
              {(isAdmin || isServiceTech) ? (
                <label className="inline-flex items-center gap-2 text-xs text-gray-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={newNoteInternal}
                    onChange={e => setNewNoteInternal(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                  />
                  <Lock size={12} className="text-amber-600" />
                  <span>Private note <span className="text-gray-400">(techs &amp; admins only)</span></span>
                </label>
              ) : <span />}
              <button
                onClick={addNote}
                disabled={addingNote || !newNoteContent.trim()}
                className={`px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 transition-colors ${
                  newNoteInternal ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {addingNote ? 'Saving…' : newNoteInternal ? 'Post private note' : 'Add note'}
              </button>
            </div>
          </div>

          {/* Split into Private (team-only) and Shared sections so it's
              obvious at a glance who can see what. Customers don't get the
              Private header since RLS already hides those notes from them. */}
          {(() => {
            const privateNotes = notes.filter(n => n.internal)
            const sharedNotes = notes.filter(n => !n.internal)
            const isTeamMember = isAdmin || isServiceTech

            const renderNote = (n: ProjectNote) => {
              const isOwn = n.author_id === user?.id
              const isEditing = editingNoteId === n.id
              const authorRole = n.author?.role
              const isAdminAuthor = authorRole === 'admin'
              const isTechAuthor = authorRole === 'service_tech'
              const isTeamAuthor = isAdminAuthor || isTechAuthor
              const authorName = n.author?.full_name || n.author?.email || 'Unknown'
              const initial = (n.author?.full_name?.[0] ?? n.author?.email?.[0] ?? '?').toUpperCase()
              return (
                <div key={n.id} className={`px-5 py-4 ${n.internal ? 'bg-amber-50/30 border-l-4 border-amber-400' : ''}`}>
                    <div className="flex items-start gap-3">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-semibold ${isTeamAuthor ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                        {initial}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap mb-0.5">
                          <span className="text-sm font-medium text-gray-900">{authorName}</span>
                          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium ${isTeamAuthor ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                            {isTechAuthor ? 'Service Tech' : isAdminAuthor ? 'Hydro-Wates' : 'Customer'}
                          </span>
                          {n.internal && (
                            <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium bg-amber-100 text-amber-800">
                              <Lock size={10} />
                              Private
                            </span>
                          )}
                          <span className="text-xs text-gray-400">{formatRelativeTime(n.created_at)}</span>
                          {n.updated_at !== n.created_at && (
                            <span className="text-xs text-gray-400">· edited</span>
                          )}
                        </div>
                        {isEditing ? (
                          <div className="mt-2">
                            <textarea
                              value={editingNoteContent}
                              onChange={e => setEditingNoteContent(e.target.value)}
                              rows={3}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                            <div className="flex gap-2 mt-2 justify-end">
                              <button
                                onClick={() => { setEditingNoteId(null); setEditingNoteContent(''); setNoteError('') }}
                                className="text-xs text-gray-600 hover:text-gray-900 px-3 py-1.5"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => saveEditedNote(n.id)}
                                disabled={!editingNoteContent.trim()}
                                className="bg-blue-600 text-white px-3 py-1.5 rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-700 whitespace-pre-wrap">{n.content}</p>
                        )}
                      </div>
                      {!isEditing && (isOwn || isAdmin) && (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {isOwn && (
                            <button
                              onClick={() => { setEditingNoteId(n.id); setEditingNoteContent(n.content); setNoteError('') }}
                              className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                              title="Edit"
                            >
                              <Edit2 size={13} />
                            </button>
                          )}
                          <button
                            onClick={() => deleteNote(n.id)}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
            }

            return (
              <>
                {/* Private notes section — team members only */}
                {isTeamMember && (
                  <div>
                    <div className="flex items-center gap-2 px-5 py-3 bg-amber-50/60 border-b border-amber-100">
                      <Lock size={13} className="text-amber-700" />
                      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-800">Private notes</h3>
                      <span className="text-[11px] text-amber-700/80">· team only</span>
                      <span className="ml-auto text-[11px] text-amber-700/80">{privateNotes.length}</span>
                    </div>
                    {privateNotes.length === 0 ? (
                      <div className="px-5 py-6 text-center">
                        <p className="text-xs text-gray-400">No private notes yet — these stay hidden from the customer.</p>
                      </div>
                    ) : (
                      <div className="divide-y divide-gray-50">
                        {privateNotes.map(renderNote)}
                      </div>
                    )}
                  </div>
                )}

                {/* Shared notes section — visible to everyone */}
                <div>
                  <div className="flex items-center gap-2 px-5 py-3 bg-gray-50 border-b border-gray-100">
                    <MessageSquare size={13} className="text-gray-600" />
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-gray-700">Project notes</h3>
                    <span className="text-[11px] text-gray-500">· everyone on this project</span>
                    <span className="ml-auto text-[11px] text-gray-500">{sharedNotes.length}</span>
                  </div>
                  {sharedNotes.length === 0 ? (
                    <div className="text-center py-12">
                      <MessageSquare className="mx-auto text-gray-300 mb-3" size={36} />
                      <p className="text-gray-500 text-sm font-medium">No notes yet</p>
                      <p className="text-gray-400 text-xs mt-1">
                        {isTeamMember
                          ? 'Add one above — the customer will get an email.'
                          : 'Be the first to add one — Hydro-Wates will get an email.'}
                      </p>
                    </div>
                  ) : (
                    <div className="divide-y divide-gray-50">
                      {sharedNotes.map(renderNote)}
                    </div>
                  )}
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* Members tab (admin only) */}
      {activeTab === 'members' && isAdmin && (
        <div className="bg-white border border-gray-200 rounded-xl">
          <div className="flex items-center justify-between p-5 border-b border-gray-100">
            <h2 className="font-semibold text-gray-900">Members</h2>
            <button
              onClick={() => setShowAddMember(true)}
              className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              <Plus size={15} />
              Add Member
            </button>
          </div>

          {contactActionMsg && (
            <div className="mx-5 mt-4 text-xs text-gray-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
              {contactActionMsg}
            </div>
          )}

          {/* Unified list: every project member + every Zoho contact at this
              project's company. Status badge + contextual action button per row. */}
          {(() => {
            const memberRows = members.map(m => {
              const p = m.profile as Profile | undefined
              return {
                key: `m:${m.id}`,
                name: p?.full_name ?? null,
                email: p?.email ?? null,
                status: 'member' as const,
                memberId: m.id,
              }
            })
            const memberUserIds = new Set(members.map(m => m.user_id))
            const extraRows = companyContacts
              .filter(c => !(c.userId && memberUserIds.has(c.userId)))
              .map(c => ({
                key: `c:${c.customerId}`,
                name: c.name,
                email: c.email,
                status: c.status,
                userId: c.userId,
                customerId: c.customerId,
              }))
            const rows: Array<{
              key: string
              name: string | null
              email: string | null
              status: 'member' | 'has_account' | 'pending'
              memberId?: string
              userId?: string
              customerId?: string
            }> = [...memberRows, ...extraRows]

            if (rows.length === 0) {
              return (
                <div className="text-center py-14">
                  <Users className="mx-auto text-gray-300 mb-3" size={40} />
                  <p className="text-gray-500 text-sm font-medium">No members yet</p>
                  <p className="text-gray-400 text-xs mt-1">
                    {project?.customer?.company
                      ? `No Zoho contacts found at ${project.customer.company} yet — they'll appear here once synced.`
                      : 'Add customers to give them access.'}
                  </p>
                </div>
              )
            }

            return (
              <div className="divide-y divide-gray-50">
                {rows.map(row => (
                  <div key={row.key} className="flex items-center justify-between px-5 py-3.5 gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-gray-900 truncate">{row.name || row.email || 'Unknown'}</p>
                      {row.name && row.email && (
                        <p className="text-xs text-gray-400 truncate">{row.email}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {row.status === 'member' && (
                        <>
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-green-50 text-green-700 font-medium">Member</span>
                          {row.memberId && (
                            <button
                              onClick={() => setPendingRemoveMember({
                                memberId: row.memberId!,
                                name: row.name,
                                email: row.email,
                              })}
                              disabled={removingMemberId === row.memberId}
                              className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50 transition-colors"
                            >
                              {removingMemberId === row.memberId ? 'Removing…' : 'Remove'}
                            </button>
                          )}
                        </>
                      )}
                      {row.status === 'has_account' && (
                        <>
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">Has account</span>
                          <button
                            onClick={() => setPendingAddMember({
                              customerId: row.customerId!,
                              name: row.name,
                              email: row.email,
                              status: 'has_account',
                              userId: row.userId,
                            })}
                            disabled={contactActionId === row.customerId}
                            className="text-xs font-semibold text-blue-600 hover:text-blue-700 disabled:opacity-50 transition-colors"
                          >
                            {contactActionId === row.customerId ? 'Adding…' : 'Add to project'}
                          </button>
                        </>
                      )}
                      {row.status === 'pending' && (
                        <>
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-medium">Not signed up</span>
                          <button
                            onClick={() => setPendingContactInvite({
                              customerId: row.customerId!,
                              name: row.name,
                              email: row.email,
                              status: 'pending',
                            })}
                            disabled={contactActionId === row.customerId || !row.email}
                            className="text-xs font-semibold text-amber-600 hover:text-amber-700 disabled:opacity-50 transition-colors"
                          >
                            {contactActionId === row.customerId ? 'Adding…' : 'Invite to portal & add'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {/* Inline file preview modal */}
      {previewing && (
        <FilePreviewModal
          file={previewing.file}
          url={previewing.url}
          onClose={() => setPreviewing(null)}
          onDownload={() => handleDownload(previewing.file)}
        />
      )}

      {/* Upload confirmation modal (admin only) */}
      {pendingUpload && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !uploading && setPendingUpload(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Confirm upload</h2>
            <p className="text-sm text-gray-500 mb-4">
              {pendingUpload.files.length === 1
                ? 'Ready to upload 1 file to this project.'
                : `Ready to upload ${pendingUpload.files.length} files to this project.`}
            </p>

            {/* File list */}
            <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5 max-h-40 overflow-auto">
              <ul className="space-y-1.5">
                {pendingUpload.files.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-gray-700 min-w-0">
                    <FileText size={12} className="text-gray-400 flex-shrink-0" />
                    <span className="truncate">{f.name}</span>
                    <span className="text-gray-400 flex-shrink-0 ml-auto">{formatBytes(f.size)}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Notify customer toggle */}
            <div className="flex items-start justify-between gap-4 mb-5 pb-5 border-b border-gray-100">
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">Notify customer?</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  {pendingUpload.notify
                    ? 'An email will be sent to the customer when this uploads.'
                    : 'The customer will not receive an email about this upload.'}
                </p>
              </div>
              <button
                onClick={() => setPendingUpload(p => p ? { ...p, notify: !p.notify } : null)}
                role="switch"
                aria-checked={pendingUpload.notify}
                disabled={uploading}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${pendingUpload.notify ? 'bg-blue-600' : 'bg-gray-300'} disabled:opacity-50`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${pendingUpload.notify ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setPendingUpload(null)}
                disabled={uploading}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const p = pendingUpload
                  await uploadFiles(p.files, p.ctx, p.notify)
                  setPendingUpload(null)
                }}
                disabled={uploading}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {uploading ? 'Uploading…' : 'Confirm upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reminder confirmation modal (admin only) */}
      {pendingReminder && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPendingReminder(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Send reminder?</h2>
            <p className="text-sm text-gray-500 mb-4">
              Reminder about <strong className="font-medium text-gray-700">{pendingReminder.documentLabel}</strong>. Pick who to email:
            </p>

            {/* Recipient picker — customer + each project member, all checked
                by default. Admin can uncheck individuals before sending. */}
            {(() => {
              const potential: { email: string; name: string | null; role: 'customer' | 'member' }[] = []
              if (project?.customer?.email) {
                potential.push({
                  email: project.customer.email,
                  name: project.customer.company || project.customer.name,
                  role: 'customer',
                })
              }
              for (const m of members) {
                const e = m.profile?.email
                if (e && !potential.some(r => r.email.toLowerCase() === e.toLowerCase())) {
                  potential.push({ email: e, name: m.profile?.full_name || null, role: 'member' })
                }
              }
              return (
                <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5 max-h-56 overflow-auto">
                  {potential.length === 0 ? (
                    <p className="text-xs text-gray-500 py-2 text-center">No customer email or members to send to.</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {potential.map(r => {
                        const checked = selectedReminderEmails.includes(r.email)
                        return (
                          <li key={r.email}>
                            <label className="flex items-center gap-2.5 text-xs cursor-pointer hover:bg-gray-100 px-2 py-1.5 rounded">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setSelectedReminderEmails(prev =>
                                  checked ? prev.filter(e => e !== r.email) : [...prev, r.email]
                                )}
                                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                              />
                              <span className="min-w-0 flex-1 truncate">
                                <span className="font-medium text-gray-900">{r.name || r.email}</span>
                                {r.name && <span className="text-gray-400 ml-1.5">{r.email}</span>}
                              </span>
                              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0 ${r.role === 'customer' ? 'bg-blue-50 text-blue-700' : 'bg-gray-100 text-gray-500'}`}>
                                {r.role}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              )
            })()}

            <div className="flex gap-3">
              <button
                onClick={() => setPendingReminder(null)}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmReminder}
                disabled={selectedReminderEmails.length === 0}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Send reminder{selectedReminderEmails.length > 0 ? ` (${selectedReminderEmails.length})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Invite confirmation modal — appears before any company-contact invite fires */}
      {pendingContactInvite && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPendingContactInvite(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Invite to portal & add to project?</h2>
            <p className="text-sm text-gray-500 mb-4">
              We'll send this person a one-time link to set their password, and add them to this project right away. The moment they log in for the first time, this project will already be on their dashboard — no separate acceptance step.
            </p>

            <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5">
              <p className="text-sm font-medium text-gray-900">{pendingContactInvite.name || pendingContactInvite.email || 'Unnamed contact'}</p>
              {pendingContactInvite.email && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">{pendingContactInvite.email}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setPendingContactInvite(null)}
                disabled={contactActionId === pendingContactInvite.customerId}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const target = pendingContactInvite
                  setPendingContactInvite(null)
                  await inviteContact(target)
                }}
                disabled={contactActionId === pendingContactInvite.customerId || !pendingContactInvite.email}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Invite & add
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add-to-project confirmation modal — for contacts who already have a
          portal account. Mirrors the invite-confirmation flow so an
          accidental click can't silently grant access to a project. */}
      {pendingAddMember && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPendingAddMember(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Add to this project?</h2>
            <p className="text-sm text-gray-500 mb-4">
              This person already has a portal account. Adding them will give them access to every file, certificate, invoice, and note on this project the next time they log in. No email is sent.
            </p>

            <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5">
              <p className="text-sm font-medium text-gray-900">{pendingAddMember.name || pendingAddMember.email || 'Unnamed contact'}</p>
              {pendingAddMember.email && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">{pendingAddMember.email}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setPendingAddMember(null)}
                disabled={contactActionId === pendingAddMember.customerId}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const target = pendingAddMember
                  setPendingAddMember(null)
                  await addContactAsMember(target)
                }}
                disabled={contactActionId === pendingAddMember.customerId || !pendingAddMember.userId}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Add to project
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete-file confirmation modal — every Delete button on the page
          routes through here. Replaces the browser's native confirm(). */}
      {pendingDeleteFile && (() => {
        const f = pendingDeleteFile
        const fromSharePoint = !!f.sharepoint_source_id
        const kindLabel = ({
          purchase_order: 'Purchase order',
          quote: 'Quote',
          certificate: 'Certificate',
          equipment_certificate: 'Equipment certificate',
          drawing: 'Drawing',
          general: 'Document',
        } as Record<string, string>)[f.kind ?? 'general'] ?? 'Document'
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPendingDeleteFile(null)}>
            <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
              <h2 className="text-lg font-semibold text-gray-900 mb-1">Delete this file?</h2>
              <p className="text-sm text-gray-500 mb-4">
                This permanently removes the file from the portal. The portal copy can't be recovered.
                {fromSharePoint && (
                  <> The original in SharePoint stays where it is — only the portal copy is removed.</>
                )}
              </p>

              <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5">
                <div className="flex items-start gap-2.5">
                  <FileText size={16} className="text-gray-400 mt-0.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-gray-900 truncate">{f.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {kindLabel} · {formatBytes(f.size)} · {formatDate(f.source_created_at || f.created_at)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setPendingDeleteFile(null)}
                  disabled={deletingFileId === f.id}
                  className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={async () => {
                    const target = f
                    setPendingDeleteFile(null)
                    await confirmDeleteFile(target)
                  }}
                  disabled={deletingFileId === f.id}
                  className="flex-1 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50 transition-colors"
                >
                  {deletingFileId === f.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Remove-member confirmation modal — destructive action, so we always
          confirm. Red button matches the danger of revoking access. */}
      {pendingRemoveMember && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPendingRemoveMember(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Remove from project?</h2>
            <p className="text-sm text-gray-500 mb-4">
              They'll lose access to this project's files, certificates, invoices, and notes immediately. Their portal account stays active — you can re-add them later from the same list. No email is sent.
            </p>

            <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5">
              <p className="text-sm font-medium text-gray-900">{pendingRemoveMember.name || pendingRemoveMember.email || 'Unknown member'}</p>
              {pendingRemoveMember.email && pendingRemoveMember.name && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">{pendingRemoveMember.email}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setPendingRemoveMember(null)}
                disabled={removingMemberId === pendingRemoveMember.memberId}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const target = pendingRemoveMember
                  setPendingRemoveMember(null)
                  await handleRemoveMember(target.memberId)
                }}
                disabled={removingMemberId === pendingRemoveMember.memberId}
                className="flex-1 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add member modal */}
      {showAddMember && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
            <h3 className="font-semibold text-gray-900 mb-4">Add Member</h3>
            {availableProfiles.length === 0 ? (
              <p className="text-gray-500 text-sm">All customers are already members.</p>
            ) : (
              <select
                value={selectedUserId}
                onChange={e => setSelectedUserId(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select a customer...</option>
                {availableProfiles.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}{p.company ? ` (${p.company})` : ''}
                  </option>
                ))}
              </select>
            )}
            <div className="flex gap-3 mt-4">
              <button onClick={() => setShowAddMember(false)} className="flex-1 border border-gray-300 text-gray-700 py-2 rounded-lg text-sm hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={handleAddMember}
                disabled={!selectedUserId}
                className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
