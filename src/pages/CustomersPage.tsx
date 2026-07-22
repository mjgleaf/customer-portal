import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Users, Search, Mail, Check, Clock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Customer } from '../types'

// Normalized company key — same basis the detail page uses to group peers.
const companyKey = (s?: string | null) => (s ?? '').trim().toLowerCase()

export default function CustomersPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  // Account status by lowercased email. Not present = no account (never
  // invited). false = invited but hasn't signed in yet. true = signed in /
  // has access.
  const [accountStatus, setAccountStatus] = useState<Map<string, boolean>>(new Map())
  // Distinct emails on file per company (own row emails + contact emails),
  // keyed by normalized company name. Used so a customer row with no email
  // of its own still reflects the contacts associated with its company.
  const [emailCounts, setEmailCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [invitingId, setInvitingId] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  // Confirmation modal before any invite actually fires. Holds the customer
  // we're about to invite, or null when the modal is closed.
  const [pendingInvite, setPendingInvite] = useState<Customer | null>(null)

  useEffect(() => {
    if (!profile) return
    if (profile.role !== 'admin') { navigate('/'); return }
    fetchData()
  }, [profile])

  async function fetchData() {
    setLoading(true)
    const { data: custs } = await supabase.from('cportal_customers').select('*').order('company', { ascending: true })
    const { data: contactRows } = await supabase.from('cportal_customer_contacts').select('customer_id, email')

    // Account status by email. Prefer cportal_account_status (knows sign-in
    // state → Invited vs Active). If that function isn't deployed yet, fall
    // back to profiles so we still show who has an account as "Invited"
    // rather than wrongly showing "Invite" for someone who's already a member.
    const { data: statuses, error: statusErr } = await supabase.rpc('cportal_account_status')
    if (!statusErr && statuses) {
      setAccountStatus(new Map(
        (statuses as { email: string; has_signed_in: boolean }[]).map(s => [String(s.email ?? '').toLowerCase(), !!s.has_signed_in]),
      ))
    } else {
      const { data: profs } = await supabase.from('cportal_profiles').select('email')
      setAccountStatus(new Map((profs ?? []).map(p => [String(p.email ?? '').toLowerCase(), false])))
    }

    const list = (custs ?? []) as Customer[]

    // Tally distinct emails per company: each customer row's own email plus
    // every contact email on any row sharing that company name.
    const keyByCustomerId = new Map(list.map(c => [c.id, companyKey(c.company)]))
    const emailsByCompany = new Map<string, Set<string>>()
    const add = (key: string, email?: string | null) => {
      const e = (email ?? '').trim().toLowerCase()
      if (!key || !e) return
      if (!emailsByCompany.has(key)) emailsByCompany.set(key, new Set())
      emailsByCompany.get(key)!.add(e)
    }
    for (const c of list) add(companyKey(c.company), c.email)
    for (const ct of contactRows ?? []) add(keyByCustomerId.get(ct.customer_id) ?? '', ct.email)
    const counts: Record<string, number> = {}
    for (const [k, set] of emailsByCompany) counts[k] = set.size
    setEmailCounts(counts)

    setCustomers(list)
    setLoading(false)
  }

  async function invite(customer: Customer) {
    if (!customer.email) return
    setInvitingId(customer.id)
    setMsg('')
    const { data, error } = await supabase.functions.invoke('invite-customer', {
      body: { email: customer.email, name: customer.name, redirectTo: `${window.location.origin}/set-password` },
    })
    setInvitingId(null)
    if (error) {
      let detail = error.message
      try {
        const ctx = (error as { context?: Response }).context
        if (ctx) { const body = await ctx.json(); if (body?.error) detail = body.error }
      } catch { /* ignore */ }
      setMsg(`Invite failed: ${detail}`)
      return
    }
    if (data?.ok) {
      setMsg(`Invitation sent to ${customer.email}.`)
      // Now they have an account but haven't signed in yet → "Invited".
      setAccountStatus(prev => new Map(prev).set(customer.email!.toLowerCase(), false))
    } else if (data?.error) {
      setMsg(`Invite failed: ${data.error}`)
    }
  }

  const filtered = customers.filter(c => {
    const q = search.toLowerCase()
    return !q
      || (c.company ?? '').toLowerCase().includes(q)
      || (c.name ?? '').toLowerCase().includes(q)
      || (c.email ?? '').toLowerCase().includes(q)
  })

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
        <p className="text-gray-500 text-sm mt-1">Synced from Zoho Books. Invite a customer to give them portal access.</p>
      </div>

      {msg && <div className="mb-4 text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-700">{msg}</div>}

      <div className="relative mb-4 max-w-sm">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by company, name, or email..."
          className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>
      ) : (
        <div className="bg-white border border-gray-200 rounded-xl divide-y divide-gray-50">
          {filtered.length === 0 ? (
            <div className="text-center py-14">
              <Users className="mx-auto text-gray-300 mb-3" size={40} />
              <p className="text-gray-500 text-sm font-medium">No customers found</p>
              <p className="text-gray-400 text-xs mt-1">Customers sync automatically from Zoho each time the dashboard loads.</p>
            </div>
          ) : filtered.map(c => {
            // undefined = no account, false = invited (not signed in), true = active
            const acct = c.email ? accountStatus.get(c.email.toLowerCase()) : undefined
            const onFile = emailCounts[companyKey(c.company)] ?? 0
            return (
              <div key={c.id} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                <Link to={`/customers/${c.id}`} className="min-w-0 flex-1 group">
                  <p className="text-sm font-medium text-gray-900 truncate group-hover:text-blue-600 transition-colors">{c.company || c.name || 'Unnamed customer'}</p>
                  <p className="text-xs text-gray-400 truncate">
                    {c.email
                      ? c.email
                      : onFile > 0
                        ? `${onFile} email${onFile === 1 ? '' : 's'} on file`
                        : 'No email on file'}
                  </p>
                </Link>
                <div className="ml-4 flex-shrink-0">
                  {!c.email ? (
                    onFile > 0 ? (
                      <span className="text-xs text-gray-400">View contacts</span>
                    ) : (
                      <span className="text-xs text-gray-400">No email</span>
                    )
                  ) : acct === true ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full"
                      title="Signed in — has portal access"
                    >
                      <Check size={12} /> Active
                    </span>
                  ) : acct === false ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2.5 py-1 rounded-full"
                      title="Invited — hasn't signed in yet"
                    >
                      <Clock size={12} /> Invited
                    </span>
                  ) : (
                    <button
                      onClick={() => setPendingInvite(c)}
                      disabled={invitingId === c.id}
                      className="inline-flex items-center gap-1.5 bg-blue-600 text-white text-sm font-semibold px-3 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      <Mail size={14} /> {invitingId === c.id ? 'Sending...' : 'Invite'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Invite confirmation modal — opens before any invite actually fires */}
      {pendingInvite && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setPendingInvite(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Send invitation?</h2>
            <p className="text-sm text-gray-500 mb-4">
              An invitation email will be sent so this person can set a password and access the Hydro-Wates customer portal.
            </p>

            <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5">
              <p className="text-sm font-medium text-gray-900">{pendingInvite.name || pendingInvite.company || pendingInvite.email}</p>
              <p className="text-xs text-gray-500 mt-0.5 truncate">{pendingInvite.email}</p>
              {pendingInvite.company && pendingInvite.name && (
                <p className="text-xs text-gray-400 mt-0.5">{pendingInvite.company}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setPendingInvite(null)}
                disabled={invitingId === pendingInvite.id}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const target = pendingInvite
                  setPendingInvite(null)
                  await invite(target)
                }}
                disabled={invitingId === pendingInvite.id}
                className="flex-1 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                Send invitation
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
