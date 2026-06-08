import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Inbox, Mail, Phone, Download, FileText, ChevronDown, ChevronUp, Search } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Admin-only queue of customer-submitted RFQs. Each row shows the basic
// info; expand it for the full message + attachments + status controls.

type Status = 'new' | 'in_review' | 'quoted' | 'closed'

interface QuoteRequest {
  id: string
  user_id: string | null
  name: string
  company: string | null
  phone: string | null
  email: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  request_types: string[]
  comments: string
  attachment_paths: string[]
  status: Status
  admin_notes: string | null
  webhook_status: string | null
  created_at: string
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(d: string) {
  return new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function statusColor(s: Status): string {
  if (s === 'new') return 'bg-blue-100 text-blue-700'
  if (s === 'in_review') return 'bg-amber-100 text-amber-700'
  if (s === 'quoted') return 'bg-purple-100 text-purple-700'
  return 'bg-gray-100 text-gray-600'
}

function statusLabel(s: Status): string {
  if (s === 'in_review') return 'In review'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export default function QuoteRequestsPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [requests, setRequests] = useState<QuoteRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Client-side admin gate (RLS is the real enforcement)
  useEffect(() => {
    if (profile && profile.role !== 'admin') navigate('/')
  }, [profile, navigate])

  useEffect(() => {
    void fetchRequests()
  }, [])

  async function fetchRequests() {
    setLoading(true)
    const { data } = await supabase
      .from('cportal_quote_requests')
      .select('*')
      .order('created_at', { ascending: false })
    setRequests((data ?? []) as QuoteRequest[])
    setLoading(false)
  }

  async function updateAdminNotes(id: string, admin_notes: string) {
    const { error } = await supabase
      .from('cportal_quote_requests')
      .update({ admin_notes, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return
    setRequests(prev => prev.map(r => r.id === id ? { ...r, admin_notes } : r))
  }

  async function downloadAttachment(path: string) {
    const { data } = await supabase.storage.from('cportal-quote-attachments').createSignedUrl(path, 60)
    if (data?.signedUrl) {
      const a = document.createElement('a')
      a.href = data.signedUrl
      a.download = path.split('/').pop() ?? 'attachment'
      a.click()
    }
  }

  const filtered = requests.filter(r => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      r.name.toLowerCase().includes(q)
      || (r.company ?? '').toLowerCase().includes(q)
      || r.email.toLowerCase().includes(q)
      || r.comments.toLowerCase().includes(q)
      || r.request_types.some(t => t.toLowerCase().includes(q))
    )
  })

  if (profile && profile.role !== 'admin') return null

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Quote Requests</h1>
        <p className="text-gray-500 text-sm mt-1">
          Customer-submitted RFQs from the portal. {requests.length} total.
        </p>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl">
        <div className="p-4 border-b border-gray-100">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by name, company, email, or message…"
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
            <Inbox className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm font-medium">
              {requests.length === 0 ? 'No quote requests yet' : 'No quote requests match your filter'}
            </p>
            <p className="text-gray-400 text-xs mt-1">
              {requests.length === 0
                ? 'New customer RFQs from the portal will show up here.'
                : 'Try a different status or search term.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(r => {
              const expanded = expandedId === r.id
              const addrLine = [r.address, r.city, r.state, r.zip].filter(Boolean).join(', ')
              return (
                <div key={r.id} className="hover:bg-gray-50 transition-colors">
                  <button
                    onClick={() => setExpandedId(expanded ? null : r.id)}
                    className="w-full text-left px-5 py-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <p className="text-sm font-semibold text-gray-900 truncate">{r.name}</p>
                        {r.company && <span className="text-xs text-gray-400 truncate">· {r.company}</span>}
                      </div>
                      <p className="text-xs text-gray-500 truncate">
                        {r.request_types.join(' · ')} {' · '} {formatDate(r.created_at)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full whitespace-nowrap ${statusColor(r.status)}`}>
                        {statusLabel(r.status)}
                      </span>
                      {expanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                    </div>
                  </button>

                  {expanded && (
                    <div className="px-5 pb-5 pt-1 space-y-4 bg-gray-50 border-t border-gray-100">
                      {/* Contact + meta */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 text-xs">
                        <div className="flex items-center gap-2 text-gray-700">
                          <Mail size={13} className="text-gray-400" />
                          <a href={`mailto:${r.email}`} className="text-blue-600 hover:underline">{r.email}</a>
                        </div>
                        {r.phone && (
                          <div className="flex items-center gap-2 text-gray-700">
                            <Phone size={13} className="text-gray-400" />
                            <a href={`tel:${r.phone}`} className="hover:underline">{r.phone}</a>
                          </div>
                        )}
                        {addrLine && (
                          <div className="md:col-span-2 text-gray-600">{addrLine}</div>
                        )}
                        <div className="text-gray-400">Submitted {formatDateTime(r.created_at)}</div>
                        {r.webhook_status && (
                          <div className="text-gray-400">Power Automate: {r.webhook_status}</div>
                        )}
                      </div>

                      {/* Message */}
                      <div>
                        <p className="text-xs font-medium text-gray-700 mb-1">Message</p>
                        <p className="text-sm text-gray-800 whitespace-pre-wrap bg-white border border-gray-200 rounded-lg p-3">
                          {r.comments}
                        </p>
                      </div>

                      {/* Attachments */}
                      {r.attachment_paths.length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-gray-700 mb-1">Attachments</p>
                          <ul className="space-y-1.5">
                            {r.attachment_paths.map((path, i) => {
                              const displayName = path.split('/').pop()?.replace(/^\d+_[a-z0-9]+_/, '') ?? 'attachment'
                              return (
                                <li key={i}>
                                  <button
                                    onClick={() => downloadAttachment(path)}
                                    className="flex items-center gap-2 text-xs text-blue-600 hover:underline"
                                  >
                                    <FileText size={13} />
                                    {displayName}
                                    <Download size={11} />
                                  </button>
                                </li>
                              )
                            })}
                          </ul>
                        </div>
                      )}

                      {/* Admin notes */}
                      <div>
                        <p className="text-xs font-medium text-gray-700 mb-1">Internal notes</p>
                        <textarea
                          defaultValue={r.admin_notes ?? ''}
                          placeholder="Notes only visible to admins…"
                          onBlur={e => {
                            if (e.target.value !== (r.admin_notes ?? '')) {
                              void updateAdminNotes(r.id, e.target.value)
                            }
                          }}
                          rows={2}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>

                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
