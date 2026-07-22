import { useEffect, useState, type FormEvent } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, FolderOpen, Mail, Check, User, Phone, Plus, Trash2, X, Send, AlertCircle, Clock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Customer, Project } from '../types'

// Unified contact row used by the new Contacts section. Either a row
// from cportal_customer_contacts (`id` is set) or the primary email of
// a customer record (id null, source 'primary').
interface ContactRow {
  id: string | null
  customer_id: string
  name: string | null
  email: string
  role: string | null
  phone: string | null
  source: 'manual' | 'zoho' | 'sharepoint' | 'primary'
}

// Pretty-print a US phone number; fall back to raw if it doesn't match.
function formatPhone(raw: string | null): string {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return raw
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [contacts, setContacts] = useState<ContactRow[]>([])
  const [invited, setInvited] = useState(false)
  const [loading, setLoading] = useState(true)

  // Add-contact modal state
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Inline action state
  const [inviting, setInviting] = useState<string | null>(null)
  const [actionMsg, setActionMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // Per-contact account state, keyed by lowercased email. userId = their auth
  // id (for grants). signedIn = true (active) / false (invited, not signed in)
  // / null (account exists but sign-in status unknown — the status function
  // isn't deployed yet). Not present = no account. companyGrants = user ids
  // with standing access to all of this company's projects.
  const [accountByEmail, setAccountByEmail] = useState<Map<string, { userId: string; signedIn: boolean | null }>>(new Map())
  const [companyGrants, setCompanyGrants] = useState<Set<string>>(new Set())
  const [accessBusy, setAccessBusy] = useState<string | null>(null)

  // Per-project access picker — choose a subset of the company's projects for
  // one contact. companyProjects = every project across this company's records.
  const [companyProjects, setCompanyProjects] = useState<{ id: string; name: string }[]>([])
  const [projectPicker, setProjectPicker] = useState<{ userId: string; name: string } | null>(null)
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set())
  const [pickerSaving, setPickerSaving] = useState(false)

  useEffect(() => {
    if (!profile) return
    if (profile.role !== 'admin') { navigate('/'); return }
    if (id) void fetchData()
  }, [id, profile])

  async function fetchData() {
    setLoading(true)
    const { data: cust } = await supabase
      .from('cportal_customers').select('*').eq('id', id).single()
    if (!cust) { navigate('/customers'); return }
    setCustomer(cust as Customer)

    // Projects belonging to THIS specific customer row (we keep this
    // page customer-row-scoped for projects, since that's how Zoho
    // assigned them).
    const { data: projs } = await supabase
      .from('cportal_projects').select('*').eq('customer_id', id).order('name', { ascending: true })
    setProjects((projs ?? []) as Project[])

    // Peer customer rows — anyone sharing the same company name.
    // Used to surface ALL people associated with the company, even
    // those filed under a different Zoho contact record.
    const companyKey = (cust.company || '').trim().toLowerCase()
    let peerRows: Array<{ id: string; name: string | null; email: string | null; phone: string | null }> = []
    if (companyKey) {
      const { data: peers } = await supabase
        .from('cportal_customers')
        .select('id, name, email, phone, company')
        .ilike('company', cust.company || '')
      peerRows = (peers ?? []).filter(p => (p as { company: string }).company?.trim().toLowerCase() === companyKey)
    } else {
      peerRows = [{ id: cust.id, name: cust.name, email: cust.email, phone: null }]
    }
    const peerIds = peerRows.map(p => p.id)

    // All extra contacts on any peer customer row.
    const { data: extraContacts } = await supabase
      .from('cportal_customer_contacts')
      .select('id, customer_id, name, email, role, phone, source')
      .in('customer_id', peerIds)

    // Build a deduped contact list, with peer customers' primary emails
    // appearing first (source='primary'). Manual entries come next, then
    // sharepoint + zoho. Email is the dedup key.
    const seen = new Map<string, ContactRow>()
    for (const p of peerRows) {
      if (!p.email) continue
      const e = p.email.toLowerCase()
      if (seen.has(e)) continue
      seen.set(e, {
        id: null,
        customer_id: p.id,
        name: p.name,
        email: e,
        role: 'primary',
        phone: p.phone,
        source: 'primary',
      })
    }
    for (const c of extraContacts ?? []) {
      const e = (c.email || '').toLowerCase()
      if (!e) continue
      if (seen.has(e)) continue
      seen.set(e, {
        id: c.id,
        customer_id: c.customer_id,
        name: c.name,
        email: e,
        role: c.role,
        phone: c.phone,
        source: (c.source as ContactRow['source']) || 'manual',
      })
    }
    const list = [...seen.values()].sort((a, b) => {
      // Primary first, then alphabetical by name/email.
      if ((a.source === 'primary') !== (b.source === 'primary')) {
        return a.source === 'primary' ? -1 : 1
      }
      return (a.name || a.email).localeCompare(b.name || b.email)
    })
    setContacts(list)

    if (cust.email) {
      const { data: prof } = await supabase
        .from('cportal_profiles').select('id').ilike('email', cust.email).maybeSingle()
      setInvited(!!prof)
    }

    // Account state per email: who has an account + whether they've signed in.
    // Prefer cportal_account_status (knows sign-in state). If it isn't deployed
    // yet, fall back to profiles (account exists, sign-in unknown → signedIn null).
    const acctMap = new Map<string, { userId: string; signedIn: boolean | null }>()
    const { data: statuses, error: statusErr } = await supabase.rpc('cportal_account_status')
    if (!statusErr && statuses) {
      for (const s of statuses as { id: string; email: string; has_signed_in: boolean }[]) {
        acctMap.set(String(s.email ?? '').toLowerCase(), { userId: s.id, signedIn: !!s.has_signed_in })
      }
    } else {
      const { data: profs } = await supabase.from('cportal_profiles').select('id, email')
      for (const pf of profs ?? []) acctMap.set(String(pf.email ?? '').toLowerCase(), { userId: pf.id as string, signedIn: null })
    }
    setAccountByEmail(acctMap)

    // Standing company-wide grants for this company (so the toggle reflects state).
    const ckey = companyKeyOf(cust.company)
    if (ckey) {
      const { data: grants } = await supabase
        .from('cportal_company_access').select('user_id').eq('company_key', ckey)
      setCompanyGrants(new Set((grants ?? []).map(g => g.user_id as string)))

      // Every project across this company's customer records (for the picker).
      const { data: allCusts } = await supabase.from('cportal_customers').select('id, company')
      const peerIds = (allCusts ?? [])
        .filter(pc => companyKeyOf((pc as { company?: string }).company) === ckey)
        .map(pc => pc.id as string)
      if (peerIds.length) {
        const { data: cprojs } = await supabase
          .from('cportal_projects').select('id, name').in('customer_id', peerIds).order('name', { ascending: true })
        setCompanyProjects((cprojs ?? []) as { id: string; name: string }[])
      } else {
        setCompanyProjects([])
      }
    } else {
      setCompanyGrants(new Set())
      setCompanyProjects([])
    }

    setLoading(false)
  }

  // Normalize a company name the same way the database does (lowercase,
  // alphanumeric only) so the client and the grant key always agree.
  function companyKeyOf(name?: string | null): string {
    return String(name ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  }

  // Toggle standing access: grant = this person sees ALL of the company's
  // projects, current and future; revoke = remove the grant and their
  // memberships on those projects.
  async function toggleCompanyAccess(userId: string, on: boolean) {
    if (!customer?.company) return
    setAccessBusy(userId)
    setActionMsg(null)
    const fn = on ? 'cportal_grant_company_access' : 'cportal_revoke_company_access'
    const { error: rpcErr } = await supabase.rpc(fn, { p_user: userId, p_company: customer.company })
    setAccessBusy(null)
    if (rpcErr) { setActionMsg({ kind: 'error', text: rpcErr.message }); return }
    setCompanyGrants(prev => {
      const next = new Set(prev)
      if (on) next.add(userId); else next.delete(userId)
      return next
    })
    setActionMsg({
      kind: 'success',
      text: on
        ? `Now has access to all of ${customer.company}'s projects — including future ones.`
        : `Removed company-wide access for ${customer.company}.`,
    })
  }

  // One-time: add this person to every CURRENT project for the company
  // (no standing grant, so new projects won't auto-include them).
  async function addToCurrentProjects(userId: string) {
    if (!customer?.company) return
    setAccessBusy(userId)
    setActionMsg(null)
    const { data, error: rpcErr } = await supabase.rpc('cportal_add_to_all_company_projects', {
      p_user: userId, p_company: customer.company,
    })
    setAccessBusy(null)
    if (rpcErr) { setActionMsg({ kind: 'error', text: rpcErr.message }); return }
    const n = (data as number) ?? 0
    setActionMsg({ kind: 'success', text: `Added to ${n} current project${n === 1 ? '' : 's'} for ${customer.company}.` })
  }

  // Open the per-project picker for one contact, pre-checking the projects
  // they're already a member of.
  async function openProjectPicker(userId: string, name: string) {
    setActionMsg(null)
    const ids = companyProjects.map(p => p.id)
    let current = new Set<string>()
    if (ids.length) {
      const { data: mems } = await supabase
        .from('cportal_project_members').select('project_id').eq('user_id', userId).in('project_id', ids)
      current = new Set((mems ?? []).map(m => m.project_id as string))
    }
    setPickerSelected(current)
    setProjectPicker({ userId, name })
  }

  // Save the picker: add/remove project memberships to match the selection.
  async function saveProjectPicker() {
    if (!projectPicker) return
    setPickerSaving(true)
    const userId = projectPicker.userId
    const ids = companyProjects.map(p => p.id)
    const { data: mems } = await supabase
      .from('cportal_project_members').select('project_id').eq('user_id', userId).in('project_id', ids)
    const current = new Set((mems ?? []).map(m => m.project_id as string))
    const toAdd = [...pickerSelected].filter(pid => !current.has(pid))
    const toRemove = [...current].filter(pid => !pickerSelected.has(pid))
    if (toAdd.length) {
      await supabase.from('cportal_project_members').insert(toAdd.map(pid => ({ project_id: pid, user_id: userId })))
    }
    if (toRemove.length) {
      await supabase.from('cportal_project_members').delete().eq('user_id', userId).in('project_id', toRemove)
    }
    setPickerSaving(false)
    const name = projectPicker.name
    setProjectPicker(null)
    setActionMsg({ kind: 'success', text: `${name} now has access to ${pickerSelected.size} project${pickerSelected.size === 1 ? '' : 's'}.` })
  }

  async function handleAddContact(e: FormEvent) {
    e.preventDefault()
    if (!newEmail.trim() || !customer) return
    setSaving(true)
    setError('')
    const { error: insErr } = await supabase.from('cportal_customer_contacts').insert({
      customer_id: customer.id,
      name: newName.trim() || null,
      email: newEmail.trim().toLowerCase(),
      role: newRole.trim() || null,
      phone: newPhone.trim() || null,
      source: 'manual',
    })
    setSaving(false)
    if (insErr) { setError(insErr.message); return }
    setNewName(''); setNewEmail(''); setNewRole(''); setNewPhone('')
    setShowAdd(false)
    setActionMsg({ kind: 'success', text: 'Contact added.' })
    setTimeout(() => setActionMsg(null), 4000)
    void fetchData()
  }

  async function handleDelete(contact: ContactRow) {
    if (!contact.id) return // primary emails can't be deleted from here
    if (!confirm(`Remove ${contact.name || contact.email} from contacts?`)) return
    const { error: delErr } = await supabase
      .from('cportal_customer_contacts').delete().eq('id', contact.id)
    if (delErr) {
      setActionMsg({ kind: 'error', text: delErr.message })
    } else {
      setActionMsg({ kind: 'success', text: 'Contact removed.' })
      setTimeout(() => setActionMsg(null), 4000)
      void fetchData()
    }
  }

  async function handleInvite(contact: ContactRow) {
    setInviting(contact.email)
    setActionMsg(null)
    const { data, error: invErr } = await supabase.functions.invoke('invite-customer', {
      body: {
        email: contact.email,
        name: contact.name,
        redirectTo: `${window.location.origin}/set-password`,
      },
    })
    setInviting(null)
    if (invErr || data?.error) {
      setActionMsg({ kind: 'error', text: data?.error || invErr?.message || 'Invite failed.' })
    } else {
      setActionMsg({ kind: 'success', text: `Invitation sent to ${contact.email}.` })
      setTimeout(() => setActionMsg(null), 6000)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }
  if (!customer) return null

  // Source badge styling — small color-coded chips so the admin can
  // tell at a glance where each contact came from.
  const sourceBadge = (source: ContactRow['source']) => {
    const style =
      source === 'primary' ? 'bg-blue-50 text-blue-700' :
      source === 'sharepoint' ? 'bg-amber-50 text-amber-700' :
      source === 'manual' ? 'bg-purple-50 text-purple-700' :
      'bg-gray-100 text-gray-600'
    const label =
      source === 'primary' ? 'Primary' :
      source === 'sharepoint' ? 'SharePoint' :
      source === 'manual' ? 'Manual' :
      'Zoho'
    return (
      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium ${style}`}>
        {label}
      </span>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <Link to="/customers" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-6 transition-colors">
        <ArrowLeft size={16} /> Back to Customers
      </Link>

      {/* Customer header */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-900">{customer.company || customer.name || 'Unnamed customer'}</h1>
            {customer.name && customer.company && <p className="text-gray-500 mt-0.5">{customer.name}</p>}
            <p className="text-gray-400 text-sm mt-1">
              {customer.email
                ? customer.email
                : contacts.length > 0
                  ? `${contacts.length} email${contacts.length === 1 ? '' : 's'} on file`
                  : 'No email on file'}
            </p>
          </div>
          {customer.email && (
            <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full flex-shrink-0 ${invited ? 'text-green-700 bg-green-100' : 'text-gray-600 bg-gray-100'}`}>
              {invited ? <><Check size={12} /> Has portal access</> : <><Mail size={12} /> Not invited</>}
            </span>
          )}
        </div>
      </div>

      {/* Status message (after invite / delete) */}
      {actionMsg && (
        <div className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 mb-4 ${
          actionMsg.kind === 'success'
            ? 'bg-green-50 border border-green-200 text-green-700'
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>
          {actionMsg.kind === 'success'
            ? <Check size={15} className="flex-shrink-0 mt-0.5" />
            : <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />}
          <span>{actionMsg.text}</span>
        </div>
      )}

      {/* Contacts section */}
      <div className="bg-white border border-gray-200 rounded-xl mb-5">
        <div className="flex items-center justify-between p-5 border-b border-gray-100">
          <div>
            <h2 className="font-semibold text-gray-900">Contacts ({contacts.length})</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Everyone associated with this company — across Zoho, SharePoint leads, and manual entries.
            </p>
          </div>
          <button
            onClick={() => { setShowAdd(true); setError('') }}
            className="flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors flex-shrink-0"
          >
            <Plus size={15} />
            Add Contact
          </button>
        </div>

        {contacts.length === 0 ? (
          <div className="text-center py-14">
            <User className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm font-medium">No contacts yet</p>
            <p className="text-gray-400 text-xs mt-1">Add a contact manually or wait for the next sync to pull them from Zoho/SharePoint.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {contacts.map(c => {
              const initial = (c.name?.[0] ?? c.email[0] ?? '?').toUpperCase()
              const acct = c.email ? accountByEmail.get(c.email.toLowerCase()) : undefined
              const uid = acct?.userId
              return (
                <div key={`${c.email}-${c.customer_id}`} className="flex items-start gap-3 px-5 py-3.5">
                  <div className="w-9 h-9 rounded-full bg-gray-100 text-gray-600 flex items-center justify-center flex-shrink-0 text-xs font-semibold">
                    {initial}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium text-gray-900 truncate">{c.name || c.email}</p>
                      {sourceBadge(c.source)}
                      {c.role && c.role !== 'primary' && (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium bg-gray-100 text-gray-700">
                          {c.role}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-wrap mt-1">
                      <a
                        href={`mailto:${c.email}`}
                        className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-blue-700 hover:underline"
                      >
                        <Mail size={12} className="text-gray-400" />
                        {c.email}
                      </a>
                      {c.phone && (
                        <a
                          href={`tel:${c.phone.replace(/[^+\d]/g, '')}`}
                          className="inline-flex items-center gap-1.5 text-xs text-blue-700 bg-blue-50 hover:bg-blue-100 rounded px-2 py-0.5 transition-colors"
                        >
                          <Phone size={11} />
                          {formatPhone(c.phone)}
                        </a>
                      )}
                    </div>
                    {uid && (
                      <div className="flex items-center gap-3 flex-wrap mt-2">
                        <label className="inline-flex items-center gap-1.5 text-xs text-gray-700 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={companyGrants.has(uid)}
                            disabled={accessBusy === uid}
                            onChange={e => toggleCompanyAccess(uid, e.target.checked)}
                            className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                          <span>All company projects <span className="text-gray-400">(incl. future)</span></span>
                        </label>
                        {!companyGrants.has(uid) && (
                          <>
                            <button
                              onClick={() => addToCurrentProjects(uid)}
                              disabled={accessBusy === uid}
                              className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                            >
                              + Add to current jobs
                            </button>
                            <button
                              onClick={() => openProjectPicker(uid, c.name || c.email)}
                              className="text-xs font-medium text-blue-600 hover:text-blue-700"
                            >
                              Choose projects…
                            </button>
                          </>
                        )}
                        {accessBusy === uid && <span className="text-xs text-gray-400">Saving…</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {!acct ? (
                      // No account yet → offer an invite.
                      <button
                        onClick={() => handleInvite(c)}
                        disabled={inviting === c.email}
                        className="inline-flex items-center gap-1 text-xs font-medium text-gray-600 hover:text-blue-700 hover:bg-blue-50 px-2 py-1 rounded transition-colors disabled:opacity-50"
                        title="Send portal invitation"
                      >
                        <Send size={11} />
                        {inviting === c.email ? 'Sending…' : 'Invite'}
                      </button>
                    ) : acct.signedIn === false ? (
                      // Invited but hasn't signed in → show status + a resend.
                      <>
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2.5 py-1 rounded-full" title="Invited — hasn't signed in yet">
                          <Clock size={12} /> Invited
                        </span>
                        <button
                          onClick={() => handleInvite(c)}
                          disabled={inviting === c.email}
                          className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-blue-700 hover:bg-blue-50 px-2 py-1 rounded transition-colors disabled:opacity-50"
                          title="Resend invitation"
                        >
                          <Send size={11} />
                          {inviting === c.email ? 'Sending…' : 'Resend'}
                        </button>
                      </>
                    ) : (
                      // Has an account (signed in, or sign-in status unknown) →
                      // no invite needed.
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full" title="Has portal access">
                        <Check size={12} /> {acct.signedIn === true ? 'Active' : 'Has access'}
                      </span>
                    )}
                    {c.id && (
                      <button
                        onClick={() => handleDelete(c)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                        title="Remove contact"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Projects section (unchanged) */}
      <div className="bg-white border border-gray-200 rounded-xl">
        <div className="p-5 border-b border-gray-100">
          <h2 className="font-semibold text-gray-900">Projects ({projects.length})</h2>
        </div>
        {projects.length === 0 ? (
          <div className="text-center py-14">
            <FolderOpen className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm font-medium">No projects for this customer</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {projects.map(p => (
              <Link key={p.id} to={`/projects/${p.id}`} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                    <FolderOpen size={16} className="text-blue-600" />
                  </div>
                  <p className="text-sm font-medium text-gray-900 truncate">{p.name}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Project access picker — choose a subset of the company's projects */}
      {projectPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setProjectPicker(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Project access</h2>
            <p className="text-sm text-gray-500 mb-4">
              Choose which of {customer?.company ? <span className="font-medium text-gray-700">{customer.company}</span> : 'the company'}’s projects <span className="font-medium text-gray-700">{projectPicker.name}</span> can access.
            </p>
            {companyProjects.length === 0 ? (
              <p className="text-sm text-gray-400 px-3 py-6 text-center border border-gray-100 rounded-lg mb-4">No projects for this company yet.</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-gray-500">{pickerSelected.size} of {companyProjects.length} selected</span>
                  <div className="flex gap-3">
                    <button onClick={() => setPickerSelected(new Set(companyProjects.map(p => p.id)))} className="text-xs font-medium text-blue-600 hover:text-blue-700">Select all</button>
                    <button onClick={() => setPickerSelected(new Set())} className="text-xs font-medium text-gray-500 hover:text-gray-700">Clear</button>
                  </div>
                </div>
                <div className="max-h-72 overflow-auto border border-gray-100 rounded-lg divide-y divide-gray-50 mb-4">
                  {companyProjects.map(p => (
                    <label key={p.id} className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer hover:bg-gray-50">
                      <input
                        type="checkbox"
                        checked={pickerSelected.has(p.id)}
                        onChange={e => setPickerSelected(prev => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(p.id); else next.delete(p.id)
                          return next
                        })}
                        className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                      />
                      <span className="text-sm text-gray-800 truncate">{p.name}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setProjectPicker(null)}
                disabled={pickerSaving}
                className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={saveProjectPicker}
                disabled={pickerSaving}
                className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {pickerSaving ? 'Saving…' : 'Save access'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Contact modal */}
      {showAdd && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => !saving && setShowAdd(false)}
        >
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <h2 className="text-lg font-semibold text-gray-900">Add a contact</h2>
              <button onClick={() => !saving && setShowAdd(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              They'll get portal access automatically once they sign in with this email. You can also click "Invite" after adding to send a setup email right away.
            </p>

            <form onSubmit={handleAddContact} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
                <input
                  type="email"
                  value={newEmail}
                  onChange={e => setNewEmail(e.target.value)}
                  required
                  placeholder="name@company.com"
                  autoFocus
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Full name (optional)</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="Jane Doe"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Role / title (optional)</label>
                <input
                  type="text"
                  value={newRole}
                  onChange={e => setNewRole(e.target.value)}
                  placeholder="e.g. Project Manager, Billing"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Phone (optional)</label>
                <input
                  type="tel"
                  value={newPhone}
                  onChange={e => setNewPhone(e.target.value)}
                  placeholder="(555) 555-0123"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {error && <p className="text-red-600 text-xs">{error}</p>}

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  disabled={saving}
                  className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving || !newEmail.trim()}
                  className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {saving ? 'Adding…' : 'Add contact'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
