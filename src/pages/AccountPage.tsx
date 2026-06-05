import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check, User, Lock, Bell, Mail, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Self-serve account page: update name, change password, toggle email
// notifications. Anyone signed in can see this.
export default function AccountPage() {
  const { user, profile, refreshProfile } = useAuth()

  // --- Profile (name) ---
  const [fullName, setFullName] = useState('')
  const [savingName, setSavingName] = useState(false)
  const [nameSavedAt, setNameSavedAt] = useState<number | null>(null)
  const [nameError, setNameError] = useState('')

  // --- Password ---
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [passwordSavedAt, setPasswordSavedAt] = useState<number | null>(null)
  const [passwordError, setPasswordError] = useState('')

  // --- Notifications ---
  const [emailOn, setEmailOn] = useState(true)
  const [savingPref, setSavingPref] = useState(false)
  const [prefSavedAt, setPrefSavedAt] = useState<number | null>(null)

  // --- System-wide customer email pause (admin only) ---
  // null = still loading, true = active (sending), false = paused.
  const [emailsActive, setEmailsActive] = useState<boolean | null>(null)
  const [savingPause, setSavingPause] = useState(false)
  const [pauseError, setPauseError] = useState('')

  useEffect(() => {
    if (!profile) return
    setFullName(profile.full_name ?? '')
    setEmailOn(profile.email_notifications !== false) // default true
  }, [profile])

  // Load the system-wide email pause state (admin only).
  useEffect(() => {
    if (!profile || profile.role !== 'admin') return
    supabase
      .from('app_settings')
      .select('value')
      .eq('key', 'emails_paused')
      .maybeSingle()
      .then(({ data }) => {
        // Default to paused (active = false) if the row doesn't exist yet.
        setEmailsActive(data?.value === 'false')
      })
  }, [profile])

  async function saveName() {
    if (!user) return
    setSavingName(true)
    setNameError('')
    const { error } = await supabase
      .from('profiles')
      .update({ full_name: fullName.trim() || null })
      .eq('id', user.id)
    setSavingName(false)
    if (error) { setNameError(error.message); return }
    setNameSavedAt(Date.now())
    refreshProfile?.()
  }

  async function savePassword() {
    setPasswordError('')
    if (password.length < 8) { setPasswordError('Password must be at least 8 characters.'); return }
    if (password !== confirmPassword) { setPasswordError('Passwords do not match.'); return }
    setSavingPassword(true)
    const { error } = await supabase.auth.updateUser({ password })
    setSavingPassword(false)
    if (error) { setPasswordError(error.message); return }
    setPassword('')
    setConfirmPassword('')
    setPasswordSavedAt(Date.now())
  }

  async function savePreference(next: boolean) {
    if (!user) return
    setEmailOn(next) // optimistic
    setSavingPref(true)
    const { error } = await supabase
      .from('profiles')
      .update({ email_notifications: next })
      .eq('id', user.id)
    setSavingPref(false)
    if (error) { setEmailOn(!next); return } // revert on failure
    setPrefSavedAt(Date.now())
    refreshProfile?.()
  }

  // Flip the system-wide "send emails to customers" switch. Stored as
  // app_settings.emails_paused ('true' | 'false'). Checked by every email-
  // sending edge function before delivering.
  async function toggleEmailsActive() {
    if (emailsActive === null) return
    const next = !emailsActive
    setSavingPause(true)
    setPauseError('')
    setEmailsActive(next) // optimistic
    const { error } = await supabase
      .from('app_settings')
      .upsert(
        { key: 'emails_paused', value: String(!next), updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      )
    setSavingPause(false)
    if (error) {
      setEmailsActive(!next) // revert
      setPauseError(error.message)
    }
  }

  if (!profile) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    )
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <Link to="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-6 transition-colors">
        <ArrowLeft size={16} /> Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Account</h1>
      <p className="text-gray-500 text-sm mb-8">{profile.email}</p>

      {/* Name */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
        <div className="flex items-center gap-2 mb-4">
          <User size={18} className="text-gray-400" />
          <h2 className="font-semibold text-gray-900">Your name</h2>
        </div>
        <input
          value={fullName}
          onChange={e => setFullName(e.target.value)}
          placeholder="Full name"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {nameError && <p className="text-red-600 text-xs mt-2">{nameError}</p>}
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={saveName}
            disabled={savingName || fullName.trim() === (profile.full_name ?? '').trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {savingName ? 'Saving...' : 'Save name'}
          </button>
          {nameSavedAt && Date.now() - nameSavedAt < 4000 && (
            <span className="flex items-center gap-1 text-green-600 text-xs"><Check size={14} /> Saved</span>
          )}
        </div>
      </div>

      {/* Password */}
      <div className="bg-white border border-gray-200 rounded-xl p-6 mb-5">
        <div className="flex items-center gap-2 mb-4">
          <Lock size={18} className="text-gray-400" />
          <h2 className="font-semibold text-gray-900">Change password</h2>
        </div>
        <div className="space-y-3">
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="New password (at least 8 characters)"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        {passwordError && <p className="text-red-600 text-xs mt-2">{passwordError}</p>}
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={savePassword}
            disabled={savingPassword || !password || !confirmPassword}
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {savingPassword ? 'Saving...' : 'Change password'}
          </button>
          {passwordSavedAt && Date.now() - passwordSavedAt < 4000 && (
            <span className="flex items-center gap-1 text-green-600 text-xs"><Check size={14} /> Updated</span>
          )}
        </div>
      </div>

      {/* Notifications */}
      <div className="bg-white border border-gray-200 rounded-xl p-6">
        <div className="flex items-center gap-2 mb-4">
          <Bell size={18} className="text-gray-400" />
          <h2 className="font-semibold text-gray-900">Email notifications</h2>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-gray-700">Email me when documents are uploaded to my projects</p>
            <p className="text-xs text-gray-400 mt-1">Turn off if you'd rather just check the portal yourself.</p>
          </div>
          <button
            onClick={() => savePreference(!emailOn)}
            disabled={savingPref}
            role="switch"
            aria-checked={emailOn}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${emailOn ? 'bg-blue-600' : 'bg-gray-300'} disabled:opacity-50`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${emailOn ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        {prefSavedAt && Date.now() - prefSavedAt < 4000 && (
          <p className="flex items-center gap-1 text-green-600 text-xs mt-3"><Check size={14} /> Saved</p>
        )}
      </div>

      {/* System-wide customer email pause (admin only) */}
      {profile.role === 'admin' && (
        <div className="bg-white border border-gray-200 rounded-xl p-6 mt-5">
          <div className="flex items-center gap-2 mb-4">
            <Mail size={18} className="text-gray-400" />
            <h2 className="font-semibold text-gray-900">Customer email notifications</h2>
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wide ml-1">Company-wide</span>
          </div>

          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-gray-700">
                {emailsActive === null
                  ? 'Loading…'
                  : emailsActive
                  ? 'Active — customers receive emails for uploads, reminders, and invites.'
                  : 'Paused — no emails are sent to customers right now.'}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                Affects every customer. Use this to suppress all outgoing emails while testing or before launch.
              </p>
            </div>
            <button
              onClick={toggleEmailsActive}
              disabled={savingPause || emailsActive === null}
              role="switch"
              aria-checked={emailsActive === true}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                emailsActive ? 'bg-blue-600' : 'bg-gray-300'
              } disabled:opacity-50`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  emailsActive ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>

          {emailsActive === false && (
            <div className="mt-4 flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
              <span>Uploads and reminders still happen in the portal — only the email step is skipped.</span>
            </div>
          )}

          {pauseError && <p className="text-red-600 text-xs mt-3">{pauseError}</p>}
        </div>
      )}
    </div>
  )
}
