import { useState, type FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

export default function LoginPage() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [msLoading, setMsLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    setLoading(false)
    if (error) setError(error)
    else navigate('/')
  }

  // Microsoft (Azure AD) SSO for Hydro-Wates employees. Supabase Auth
  // matches the OAuth'd email to an existing user (set up via the
  // Team page invite flow) and links the Microsoft identity to it —
  // so the role the admin chose during invite is preserved.
  async function handleMicrosoftLogin() {
    setError('')
    setMsLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'azure',
      options: {
        scopes: 'openid profile email',
        redirectTo: window.location.origin,
      },
    })
    // signInWithOAuth navigates to Microsoft; if we land back here it
    // means setup is incomplete (e.g. Azure provider not enabled yet).
    if (error) {
      setError(error.message)
      setMsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-8">
        <div className="text-center mb-8">
          <img src="/logo.png" alt="Hydro-Wates" className="h-16 w-auto mx-auto mb-4" />
          <p className="text-gray-500 text-sm mt-1">Sign in to your customer portal</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
          <Link to="/forgot-password" className="block text-center text-sm text-blue-600 hover:text-blue-700">
            Forgot password?
          </Link>
        </form>

        {/* SSO divider + Microsoft button. Customers use email/password
            above; Hydro-Wates employees use the Microsoft button below to
            sign in with their company account. */}
        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-200" />
          </div>
          <div className="relative flex justify-center text-xs uppercase tracking-wider">
            <span className="bg-white px-2 text-gray-400">or</span>
          </div>
        </div>

        <button
          type="button"
          onClick={handleMicrosoftLogin}
          disabled={msLoading}
          className="w-full bg-white border border-gray-300 text-gray-800 py-2.5 rounded-lg text-sm font-semibold hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors inline-flex items-center justify-center gap-2.5"
        >
          {/* Inline Microsoft 4-square mark; no external dependency. */}
          <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">
            <rect width="10" height="10" x="1"  y="1"  fill="#F25022" />
            <rect width="10" height="10" x="12" y="1"  fill="#7FBA00" />
            <rect width="10" height="10" x="1"  y="12" fill="#00A4EF" />
            <rect width="10" height="10" x="12" y="12" fill="#FFB900" />
          </svg>
          {msLoading ? 'Redirecting…' : 'Sign in with Microsoft'}
        </button>
        <p className="text-[11px] text-gray-400 text-center mt-2">
          For Hydro-Wates employees — uses your company Microsoft account.
        </p>
      </div>
    </div>
  )
}
