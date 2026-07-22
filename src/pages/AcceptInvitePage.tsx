import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import type { EmailOtpType } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// Intermediate "click to continue" landing page for email auth links
// (invite / recovery / magic link / signup).
//
// Why this exists: the email button used to point straight at Supabase's
// /auth/v1/verify endpoint, which consumes the single-use token on the FIRST
// GET. Corporate mail scanners (Microsoft Defender Safe Links, Mimecast, etc.)
// pre-fetch every link to inspect it, burning the token before the human ever
// clicks — so the real person got "link expired or invalid".
//
// This page does NOTHING on load. The token is only verified when the user
// actually clicks the button (verifyOtp runs in an onClick handler, never in
// an effect), so a scanner that merely fetches the page leaves the token
// intact for the human.

// Post-verification destination per link type.
const DESTINATION: Record<string, string> = {
  invite: '/set-password',
  signup: '/',
  recovery: '/reset-password',
  magiclink: '/',
  email: '/',
}

// Per-type copy for the landing card.
const COPY: Record<string, { title: string; body: string; cta: string }> = {
  invite: {
    title: 'Welcome to the Hydro-Wates portal',
    body: 'Click below to finish setting up your account and choose a password.',
    cta: 'Set up my account',
  },
  recovery: {
    title: 'Reset your password',
    body: 'Click below to continue and choose a new password.',
    cta: 'Continue',
  },
  magiclink: {
    title: 'Sign in to the portal',
    body: 'Click below to finish signing in.',
    cta: 'Sign in',
  },
  signup: {
    title: 'Confirm your account',
    body: 'Click below to confirm your account and continue.',
    cta: 'Confirm & continue',
  },
}

export default function AcceptInvitePage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const tokenHash = params.get('token_hash') || ''
  const type = (params.get('type') || '') as EmailOtpType
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')

  const copy = useMemo(
    () =>
      COPY[type] ?? {
        title: 'Continue to the portal',
        body: 'Click below to continue to your Hydro-Wates portal.',
        cta: 'Continue',
      },
    [type],
  )

  const missingParams = !tokenHash || !type

  async function handleContinue() {
    setError('')
    setVerifying(true)
    const { error: verifyErr } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    setVerifying(false)
    if (verifyErr) {
      setError(
        'This link has expired or has already been used. Please ask your Hydro-Wates contact to send a new one.',
      )
      return
    }
    navigate(DESTINATION[type] ?? '/', { replace: true })
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 w-full max-w-md p-8 text-center">
        <img src="/logo.png" alt="Hydro-Wates" className="h-14 w-auto mx-auto mb-4" />

        {missingParams ? (
          <>
            <h1 className="text-xl font-bold text-gray-900 mb-2">Link incomplete</h1>
            <p className="text-gray-500 text-sm">
              This link is missing information. Please open the most recent email we sent, or ask
              your contact to send a new one.
            </p>
            <Link
              to="/login"
              className="inline-block mt-6 text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              Go to sign in
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-gray-900">{copy.title}</h1>
            <p className="text-gray-500 text-sm mt-1 mb-6">{copy.body}</p>

            {error && (
              <p className="text-red-600 text-sm bg-red-50 px-3 py-2 rounded-lg mb-4 text-left">
                {error}
              </p>
            )}

            <button
              onClick={handleContinue}
              disabled={verifying}
              className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              {verifying ? 'Verifying...' : copy.cta}
            </button>

            {error && (
              <Link
                to="/forgot-password"
                className="inline-block mt-4 text-sm font-medium text-blue-600 hover:text-blue-700"
              >
                Request a new link
              </Link>
            )}
          </>
        )}
      </div>
    </div>
  )
}
