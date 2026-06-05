import { useEffect, useState, useRef } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen, RefreshCw, Search, Receipt, AlertCircle, ChevronDown, ChevronRight, HelpCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Project } from '../types'

function beganTime(p: Project): number {
  return p.started_on ? new Date(p.started_on).getTime() : new Date(p.created_at).getTime()
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', maximumFractionDigits: 0 }).format(amount)
  } catch {
    return String(Math.round(amount))
  }
}

// "5 min ago" / "2 hr ago" / "just now" — used for the "Last synced" indicator.
function formatRelativeTime(ts: number | null): string {
  if (!ts) return 'never'
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 30) return 'just now'
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const LAST_SYNC_KEY = 'hwLastSyncAt'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

export default function DashboardPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(() => {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(LAST_SYNC_KEY) : null
    return v ? Number(v) : null
  })
  const [search, setSearch] = useState('')
  const [stats, setStats] = useState<{
    outstanding: number
    currency: string
  } | null>(null)
  const [actionItems, setActionItems] = useState<Record<string, number>>({})
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const didInitCollapse = useRef(false)

  useEffect(() => {
    if (!profile) return
    fetchProjects()
    if (profile.role === 'admin') fetchStats()
  }, [profile])

  // Auto-sync on dashboard load (admin only). Throttled — if we synced less
  // than a minute ago, skip the round-trip to Zoho / SharePoint.
  useEffect(() => {
    if (!isAdmin) return
    const last = lastSyncedAt ?? 0
    if (Date.now() - last > 60_000) handleSync()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin])

  // Admin dashboard opens with every company collapsed (once, on first load).
  useEffect(() => {
    if (!isAdmin || projects.length === 0 || didInitCollapse.current) return
    setCollapsed(new Set(projects.map(p => p.customer_id ?? 'none')))
    didInitCollapse.current = true
  }, [projects, isAdmin])

  async function fetchProjects() {
    if (!profile) return
    setLoading(true)
    // RLS returns exactly the projects this user may see: admins get all;
    // customers get their own (matched by Zoho contact email, or manual membership).
    const { data } = await supabase
      .from('projects')
      .select('*, customer:customers(company, name)')
      .order('created_at', { ascending: false })
    setProjects(data ?? [])
    fetchActionItems((data ?? []).map((p) => p.id))
    setLoading(false)
  }

  // Count outstanding required documents per project (missing PO + unmet checklist items).
  async function fetchActionItems(ids: string[]) {
    if (ids.length === 0) { setActionItems({}); return }
    const [reqRes, fileRes] = await Promise.all([
      supabase.from('document_requests').select('id, project_id').in('project_id', ids),
      supabase.from('files').select('project_id, kind, document_request_id').in('project_id', ids),
    ])
    const reqs = reqRes.data ?? []
    const files = fileRes.data ?? []
    const result: Record<string, number> = {}
    for (const pid of ids) {
      const hasPO = files.some(f => f.project_id === pid && f.kind === 'purchase_order')
      const fulfilled = new Set(files.filter(f => f.project_id === pid && f.document_request_id).map(f => f.document_request_id))
      const unmet = reqs.filter(r => r.project_id === pid && !fulfilled.has(r.id)).length
      result[pid] = (hasPO ? 0 : 1) + unmet
    }
    setActionItems(result)
  }

  async function fetchStats() {
    const { data } = await supabase.from('invoices').select('balance, currency_code')
    let outstanding = 0
    let currency = 'USD'
    for (const i of data ?? []) {
      const b = Number(i.balance)
      if (!isNaN(b) && b > 0) { outstanding += b; if (i.currency_code) currency = i.currency_code }
    }
    setStats({ outstanding, currency })
  }

  // Runs in the background on dashboard load (admin only). Pulls Zoho + the
  // SharePoint lead notes, then refreshes the project list. Stamps the last
  // sync time in localStorage so we can show "Last synced 5 min ago".
  async function handleSync() {
    setSyncing(true)
    const { data, error } = await supabase.functions.invoke('sync-zoho', { body: {} })
    if (error) {
      console.error('sync-zoho failed:', error.message)
      setSyncing(false)
      return
    }
    // Lead notes are best-effort; ignored if sync-leads isn't deployed.
    try {
      await supabase.functions.invoke('sync-leads', { body: {} })
    } catch {
      // sync-leads not available
    }
    setSyncing(false)
    if (data?.synced) {
      const now = Date.now()
      setLastSyncedAt(now)
      try { localStorage.setItem(LAST_SYNC_KEY, String(now)) } catch { /* private mode */ }
      fetchProjects()
    }
  }

  // Default order: newest first. Companies are alphabetical (grouped below);
  // within each company group, the most recent projects show on top.
  const visibleProjects = [...projects]
    .filter(p => {
      const q = search.trim().toLowerCase()
      if (!q) return true
      return p.name.toLowerCase().includes(q)
        || (p.customer?.company ?? '').toLowerCase().includes(q)
        || (p.customer?.name ?? '').toLowerCase().includes(q)
        || (p.description ?? '').toLowerCase().includes(q)
    })
    .sort((a, b) => beganTime(b) - beganTime(a))

  const totalActionItems = Object.values(actionItems).reduce((a, b) => a + b, 0)
  const projectsNeedingAction = Object.values(actionItems).filter(n => n > 0).length

  const renderProjectCard = (project: Project) => (
    <Link
      key={project.id}
      to={`/projects/${project.id}`}
      className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-md hover:border-blue-200 transition-all group block"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center group-hover:bg-blue-100 transition-colors">
          <FolderOpen size={20} className="text-blue-600" />
        </div>
        {!isAdmin && (actionItems[project.id] ?? 0) > 0 && (
          <span className="text-xs font-semibold px-2 py-1 rounded-full text-amber-700 bg-amber-100">
            {actionItems[project.id]} needed
          </span>
        )}
      </div>
      <h3 className="font-semibold text-gray-900 mb-1">{project.name}</h3>
      {!isAdmin && (project.customer?.company || project.customer?.name) && (
        <p className="text-blue-600 text-xs font-medium mb-1">{project.customer?.company || project.customer?.name}</p>
      )}
      {project.description && (
        <p className="text-gray-500 text-sm line-clamp-2">{project.description}</p>
      )}
      <p className="text-gray-400 text-xs mt-3">
        {project.started_on
          ? `Started ${new Date(project.started_on).toLocaleDateString()}`
          : `Updated ${new Date(project.updated_at).toLocaleDateString()}`}
      </p>
    </Link>
  )

  // Compact one-line row — used inside company groups on the admin dashboard.
  const renderProjectRow = (project: Project) => (
    <Link
      key={project.id}
      to={`/projects/${project.id}`}
      className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-blue-50/40 transition-colors group"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <FolderOpen size={15} className="text-blue-600 flex-shrink-0" />
        <span className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-700 transition-colors">
          {project.name}
        </span>
        {project.description && (
          <span className="text-xs text-gray-400 truncate hidden md:inline">— {project.description}</span>
        )}
      </div>
      <span className="text-xs text-gray-400 flex-shrink-0">
        {project.started_on
          ? new Date(project.started_on).toLocaleDateString()
          : new Date(project.updated_at).toLocaleDateString()}
      </span>
    </Link>
  )

  // Admin view: group projects under their company (sorted alphabetically).
  const companyGroups = (() => {
    const map = new Map<string, { label: string; customerId: string | null; projects: Project[] }>()
    for (const p of visibleProjects) {
      const key = p.customer_id ?? 'none'
      const label = p.customer?.company || p.customer?.name || 'Unassigned'
      if (!map.has(key)) map.set(key, { label, customerId: p.customer_id ?? null, projects: [] })
      map.get(key)!.projects.push(p)
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
  })()

  const allCollapsed = companyGroups.length > 0 && companyGroups.every(g => collapsed.has(g.customerId ?? 'none'))
  const toggleCompany = (key: string) =>
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  const toggleAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(companyGroups.map(g => g.customerId ?? 'none')))

  // First company group for each starting letter (for the A–Z jump bar).
  const letterTargets = new Map<string, string>()
  for (const g of companyGroups) {
    const c = (g.label[0] || '#').toUpperCase()
    const letter = /[A-Z]/.test(c) ? c : '#'
    if (!letterTargets.has(letter)) letterTargets.set(letter, g.customerId ?? 'none')
  }

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">{isAdmin ? 'All Projects' : 'Your Projects'}</h1>
        <p className="text-gray-500 text-sm mt-1">
          {isAdmin ? 'Manage all customer projects' : 'Access your project files and documents'}
        </p>
        {isAdmin && (
          <p className="text-gray-400 text-xs mt-1.5 flex items-center gap-1.5">
            {syncing
              ? <><RefreshCw size={11} className="animate-spin" /> Syncing now…</>
              : <><RefreshCw size={11} /> Last synced {formatRelativeTime(lastSyncedAt)}</>}
          </p>
        )}
      </div>
      {!isAdmin && totalActionItems > 0 && (
        <div className="mb-6 flex items-center gap-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-4 py-3">
          <AlertCircle size={18} className="flex-shrink-0" />
          <p className="text-sm font-medium">
            Action needed — {totalActionItems} document{totalActionItems === 1 ? '' : 's'} to upload across {projectsNeedingAction} project{projectsNeedingAction === 1 ? '' : 's'}.
          </p>
        </div>
      )}

      {isAdmin && stats && (
        <div className="bg-white border border-gray-200 rounded-xl p-4 mb-6 max-w-xs overflow-visible">
          <div className="flex items-center gap-2 text-gray-400 mb-1">
            <Receipt size={16} />
            <span className="text-xs font-medium uppercase tracking-wide">Outstanding</span>
            <span
              className="relative group inline-flex"
            >
              <HelpCircle size={12} className="text-gray-300 hover:text-gray-500 cursor-help" aria-label="Help" />
              <span className="absolute left-0 top-full mt-1.5 w-56 px-3 py-2 text-xs font-normal normal-case text-white bg-gray-900 rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-20 shadow-lg leading-relaxed">
                Total amount currently unpaid across all customer invoices, synced from Zoho Books. Includes overdue and partially-paid invoices, excludes paid ones.
              </span>
            </span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{money(stats.outstanding, stats.currency)}</p>
        </div>
      )}

      {isAdmin && !loading && projects.length > 0 && (
        <div className="mb-5">
          <div className="relative max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by company or HWI number..."
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : projects.length === 0 ? (
        <div className="text-center py-20 bg-white rounded-xl border border-gray-200">
          <FolderOpen className="mx-auto text-gray-300 mb-3" size={48} />
          <p className="text-gray-600 font-medium">No projects yet</p>
          <p className="text-gray-400 text-sm mt-1">
            {isAdmin ? 'Projects sync automatically from Zoho — none found yet.' : "You haven't been added to any projects yet."}
          </p>
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="text-center py-16 text-gray-500 text-sm">No projects match.</div>
      ) : isAdmin ? (
        <div>
          <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
            <div className="flex flex-wrap gap-0.5">
              {ALPHABET.map(letter => {
                const target = letterTargets.get(letter)
                return (
                  <button
                    key={letter}
                    disabled={!target}
                    onClick={() => target && document.getElementById(`company-group-${target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className={`w-6 h-6 text-xs font-medium rounded transition-colors ${target ? 'text-blue-600 hover:bg-blue-100' : 'text-gray-300 cursor-default'}`}
                  >
                    {letter}
                  </button>
                )
              })}
            </div>
            <button onClick={toggleAll} className="text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors whitespace-nowrap">
              {allCollapsed ? 'Expand all' : 'Collapse all'}
            </button>
          </div>
          <div className="space-y-4">
            {companyGroups.map(group => {
              const key = group.customerId ?? 'none'
              const isCollapsed = collapsed.has(key)
              return (
                <div key={key} id={`company-group-${key}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <button
                      onClick={() => toggleCompany(key)}
                      className="flex items-center gap-2 text-left group/header"
                      aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                      <span className="text-gray-400 group-hover/header:text-gray-700 transition-colors">
                        {isCollapsed ? <ChevronRight size={18} /> : <ChevronDown size={18} />}
                      </span>
                      <span className="text-lg font-semibold text-gray-900 group-hover/header:text-blue-600 transition-colors">
                        {group.label}
                      </span>
                      <span className="text-xs text-gray-400">({group.projects.length})</span>
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-50 overflow-hidden">
                      {group.projects.map(renderProjectRow)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleProjects.map(renderProjectCard)}
        </div>
      )}

    </div>
  )
}
