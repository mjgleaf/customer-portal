import { useEffect, useState, useRef, type ChangeEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Upload, Download, Trash2, FileText, Users, Edit2, X, Check, Plus, Receipt, ExternalLink, ClipboardList, Award } from 'lucide-react'
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

const statusColors: Record<Project['status'], string> = {
  active: 'text-green-700 bg-green-100',
  'on-hold': 'text-yellow-700 bg-yellow-100',
  completed: 'text-gray-600 bg-gray-100',
}

const statusLabels: Record<Project['status'], string> = {
  active: 'Active',
  'on-hold': 'On Hold',
  completed: 'Completed',
}

type TabKey = 'documents' | 'certificates' | 'invoices' | 'members'

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const isAdmin = profile?.role === 'admin'
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
  const [activeTab, setActiveTab] = useState<TabKey>('documents')

  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editStatus, setEditStatus] = useState<Project['status']>('active')

  const [showAddMember, setShowAddMember] = useState(false)
  const [selectedUserId, setSelectedUserId] = useState('')

  useEffect(() => {
    if (!id) return
    fetchProject()
    fetchFiles()
    fetchDocumentRequests()
    if (isAdmin) {
      fetchMembers()
      fetchAvailableProfiles()
    }
  }, [id, isAdmin])

  async function fetchProject() {
    const { data } = await supabase.from('projects').select('*, customer:customers(company, name)').eq('id', id).single()
    if (!data) { navigate('/'); return }
    setProject(data)
    setEditName(data.name)
    setEditDesc(data.description ?? '')
    setEditStatus(data.status)
    fetchInvoices(data.customer_id ?? null)
    setLoading(false)
  }

  async function fetchFiles() {
    const { data } = await supabase
      .from('files')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
    setFiles((data ?? []) as ProjectFile[])
  }

  async function fetchDocumentRequests() {
    const { data } = await supabase
      .from('document_requests')
      .select('*')
      .eq('project_id', id)
      .order('created_at', { ascending: true })
    setDocumentRequests((data ?? []) as DocumentRequest[])
  }

  async function fetchInvoices(customerId: string | null) {
    if (!customerId) { setInvoices([]); return }
    const { data } = await supabase
      .from('invoices')
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
      .from('project_members')
      .select('id, project_id, user_id, created_at')
      .eq('project_id', id)
    const list = rows ?? []
    if (list.length === 0) { setMembers([]); return }
    // project_members.user_id points at auth.users, not profiles, so we can't
    // embed the profile directly — fetch profiles separately and merge.
    const { data: profs } = await supabase
      .from('profiles')
      .select('*')
      .in('id', list.map(r => r.user_id))
    const byId = new Map((profs ?? []).map(p => [p.id, p]))
    setMembers(list.map(r => ({ ...r, profile: byId.get(r.user_id) })) as ProjectMember[])
  }

  async function fetchAvailableProfiles() {
    const { data: allProfiles } = await supabase.from('profiles').select('*').eq('role', 'customer')
    const { data: currentMembers } = await supabase.from('project_members').select('user_id').eq('project_id', id)
    const memberIds = new Set(currentMembers?.map(m => m.user_id) ?? [])
    setAvailableProfiles((allProfiles ?? []).filter(p => !memberIds.has(p.id)))
  }

  // --- Uploads (shared input, driven by uploadCtx) ---
  function triggerUpload(ctx: { kind: string; requirementId: string | null }) {
    uploadCtx.current = ctx
    fileInputRef.current?.click()
  }

  async function handleFileInput(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) await uploadFile(file, uploadCtx.current)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function uploadFile(file: File, ctx: { kind: string; requirementId: string | null }) {
    if (!id || !user) return
    setUploading(true)
    setUploadError('')

    const storagePath = `${id}/${Date.now()}_${file.name}`
    const { error: storageError } = await supabase.storage.from('project-files').upload(storagePath, file)
    if (storageError) {
      setUploadError(storageError.message)
      setUploading(false)
      return
    }

    await supabase.from('files').insert({
      project_id: id,
      name: file.name,
      storage_path: storagePath,
      size: file.size,
      mime_type: file.type,
      uploaded_by: user.id,
      kind: ctx.kind,
      document_request_id: ctx.requirementId,
    })

    void supabase.functions.invoke('notify-upload', {
      body: { projectId: id, fileName: file.name, portalUrl: window.location.origin },
    }).catch(() => { /* best-effort */ })

    await fetchFiles()
    setUploading(false)
  }

  async function handleDownload(file: ProjectFile) {
    const { data } = await supabase.storage.from('project-files').createSignedUrl(file.storage_path, 60)
    if (data?.signedUrl) {
      const a = document.createElement('a')
      a.href = data.signedUrl
      a.download = file.name
      a.click()
    }
  }

  async function handleDeleteFile(file: ProjectFile) {
    if (!confirm(`Delete "${file.name}"?`)) return
    await supabase.storage.from('project-files').remove([file.storage_path])
    await supabase.from('files').delete().eq('id', file.id)
    fetchFiles()
  }

  async function addRequirement() {
    const label = newRequirement.trim()
    if (!label || !id) return
    await supabase.from('document_requests').insert({ project_id: id, label })
    setNewRequirement('')
    fetchDocumentRequests()
  }

  async function deleteRequirement(reqId: string) {
    await supabase.from('document_requests').delete().eq('id', reqId)
    fetchDocumentRequests()
  }

  async function handleSaveEdit() {
    if (!project) return
    await supabase.from('projects').update({
      name: editName.trim(),
      description: editDesc.trim() || null,
      status: editStatus,
      updated_at: new Date().toISOString(),
    }).eq('id', project.id)
    setEditing(false)
    fetchProject()
  }

  async function handleAddMember() {
    if (!selectedUserId || !id) return
    await supabase.from('project_members').insert({ project_id: id, user_id: selectedUserId })
    setShowAddMember(false)
    setSelectedUserId('')
    fetchMembers()
    fetchAvailableProfiles()
  }

  async function handleRemoveMember(memberId: string) {
    await supabase.from('project_members').delete().eq('id', memberId)
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

  const tabList: TabKey[] = isAdmin
    ? ['documents', 'certificates', 'invoices', 'members']
    : ['documents', 'certificates', 'invoices']

  const certificates = files.filter(f => f.kind === 'certificate')
  const generalDocs = files.filter(f => f.kind !== 'certificate' && !f.document_request_id)
  const fileByRequirement = new Map<string, ProjectFile>()
  for (const f of files) {
    if (f.document_request_id && !fileByRequirement.has(f.document_request_id)) {
      fileByRequirement.set(f.document_request_id, f)
    }
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Shared hidden file input for all uploads */}
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileInput} />

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
            <select
              value={editStatus}
              onChange={e => setEditStatus(e.target.value as Project['status'])}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="active">Active</option>
              <option value="on-hold">On Hold</option>
              <option value="completed">Completed</option>
            </select>
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
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-2xl font-bold text-gray-900">{project.name}</h1>
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${statusColors[project.status]}`}>
                  {statusLabels[project.status]}
                </span>
              </div>
              {(project.customer?.company || project.customer?.name) && (
                <p className="text-blue-600 text-sm font-medium mb-1">{project.customer?.company || project.customer?.name}</p>
              )}
              {project.description && <p className="text-gray-500">{project.description}</p>}
              <p className="text-gray-400 text-sm mt-2">Last updated {formatDate(project.updated_at)}</p>
            </div>
            {isAdmin && (
              <button onClick={() => setEditing(true)} className="flex items-center gap-2 text-gray-500 hover:text-gray-700 border border-gray-200 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-50 transition-colors">
                <Edit2 size={14} /> Edit
              </button>
            )}
          </div>
        )}
      </div>

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

            {documentRequests.length === 0 ? (
              <div className="px-5 py-6 text-sm text-gray-500">
                {isAdmin ? 'Add the documents you need from this customer below.' : 'No documents have been requested yet.'}
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {documentRequests.map(req => {
                  const f = fileByRequirement.get(req.id)
                  return (
                    <div key={req.id} className="flex items-center justify-between px-5 py-3.5">
                      <div className="flex items-center gap-3 min-w-0">
                        {f
                          ? <Check size={18} className="text-green-600 flex-shrink-0" />
                          : <div className="w-[18px] h-[18px] rounded-full border-2 border-gray-300 flex-shrink-0" />}
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">{req.label}</p>
                          {f
                            ? <p className="text-xs text-gray-400 truncate">{f.name} · {formatDate(f.created_at)}</p>
                            : <p className="text-xs text-amber-600">Awaiting upload</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 ml-4 flex-shrink-0">
                        {f && (
                          <button onClick={() => handleDownload(f)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                            <Download size={16} />
                          </button>
                        )}
                        <button
                          onClick={() => triggerUpload({ kind: 'general', requirementId: req.id })}
                          disabled={uploading}
                          className="text-xs font-semibold text-blue-600 hover:text-blue-700 px-2 py-1 disabled:opacity-50"
                        >
                          {f ? 'Replace' : 'Upload'}
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
            )}

            {isAdmin && (
              <div className="flex gap-2 p-4 border-t border-gray-100">
                <input
                  value={newRequirement}
                  onChange={e => setNewRequirement(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addRequirement()}
                  placeholder="e.g. Rigging drawing"
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button onClick={addRequirement} disabled={!newRequirement.trim()} className="flex items-center gap-1 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  <Plus size={15} /> Add
                </button>
              </div>
            )}
          </div>

          {/* Other documents */}
          <div className="bg-white border border-gray-200 rounded-xl">
            <div className="flex items-center justify-between p-5 border-b border-gray-100">
              <h2 className="font-semibold text-gray-900">Other documents</h2>
              <button
                onClick={() => triggerUpload({ kind: 'general', requirementId: null })}
                disabled={uploading}
                className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Upload size={15} />
                {uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>

            {uploadError && (
              <div className="mx-5 mt-4 bg-red-50 text-red-600 text-sm px-3 py-2 rounded-lg">{uploadError}</div>
            )}

            {generalDocs.length === 0 ? (
              <div className="text-center py-14">
                <FileText className="mx-auto text-gray-300 mb-3" size={40} />
                <p className="text-gray-500 text-sm font-medium">No other documents</p>
                <p className="text-gray-400 text-xs mt-1">Upload drawings, POs, load-test info, etc.</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {generalDocs.map(file => (
                  <div key={file.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <FileText size={16} className="text-blue-500" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                        <p className="text-xs text-gray-400">{formatBytes(file.size)} · {formatDate(file.created_at)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 ml-4 flex-shrink-0">
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

      {/* Certificates tab */}
      {activeTab === 'certificates' && (
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
              {certificates.map(file => (
                <div key={file.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Award size={16} className="text-green-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                      <p className="text-xs text-gray-400">{formatBytes(file.size)} · {formatDate(file.created_at)}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 ml-4 flex-shrink-0">
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
      )}

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
                      {inv.balance != null && inv.balance > 0 && (
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

          {members.length === 0 ? (
            <div className="text-center py-14">
              <Users className="mx-auto text-gray-300 mb-3" size={40} />
              <p className="text-gray-500 text-sm font-medium">No members yet</p>
              <p className="text-gray-400 text-xs mt-1">Add customers to give them access</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {members.map(member => {
                const p = member.profile as Profile | undefined
                return (
                  <div key={member.id} className="flex items-center justify-between px-5 py-3.5">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{p?.full_name || 'Unknown'}</p>
                      <p className="text-xs text-gray-400">{p?.email}</p>
                    </div>
                    <button
                      onClick={() => handleRemoveMember(member.id)}
                      className="text-xs text-red-500 hover:text-red-700 transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                )
              })}
            </div>
          )}
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
