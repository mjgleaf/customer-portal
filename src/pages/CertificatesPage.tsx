import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Award, Download, Eye, Search, FileText, X, MapPin } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { latestEquipmentCerts } from '../lib/equipmentCerts'
import { useAuth } from '../context/AuthContext'
import type { ProjectFile } from '../types'

// All-certificates view across every project the user has access to (RLS
// scopes customers to their own projects automatically; admins see all).
// Mirrors the per-project Certificates tab but flattened, with the project
// name shown per row as a link back to the project page.

type CertCustomer = {
  id: string
  company: string | null
  name: string | null
  shipping_address: string | null
  shipping_city: string | null
  shipping_state: string | null
  shipping_zip: string | null
  shipping_country: string | null
}

type CertWithProject = ProjectFile & {
  project?: {
    id: string
    name: string
    customer?: CertCustomer | null
  } | null
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Re-test badge (overdue / due within 30 days). Hidden otherwise.
function retestInfo(due: string | null | undefined): { label: string; color: string } | null {
  if (!due) return null
  const days = Math.ceil((new Date(due + 'T00:00:00').getTime() - Date.now()) / 86400000)
  if (days < 0) return { label: 'Overdue', color: 'text-red-700 bg-red-100' }
  if (days <= 30) return { label: days === 0 ? 'Due today' : `Due in ${days}d`, color: 'text-amber-700 bg-amber-100' }
  return null
}

function previewKind(file: ProjectFile): 'pdf' | 'image' | 'unsupported' {
  const name = file.name.toLowerCase()
  const mime = (file.mime_type ?? '').toLowerCase()
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name)) return 'image'
  return 'unsupported'
}

