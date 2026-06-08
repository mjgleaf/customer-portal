import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shield, UserPlus, Mail, Check, AlertCircle, X, HardHat, Phone } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// "Team" page. Lists portal admins + service techs.
//
// Admins: full controls — invite new members, change roles inline,
// remove team access.
//
// Service techs: read-only directory. The page is designed mobile-first
// for them since techs use the portal on their phones — large tap targets,
// tel: + mailto: links so they can call/email a PM straight from the list.

type InvitedRole = 'admin' | 'service_tech'

interface TeamRow {
  id: string
  email: string | null
  full_name: string | null
  phone: string | null
  role: string
  created_at: string
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

// Pretty-print a phone number for display. Falls back to the raw string
// if it doesn't look like a standard US number.
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  }
  return raw
}

export default function TeamPage() {
  const { profile } = useAuth()
  const navigate = useNavigate()

  const isAdmin = profile?.role === 'admin'
  const isServiceTech = profile?.role === 'service_tech'

  const [team, setTeam] = useState<TeamRow[]>([])
  const [loading, setLoading] = useState(true)

  // Invite form state (admin only)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState<InvitedRole>('admin')
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  // Confirmation modal for demote/remove actions
  const [pendingDemote, setPendingDemote] = useState<TeamRow | null>(null)
  const [demoting, setDemoting] = useState(false)

  // Client-side gate: admins + techs only. Customers get redirected.
  useEffect(() => {
    if (profile && !isAdmin && !isServiceTech) navigate('/')
  }, [profile, isAdmin, isServiceTech, navigate])

  useEffect(() => {
    if (!profile) return
    void fetchTeam()
  }, [profile])

  async function fetchTeam() {
    setLoading(true)
    const { data } = await supabase
      .from('cportal_profiles')
      .select('id, email, full_name, phone, role, created_at')
      .in('role', ['admin', 'service_tech'])
      .order('role', { ascending: true })
      .order('created_at', { ascending: true })
    setTeam((data ?? []) as TeamRow[])
    setLoading(false)
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!inviteEmail.trim()) return
    setSending(true)
    setMsg(null)

    const { data, error } = await supabase.functions.invoke('invite-customer', {
      body: {
        email: inviteEmail.trim(),
        name: inviteName.trim() || null,
        role: inviteRole,
        redirectTo: `${window.location.origin}/set-password`,
      },
    })

    setSending(false)
    if (error || data?.error) {
      let detail = error?.message || data?.error || 'Unknown error'
      try {
        const ctx = (error as { context?: Response } | null)?.context
        if (ctx) { const body = await ctx.json(); if (body?.error) detail = body.error }
      } catch { /* ignore */ }
      setMsg({ kind: 'error', text: detail })
      return
    }

    if (data?.warning) {
      setMsg({ kind: 'error', text: data.warning })
    } else {
      const roleLabel = inviteRole === 'admin' ? 'admin' : 'service tech'
      setMsg({ kind: 'success', text: `${roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)} invitation sent to ${inviteEmail}. They'll receive an email to set their password.` })
    }
    setInviteEmail('')
    setInviteName('')
    setInviteRole('admin')
    setShowInvite(false)
    await fetchTeam()
    setTimeout(() => setMsg(null), 8000)
  }

  async function confirmDemote(target: TeamRow) {
    setDemoting(true)
    const { error } = await supabase
      .from('cportal_profiles')
      .update({ role: 'customer' })
      .eq('id', target.id)
    setDemoting(false)
    if (error) {
      setMsg({ kind: 'error', text: `Couldn't remove: ${error.message}` })
    } else {
      setMsg({ kind: 'success', text: `${target.email || target.full_name} no longer has team access.` })
      setTimeout(() => setMsg(null), 6000)
      await fetchTeam()
    }
    setPendingDemote(null)
  }

  const [changingRoleId, setChangingRoleId] = useState<string | null>(null)
  async function changeRole(target: TeamRow, newRole: 'admin' | 'service_tech') {
    if (target.role === newRole) return
    setChangingRoleId(target.id)
    const { error } = await supabase
      .from('cportal_profiles')
      .update({ role: newRole })
      .eq('id', target.id)
    setChangingRoleId(null)
    if (error) {
      setMsg({ kind: 'error', text: `Couldn't change role: ${error.message}` })
      return
    }
    const label = newRole === 'admin' ? 'Admin' : 'Service Tech'
    setMsg({ kind: 'success', text: `${target.email || target.full_name} is now a ${label}.` })
    setTimeout(() => setMsg(null), 6000)
    await fetchTeam()
  }

  if (profile && !isAdmin && !isServiceTech) return null

  return (
    <div className="p-4 sm:p-8 max-w-5xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5 sm:mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Team</h1>
          <p className="text-gray-500 text-sm mt-1">
            Hydro-Wates staff with portal access.
            {(() => {
              const a = team.filter(t => t.role === 'admin').length
              const s = team.filter(t => t.role === 'service_tech').length
              const parts: string[] = []
              if (a > 0) parts.push(`${a} admin${a === 1 ? '' : 's'}`)
              if (s > 0) parts.push(`${s} service tech${s === 1 ? '' : 's'}`)
              return parts.length ? ` ${parts.join(', ')}.` : ''
            })()}
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => { setShowInvite(true); setMsg(null) }}
            className="flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors flex-shrink-0"
          >
            <UserPlus size={16} />
            Invite team member
          </button>
        )}
      </div>

      {msg && (
        <div className={`flex items-start gap-2 text-sm rounded-lg px-3 py-2 mb-4 ${
          msg.kind === 'success'
            ? 'bg-green-50 border border-green-200 text-green-700'
            : 'bg-red-50 border border-red-200 text-red-700'
        }`}>
          {msg.kind === 'success'
            ? <Check size={15} className="flex-shrink-0 mt-0.5" />
            : <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />}
          <span>{msg.text}</span>
        </div>
      )}

      <div className="bg-white border border-gray-200 rounded-xl">
        {loading ? (
          <div className="flex justify-center py-14">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
          </div>
        ) : team.length === 0 ? (
          <div className="text-center py-14">
            <Shield className="mx-auto text-gray-300 mb-3" size={40} />
            <p className="text-gray-500 text-sm font-medium">No team members yet</p>
            {isAdmin && (
              <p className="text-gray-400 text-xs mt-1">Click "Invite team member" to add your first one.</p>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {team.map(m => {
              const isMe = m.id === profile?.id
              const memberIsAdmin = m.role === 'admin'
              const displayName = m.full_name || m.email || 'Unnamed'
              return (
                <div key={m.id} className="px-4 sm:px-5 py-4">
                  <div className="flex items-start gap-3">
                    <div className={`w-10 h-10 sm:w-9 sm:h-9 rounded-full flex items-center justify-center flex-shrink-0 ${memberIsAdmin ? 'bg-blue-50' : 'bg-amber-50'}`}>
                      {memberIsAdmin
                        ? <Shield size={17} className="text-blue-600" />
                        : <HardHat size={17} className="text-amber-600" />}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-900 truncate">{displayName}</p>
                        <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-medium ${memberIsAdmin ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>
                          {memberIsAdmin ? 'Admin' : 'Service Tech'}
                        </span>
                        {isMe && <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 font-medium">You</span>}
                      </div>

                      {/* Contact actions — visible to everyone on the Team page.
                          On mobile these are large tap targets; on desktop a
                          tighter inline row. */}
                      <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 mt-2">
                        {m.phone && (
                          <a
                            href={`tel:${m.phone.replace(/[^+\d]/g, '')}`}
                            className="inline-flex items-center justify-center gap-2 text-sm font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 active:bg-blue-200 rounded-lg px-3 py-2 sm:py-1.5 transition-colors"
                          >
                            <Phone size={14} />
                            {formatPhone(m.phone)}
                          </a>
                        )}
                        {m.email && (
                          <a
                            href={`mailto:${m.email}`}
                            className="inline-flex items-center gap-2 text-sm text-gray-700 hover:text-gray-900 hover:bg-gray-50 rounded-lg px-3 py-2 sm:py-1.5 transition-colors truncate"
                          >
                            <Mail size={14} className="flex-shrink-0 text-gray-400" />
                            <span className="truncate">{m.email}</span>
                          </a>
                        )}
                      </div>

                      {!m.phone && (
                        <p className="text-[11px] text-gray-400 mt-1.5 italic">No phone number on file</p>
                      )}

                      <p className="text-[11px] text-gray-400 mt-1.5">Joined {formatDate(m.created_at)}</p>
                    </div>

                    {/* Admin-only inline controls. Hidden on small screens
                        to keep the card readable; admins on desktop see them
                        next to each row. */}
                    {isAdmin && !isMe && (
                      <div className="hidden sm:flex items-center gap-2 flex-shrink-0">
                        <select
                          value={m.role}
                          onChange={e => changeRole(m, e.target.value as 'admin' | 'service_tech')}
                          disabled={changingRoleId === m.id}
                          className="text-xs font-medium border border-gray-200 rounded-lg px-2 py-1.5 bg-white hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                          title="Change role"
                        >
                          <option value="admin">Admin</option>
                          <option value="service_tech">Service Tech</option>
                        </select>
                        <button
                          onClick={() => setPendingDemote(m)}
                          className="text-xs font-medium text-gray-500 hover:text-red-600 px-2 py-1 transition-colors"
                          title="Remove team access entirely"
                        >
                          Remove
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Mobile-only admin controls below the card body. */}
                  {isAdmin && !isMe && (
                    <div className="sm:hidden flex items-center gap-2 mt-3 pl-13">
                      <select
                        value={m.role}
                        onChange={e => changeRole(m, e.target.value as 'admin' | 'service_tech')}
                        disabled={changingRoleId === m.id}
                        className="text-xs font-medium border border-gray-200 rounded-lg px-2 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                      >
                        <option value="admin">Admin</option>
                        <option value="service_tech">Service Tech</option>
                      </select>
                      <button
                        onClick={() => setPendingDemote(m)}
                        className="text-xs font-medium text-gray-500 px-2 py-2"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {isServiceTech && (
        <p className="text-xs text-gray-400 mt-4">
          Tap a phone number to call, or an email to send a message. You can add or update your own number on the Account page.
        </p>
      )}
      {isAdmin && (
        <p className="text-xs text-gray-400 mt-4">
          Removing someone's team access converts their account to a regular customer account. Their portal login still works, but they only see their own projects (if any) instead of everyone's.
        </p>
      )}

      {/* Invite modal (admin only) */}
      {isAdmin && showInvite && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !sending && setShowInvite(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-1">
              <h2 className="text-lg font-semibold text-gray-900">Invite a team member</h2>
              <button onClick={() => !sending && setShowInvite(false)} className="text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              We'll email them a one-time link to set their password. Pick the right role — that determines what they see when they log in.
            </p>

            <form onSubmit={handleInvite} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Role <span className="text-red-500">*</span></label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setInviteRole('admin')}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                      inviteRole === 'admin' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <Shield size={15} />
                    Admin
                  </button>
                  <button
                    type="button"
                    onClick={() => setInviteRole('service_tech')}
                    className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                      inviteRole === 'service_tech' ? 'border-amber-500 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <HardHat size={15} />
                    Service tech
                  </button>
                </div>
                <p className="text-[11px] text-gray-500 mt-1.5">
                  {inviteRole === 'admin'
                    ? 'Full access — every project, customer, and quote request.'
                    : 'Sees only Service-type projects (not rentals or sales). Good for field crew.'}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={e => setInviteEmail(e.target.value)}
                  required
                  placeholder="someone@hydrowates.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Full name (optional)</label>
                <input
                  type="text"
                  value={inviteName}
                  onChange={e => setInviteName(e.target.value)}
                  placeholder="Jane Doe"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowInvite(false)}
                  disabled={sending}
                  className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={sending || !inviteEmail.trim()}
                  className="flex-1 inline-flex items-center justify-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  <Mail size={15} />
                  {sending ? 'Sending…' : 'Send invitation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Demote confirmation (admin only) */}
      {isAdmin && pendingDemote && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => !demoting && setPendingDemote(null)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-gray-900 mb-1">Remove team access?</h2>
            <p className="text-sm text-gray-500 mb-4">
              Their account stays active — they just won't be able to see every customer's projects anymore. You can re-promote them later if needed.
            </p>

            <div className="bg-gray-50 border border-gray-100 rounded-lg p-3 mb-5">
              <p className="text-sm font-medium text-gray-900">{pendingDemote.full_name || pendingDemote.email || 'Unnamed'}</p>
              {pendingDemote.email && pendingDemote.full_name && (
                <p className="text-xs text-gray-500 mt-0.5 truncate">{pendingDemote.email}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setPendingDemote(null)}
                disabled={demoting}
                className="flex-1 border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmDemote(pendingDemote)}
                disabled={demoting}
                className="flex-1 bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {demoting ? 'Removing…' : 'Remove'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
