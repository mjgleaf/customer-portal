import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Users, Search, Mail, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import type { Customer } from '../types'

export default function CustomersPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [invitedEmails, setInvitedEmails] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [invitingId, setInvitingId] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    if (!profile) return
    if (profile.role !== 'admin') { navigate('/'); return }
    fetchData()
  }, [profile])

  async function fetchData() {
    setLoading(true)
    const { data: custs } = await supabase.from('customers').select('*').order('company', { ascending: true })
    const { data: profs } = await supabase.from('profiles').select('email')
    setInvitedEmails(new Set((profs ?? []).map(p => (p.email ?? '').toLowerCase()).filter(Boolean)))
    setCustomers((custs ?? []) as Customer[])
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
      setInvitedEmails(prev => new Set(prev).add(customer.email!.toLowerCase()))
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
              <p className="text-gray-400 text-xs mt-1">Run "Sync from Zoho" on the dashboard to pull customers in.</p>
            </div>
          ) : filtered.map(c => {
            const invited = c.email ? invitedEmails.has(c.email.toLowerCase()) : false
            return (
              <div key={c.id} className="flex items-center justify-between px-5 py-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 truncate">{c.company || c.name || 'Unnamed customer'}</p>
                  <p className="text-xs text-gray-400 truncate">{c.email || 'No email on file'}</p>
                </div>
                <div className="ml-4 flex-shrink-0">
                  {!c.email ? (
                    <span className="text-xs text-gray-400">No email</span>
                  ) : invited ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                      <Check size={12} /> Invited
                    </span>
                  ) : (
                    <button
                      onClick={() => invite(c)}
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
    </div>
  )
}
