import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { FolderOpen, Plus, RefreshCw, Search, Award, Receipt, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Project } from '../types'

type SortKey = 'number-desc' | 'number-asc' | 'newest' | 'oldest'

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

export default function DashboardPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [creating, setCreating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<SortKey>('number-desc')
  const [stats, setStats] = useState<{
    retestDue: number
    retestOverdue: number
    outstanding: number
    currency: string
  } | null>(null)
  const [actionItems, setActionItems] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!profile) return
    fetchProjects()
    if (profile.role === 'admin') fetchStats()
  }, [profile])

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
    const [certRes, invRes] = await Promise.all([
      supabase.from('files').select('retest_due').eq('kind', 'certificate').not('retest_due', 'is', null),
      supabase.from('invoices').select('balance, currency_code'),
    ])
    let retestDue = 0
    let retestOverdue = 0
    for (const c of certRes.data ?? []) {
      const days = Math.ceil((new Date(c.retest_due + 'T00:00:00').getTime() - Date.now()) / 86400000)
      if (days < 0) retestOverdue++
      else if (days <= 30) retestDue++
    }
    let outstanding = 0
    let currency = 'USD'
    for (const i of invRes.data ?? []) {
      const b = Number(i.balance)
      if (!isNaN(b) && b > 0) { outstanding += b; if (i.currency_code) currency = i.currency_code }
    }
    setStats({ retestDue, retestOverdue, outstanding, currency })
  }

  async function createProject() {
    if (!newName.trim()) return
    setCreating(true)
    await supabase.from('projects').insert({ name: newName.trim(), description: newDesc.trim() || null })
    setCreating(false)
    setShowCreate(false)
    setNewName('')
    setNewDesc('')
    fetchProjects()
  }

  async function handleSync() {
    setSyncing(true)
    setSyncMsg('')
    const { data, error } = await supabase.functions.invoke('sync-zoho', { body: {} })
    if (error) {
      let detail = error.message
      try {
        const ctx = (error as { context?: Response }).context
        if (ctx) {
          const body = await ctx.json()
          if (body?.error) detail = body.error
        }
      } catch {
        // ignore parse errors
      }
      setSyncing(false)
      setSyncMsg(`Sync failed: ${detail}`)
      return
    }
    // Also pull SharePoint lead descriptions (best-effort; ignored if not deployed yet)
    let leadMsg = ''
    try {
      const { data: leadData } = await supabase.functions.invoke('sync-leads', { body: {} })
      if (leadData?.projectsMatched != null) leadMsg = ` · matched ${leadData.projectsMatched} lead notes`
    } catch {
      // sync-leads not available
    }
    setSyncing(false)
    if (data?.synced) {
      const s = data.synced
      setSyncMsg(`Synced ${s.customers} customers, ${s.projects} projects, ${s.invoices} invoices${leadMsg}.`)
      fetchProjects()
    }
  }

  const visibleProjects = [...projects]
    .filter(p => {
      const q = search.trim().toLowerCase()
      if (!q) return true
      return p.name.toLowerCase().includes(q)
        || (p.customer?.company ?? '').toLowerCase().includes(q)
        || (p.customer?.name ?? '').toLowerCase().includes(q)
        || (p.description ?? '').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'number-asc':
          return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
        case 'number-desc':
          return b.name.localeCompare(a.name, undefined, { numeric: true, sensitivity: 'base' })
        case 'oldest':
          return beganTime(a) - beganTime(b)
        case 'newest':
        default:
          return beganTime(b) - beganTime(a)
      }
    })

  const totalActionItems = Object.values(actionItems).reduce((a, b) => a + b, 0)
  const projectsNeedingAction = Object.values(actionItems).filter(n => n > 0).length

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{isAdmin ? 'All Projects' : 'Your Projects'}</h1>
          <p className="text-gray-500 text-sm mt-1">
            {isAdmin ? 'Manage all customer projects' : 'Access your project files and documents'}
          </p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-2 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : 'Sync now'}
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              <Plus size={16} />
              New Project
            </button>
          </div>
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
        <div className="grid grid-cols-2 gap-4 mb-6 max-w-md">
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-gray-400 mb-1">
              <Award size={16} />
              <span className="text-xs font-medium uppercase tracking-wide">Re-tests due</span>
            </div>
            <p className={`text-2xl font-bold ${stats.retestOverdue > 0 ? 'text-red-600' : stats.retestDue > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
              {stats.retestDue + stats.retestOverdue}
            </p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <div className="flex items-center gap-2 text-gray-400 mb-1">
              <Receipt size={16} />
              <span className="text-xs font-medium uppercase tracking-wide">Outstanding</span>
            </div>
            <p className="text-2xl font-bold text-gray-900">{money(stats.outstanding, stats.currency)}</p>
          </div>
        </div>
      )}

      {isAdmin && syncMsg && (
        <div className="mb-6 text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-700">{syncMsg}</div>
      )}

      {!loading && projects.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search projects..."
              className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value as SortKey)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="number-desc">Project # (high to low)</option>
            <option value="number-asc">Project # (low to high)</option>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
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
            {isAdmin ? 'Create your first project above.' : "You haven't been added to any projects yet."}
          </p>
        </div>
      ) : visibleProjects.length === 0 ? (
        <div className="text-center py-16 text-gray-500 text-sm">No projects match.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visibleProjects.map(project => {
            return (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="bg-white border border-gray-200 rounded-xl p-5 hover:shadow-md hover:border-blue-200 transition-all group block"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center group-hover:bg-blue-100 transition-colors">
                    <FolderOpen size={20} className="text-blue-600" />
                  </div>
                  {(actionItems[project.id] ?? 0) > 0 && (
                    <span className="text-xs font-semibold px-2 py-1 rounded-full text-amber-700 bg-amber-100">
                      {actionItems[project.id]} needed
                    </span>
                  )}
                </div>
                <h3 className="font-semibold text-gray-900 mb-1">{project.name}</h3>
                {(project.customer?.company || project.customer?.name) && (
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
          })}
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">New Project</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Project Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && createProject()}
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="e.g. Office Renovation Q3"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Description <span className="text-gray-400">(optional)</span></label>
                <textarea
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  placeholder="Brief project description..."
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => setShowCreate(false)} className="flex-1 px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
                Cancel
              </button>
              <button
                onClick={createProject}
                disabled={creating || !newName.trim()}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {creating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
