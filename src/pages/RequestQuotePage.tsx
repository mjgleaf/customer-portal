import { useEffect, useState, type ChangeEvent } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Upload, X, Check, FileText, AlertCircle } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'

// Customer-facing Request-for-Quote form. Mirrors the MODX FormIt RFQ form
// on hydrowates.com but lives inside the portal: name/company/email are
// pre-filled from the logged-in profile, attachments upload to the private
// `quote-attachments` storage bucket, and submission goes through the
// submit-quote-request edge function (which inserts the row, emails the
// sales mailbox, and forwards to Power Automate for legacy automation).

const QUOTE_TYPES = [
  'Load Test Service',
  'Rent Equipment',
  'Purchase Equipment',
  'Help Me Decide',
] as const

const ALLOWED_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.pdf', '.doc', '.docx']
const MAX_FILES = 3
const MAX_FILE_BYTES = 10 * 1024 * 1024 // 10 MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

export default function RequestQuotePage() {
  const { user, profile } = useAuth()

  // Form fields
  const [name, setName] = useState('')
  const [company, setCompany] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [requestTypes, setRequestTypes] = useState<string[]>([])
  const [comments, setComments] = useState('')
  const [files, setFiles] = useState<File[]>([])

  // Submission state
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  // Autofill state — true while we're looking up the customer's Zoho record,
  // false once we either find it or give up. Lets the form show a small
  // "Loading your saved info…" hint instead of an empty flash.
  const [autofilling, setAutofilling] = useState(true)
  const [autofilledFromZoho, setAutofilledFromZoho] = useState(false)

  // Pre-fill from the logged-in profile once loaded.
  useEffect(() => {
    if (!profile) return
    setName(prev => prev || profile.full_name || '')
    setCompany(prev => prev || profile.company || '')
    setEmail(prev => prev || profile.email || '')
  }, [profile])

  // Pre-fill the rest from the customer record (synced from Zoho Books).
  // Matches by the logged-in user's email. Uses the customer's shipping
  // address by default since that's where service equipment ships to.
  // RLS already scopes customers to the current user — `.maybeSingle()`
  // returns null cleanly if no Zoho match exists.
  useEffect(() => {
    if (!profile?.email) return
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('customers')
        .select('name, company, email, phone, shipping_address, shipping_city, shipping_state, shipping_zip')
        .ilike('email', profile.email!)
        .maybeSingle()
      if (cancelled) return
      if (data) {
        // Only overwrite empty fields so a customer who already started
        // typing isn't surprised by their input getting replaced.
        setName(prev => prev || data.name || '')
        setCompany(prev => prev || data.company || '')
        setEmail(prev => prev || data.email || '')
        setPhone(prev => prev || data.phone || '')
        setAddress(prev => prev || data.shipping_address || '')
        setCity(prev => prev || data.shipping_city || '')
        setState(prev => prev || data.shipping_state || '')
        setZip(prev => prev || data.shipping_zip || '')
        setAutofilledFromZoho(true)
      }
      setAutofilling(false)
    })()
    return () => { cancelled = true }
  }, [profile?.email])

  function toggleRequestType(t: string) {
    setRequestTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t])
  }

  function handleFilePick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? [])
    e.target.value = '' // reset so re-picking same file fires onChange
    setError('')
    const accepted: File[] = []
    for (const f of picked) {
      if (files.length + accepted.length >= MAX_FILES) {
        setError(`You can attach at most ${MAX_FILES} files.`)
        break
      }
      const ext = '.' + (f.name.split('.').pop() ?? '').toLowerCase()
      if (!ALLOWED_EXT.includes(ext)) {
        setError(`"${f.name}" — only ${ALLOWED_EXT.join(', ')} allowed.`)
        continue
      }
      if (f.size > MAX_FILE_BYTES) {
        setError(`"${f.name}" is over 10 MB.`)
        continue
      }
      accepted.push(f)
    }
    if (accepted.length > 0) setFiles(prev => [...prev, ...accepted])
  }

  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    // Client-side validation (the edge function also validates server-side)
    if (!name.trim() || !email.trim() || !comments.trim()) {
      setError('Name, email, and message are required.')
      return
    }
    if (requestTypes.length === 0) {
      setError('Pick at least one quote type.')
      return
    }
    if (!user) {
      setError('You must be logged in to request a quote.')
      return
    }

    setSubmitting(true)
    try {
      // 1. Upload attachments to quote-attachments bucket (under the
      //    user's auth.uid() folder — RLS enforces that scoping).
      const attachmentPaths: string[] = []
      for (const f of files) {
        const path = `${user.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${f.name}`
        const { error: upErr } = await supabase.storage.from('quote-attachments').upload(path, f)
        if (upErr) {
          setError(`Couldn't upload "${f.name}": ${upErr.message}`)
          setSubmitting(false)
          return
        }
        attachmentPaths.push(path)
      }

      // 2. Submit the form data to the edge function
      const { data, error: invokeErr } = await supabase.functions.invoke('submit-quote-request', {
        body: {
          name: name.trim(),
          company: company.trim() || null,
          phone: phone.trim() || null,
          email: email.trim(),
          address: address.trim() || null,
          city: city.trim() || null,
          state: state.trim() || null,
          zip: zip.trim() || null,
          requestTypes,
          comments: comments.trim(),
          attachmentPaths,
          portalUrl: window.location.origin,
        },
      })
      if (invokeErr || data?.error) {
        setError(`Couldn't submit: ${invokeErr?.message || data?.error}`)
        setSubmitting(false)
        return
      }

      setSuccess(true)
      // Reset the form's quote-specific fields. Keep contact info filled so
      // a second request doesn't require retyping name/email/etc.
      setRequestTypes([])
      setComments('')
      setFiles([])
    } catch (e) {
      setError(`Something went wrong: ${(e as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  // Success state — show confirmation, offer to submit another.
  if (success) {
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <Link to="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-6 transition-colors">
          <ArrowLeft size={16} /> Back to Dashboard
        </Link>
        <div className="bg-white border border-gray-200 rounded-xl p-8 text-center">
          <div className="w-12 h-12 rounded-full bg-green-100 text-green-600 flex items-center justify-center mx-auto mb-4">
            <Check size={24} />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Quote request sent</h2>
          <p className="text-gray-500 text-sm mb-6">
            Thanks — the Hydro-Wates team has been notified and will be in touch shortly.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link
              to="/"
              className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              Back to Dashboard
            </Link>
            <button
              onClick={() => setSuccess(false)}
              className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors"
            >
              Submit another
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <Link to="/" className="inline-flex items-center gap-2 text-gray-500 hover:text-gray-700 text-sm mb-6 transition-colors">
        <ArrowLeft size={16} /> Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold text-gray-900 mb-1">Request a Quote</h1>
      <p className="text-gray-500 text-sm mb-6">Tell us what you need and we'll get back to you.</p>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Contact details */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <h2 className="font-semibold text-gray-900">Your contact details</h2>
            {autofilling ? (
              <span className="text-[11px] text-gray-400 italic">Loading your saved info…</span>
            ) : autofilledFromZoho ? (
              <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">Auto-filled from Zoho</span>
            ) : null}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Full Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Company</label>
              <input
                type="text"
                value={company}
                onChange={e => setCompany(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Email <span className="text-red-500">*</span></label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-gray-700 mb-1">Address</label>
              <input
                type="text"
                value={address}
                onChange={e => setAddress(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">City</label>
              <input
                type="text"
                value={city}
                onChange={e => setCity(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">State</label>
                <input
                  type="text"
                  value={state}
                  onChange={e => setState(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Zip</label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={zip}
                  onChange={e => setZip(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Quote types */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Quote type(s) <span className="text-red-500">*</span></h2>
          <p className="text-xs text-gray-500 mb-4">Pick all that apply.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {QUOTE_TYPES.map(t => {
              const checked = requestTypes.includes(t)
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleRequestType(t)}
                  className={`px-4 py-3 rounded-full border text-sm font-medium transition-colors text-center ${
                    checked
                      ? 'bg-slate-800 text-white border-slate-800'
                      : 'bg-gray-50 text-gray-600 border-gray-200 hover:border-gray-300'
                  }`}
                >
                  {t}
                </button>
              )
            })}
          </div>
        </div>

        {/* Message */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Message <span className="text-red-500">*</span></h2>
          <p className="text-xs text-gray-500 mb-4">Tell us about your project — location, test load, headroom, timeline, etc.</p>
          <textarea
            value={comments}
            onChange={e => setComments(e.target.value)}
            required
            rows={6}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {/* Attachments */}
        <div className="bg-white border border-gray-200 rounded-xl p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Attachments</h2>
          <p className="text-xs text-gray-500 mb-4">Up to {MAX_FILES} files, 10 MB each. Accepted: {ALLOWED_EXT.join(', ')}.</p>

          {files.length < MAX_FILES && (
            <label className="inline-flex items-center gap-2 bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-blue-700 transition-colors cursor-pointer">
              <Upload size={15} />
              Add files
              <input
                type="file"
                multiple
                accept={ALLOWED_EXT.join(',')}
                onChange={handleFilePick}
                className="hidden"
              />
            </label>
          )}

          {files.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-gray-700 bg-gray-50 border border-gray-100 rounded-lg px-3 py-2">
                  <FileText size={13} className="text-gray-400 flex-shrink-0" />
                  <span className="truncate flex-1">{f.name}</span>
                  <span className="text-gray-400 flex-shrink-0">{formatBytes(f.size)}</span>
                  <button
                    type="button"
                    onClick={() => removeFile(i)}
                    className="text-gray-400 hover:text-red-500 flex-shrink-0"
                    aria-label="Remove file"
                  >
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-3 py-2">
            <AlertCircle size={15} className="flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <Link
            to="/"
            className="border border-gray-300 text-gray-700 px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="bg-blue-600 text-white px-5 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Sending…' : 'Request Now'}
          </button>
        </div>
      </form>
    </div>
  )
}