export default function CertificatesPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [certs, setCerts] = useState<CertWithProject[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [previewing, setPreviewing] = useState<{ file: ProjectFile; url: string } | null>(null)

  useEffect(() => {
    void fetchCertificates()
  }, [])

  async function fetchCertificates() {
    setLoading(true)
    // RLS scopes the rows automatically: customers see only their projects'
    // certificates; admins see everything. Pull the project's customer
    // shipping fields too so we can show a Ship-to card at the top when
    // every cert in view belongs to the same customer (typical for a
    // customer user — they're tied to a single company).
    const { data } = await supabase
      .from('cportal_files')
      .select('*, project:cportal_projects(id, name, customer:cportal_customers(id, company, name, shipping_address, shipping_city, shipping_state, shipping_zip, shipping_country))')
      .in('kind', ['certificate', 'equipment_certificate'])
      .order('created_at', { ascending: false })
    // Sort client-side by the displayed date so newest-in-SharePoint comes
    // first (falls back to created_at for portal-uploaded files).
    // Collapse synced equipment certs to the current one per asset —
    // see latestEquipmentCerts. Proof-load test certs pass through as-is.
    const fetched = (data ?? []) as CertWithProject[]
    const rows = [
      ...fetched.filter(f => f.kind !== 'equipment_certificate'),
      ...latestEquipmentCerts(fetched.filter(f => f.kind === 'equipment_certificate')),
    ]
    rows.sort((a, b) => {
      const ad = new Date(a.source_created_at || a.created_at).getTime()
      const bd = new Date(b.source_created_at || b.created_at).getTime()
      return bd - ad
    })
    setCerts(rows)
    setLoading(false)
  }

  async function handleDownload(file: ProjectFile) {
    const { data } = await supabase.storage.from('cportal-project-files').createSignedUrl(file.storage_path, 60)
    if (data?.signedUrl) {
      const a = document.createElement('a')
      a.href = data.signedUrl
      a.download = file.name
      a.click()
    }
  }

  async function previewFile(file: ProjectFile) {
    const { data } = await supabase.storage.from('cportal-project-files').createSignedUrl(file.storage_path, 300)
    if (data?.signedUrl) setPreviewing({ file, url: data.signedUrl })
  }

  const filtered = certs.filter(c => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return c.name.toLowerCase().includes(q) || (c.project?.name ?? '').toLowerCase().includes(q)
  })

  // If every cert the user can see belongs to the same customer, show a
  // single Ship-to card at the top (matches what they see on each project
  // page). Admins see certs across many customers, so we hide it for them.
  const uniqueCustomers = (() => {
    const map = new Map<string, CertCustomer>()
    for (const c of certs) {
      const cust = c.project?.customer
      if (cust?.id) map.set(cust.id, cust)
    }
    return Array.from(map.values())
  })()
  const shipCustomer = !isAdmin && uniqueCustomers.length === 1 ? uniqueCustomers[0] : null
  const hasShipAddr = !!(shipCustomer && (
    shipCustomer.shipping_address ||
    shipCustomer.shipping_city ||
    shipCustomer.shipping_state ||
    shipCustomer.shipping_zip
  ))
  const cityStateZip = shipCustomer
    ? [
        [shipCustomer.shipping_city, shipCustomer.shipping_state].filter(Boolean).join(', '),
        shipCustomer.shipping_zip,
      ].filter(Boolean).join(' ').trim()
    : ''

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Certificates</h1>
        <p className="text-gray-500 text-sm mt-1">
          {isAdmin
            ? 'Every test certificate and report across all projects.'
            : 'All your test certificates and reports in one place.'}
        </p>
      </div>

      {/* --- Ship-to address (read-only, synced from Zoho) --- */}
      {shipCustomer && (
        <div className="bg-white border border-gray-200 rounded-xl p-5 mb-6">
          <div className="flex items-start gap-3">
            <MapPin size={18} className="text-gray-400 mt-1 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2 mb-1">
                <h3 className="text-sm font-semibold text-gray-900">Ship to</h3>
                <span className="text-[10px] uppercase tracking-wide text-gray-400">From Zoho Books</span>
              </div>
              {hasShipAddr ? (
                <address className="text-sm text-gray-700 not-italic leading-relaxed">
                  {shipCustomer.company && (
                    <div className="font-medium text-gray-900">{shipCustomer.company}</div>
                  )}
                  {shipCustomer.name && shipCustomer.name !== shipCustomer.company && (
                    <div className="text-gray-700">{shipCustomer.name}</div>
                  )}
                  {shipCustomer.shipping_address && <div>{shipCustomer.shipping_address}</div>}
                  {cityStateZip && <div>{cityStateZip}</div>}
                  {shipCustomer.shipping_country && (
                    <div className="text-gray-500">{shipCustomer.shipping_country}</div>
                  )}
                </address>
              ) : (
                <p className="text-sm text-gray-500 italic">
                  No shipping address on file. Contact sales@hydrowates.com to update.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl">
        <div className="p-4 border-b border-gray-100">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by certificate name or project…"
              className="w-full pl-9 pr-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-14">
            <Award className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm font-medium">
              {certs.length === 0 ? 'No certificates yet' : 'No certificates match your search'}
            </p>
            <p className="text-gray-400 text-xs mt-1">
              {certs.length === 0
                ? (isAdmin ? 'Test reports uploaded to projects will appear here.' : 'Your test reports will appear here once issued.')
                : 'Try a different name or project.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(file => {
              const due = retestInfo(file.retest_due)
              return (
                <div key={file.id} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors">
                  <button onClick={() => previewFile(file)} className="flex items-center gap-3 min-w-0 text-left flex-1">
                    <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center flex-shrink-0">
                      <Award size={16} className="text-green-600" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate hover:text-blue-600 transition-colors">{file.name}</p>
                        {file.kind === 'equipment_certificate' && (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 font-medium flex-shrink-0">Equipment</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 truncate">
                        {file.project ? (
                          <Link
                            to={`/projects/${file.project.id}`}
                            onClick={e => e.stopPropagation()}
                            className="text-blue-600 hover:underline"
                          >
                            {file.project.name}
                          </Link>
                        ) : (
                          <span className="italic">Unknown project</span>
                        )}
                        {' · '}
                        {formatBytes(file.size)} · {formatDate(file.source_created_at || file.created_at)}
                      </p>
                    </div>
                  </button>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {due && (
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${due.color}`}>{due.label}</span>
                    )}
                    <button onClick={() => previewFile(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Preview">
                      <Eye size={16} />
                    </button>
                    <button onClick={() => handleDownload(file)} className="p-2 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                      <Download size={16} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Inline preview modal */}
      {previewing && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setPreviewing(null)}>
          <div className="bg-white rounded-2xl w-full max-w-5xl h-[90vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 flex-shrink-0">
              <p className="text-sm font-medium text-gray-900 truncate pr-4">{previewing.file.name}</p>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button onClick={() => handleDownload(previewing.file)} className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Download">
                  <Download size={18} />
                </button>
                <button onClick={() => setPreviewing(null)} className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors" title="Close">
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden bg-gray-100 rounded-b-2xl">
              {previewKind(previewing.file) === 'pdf' && (
                <iframe src={previewing.url} title={previewing.file.name} className="w-full h-full border-0" />
              )}
              {previewKind(previewing.file) === 'image' && (
                <div className="w-full h-full flex items-center justify-center overflow-auto">
                  <img src={previewing.url} alt={previewing.file.name} className="max-w-full max-h-full object-contain" />
                </div>
              )}
              {previewKind(previewing.file) === 'unsupported' && (
                <div className="w-full h-full flex flex-col items-center justify-center gap-3 text-gray-500 text-sm">
                  <FileText size={48} className="text-gray-300" />
                  <p>Preview not available for this file type.</p>
                  <button
                    onClick={() => handleDownload(previewing.file)}
                    className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
                  >
                    Download instead
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
