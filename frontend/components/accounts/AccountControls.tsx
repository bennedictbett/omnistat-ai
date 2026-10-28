'use client'

import { useState } from 'react'
import { getSupabase, supabaseConfigError } from '@/lib/supabase'
import { useAccount } from './AccountProvider'

export default function AccountControls() {
  const { user, configured, loading, error: sessionError } = useAccount()
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (action: 'send' | 'verify' | 'logout') => {
    const client = getSupabase()
    if (!client) { setError('Account service is not configured.'); return }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      if (action === 'send') {
        const address = email.trim()
        const { error } = await client.auth.signInWithOtp({
          email: address, options: { emailRedirectTo: `${window.location.origin}/` },
        })
        if (error) throw error
        setSentTo(address)
        setMessage('Check your email. Open the sign-in link in this same browser, or enter the code if your email shows one. New accounts are created on first sign-in.')
      } else if (action === 'verify' && sentTo) {
        const { error } = await client.auth.verifyOtp({ email: sentTo, token: code.trim(), type: 'email' })
        if (error) throw error
        setCode('')
        setSentTo(null)
      } else if (action === 'logout') {
        const { error } = await client.auth.signOut({ scope: 'local' })
        if (error) throw error
        setCode('')
        setSentTo(null)
        setMessage('Signed out on this browser. Uploaded datasets remain in this browser; use a private browser profile on shared machines.')
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Account request failed. Please try again.')
    } finally { setBusy(false) }
  }

  if (loading) return <p role="status">Checking your account…</p>
  if (!configured) {
    const misconfigured = supabaseConfigError()
    return misconfigured
      ? <p role="alert" className="text-red-400">{misconfigured} Analyses still work without an account.</p>
      : <p>Cloud history is not configured. Analyses still work without an account.</p>
  }
  return (
    <section aria-label="Account" className="space-y-3 rounded-lg border border-gray-700 p-4">
      {sessionError && <p role="alert" className="text-red-400">{sessionError}</p>}
      {user ? (
        <div className="flex items-center gap-4">
          <p>Signed in as {user.email}</p>
          <button disabled={busy} onClick={() => act('logout')} className="text-blue-400">Sign out</button>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault()
          if (!busy) void act(sentTo ? 'verify' : 'send')
        }}>
          <p>Sign in or create an account with an email link or code.</p>
          <label className="block">Email
            <input type="email" required disabled={busy || !!sentTo} value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="ml-3 rounded bg-gray-800 p-2" autoComplete="email" />
          </label>
          {sentTo && <label className="block">Email code
            <input required value={code} pattern="[0-9]{6,10}" title="Enter the numeric code from the email" disabled={busy} onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code" inputMode="numeric" className="ml-3 rounded bg-gray-800 p-2" />
          </label>}
          <button disabled={busy} className="rounded bg-green-700 px-4 py-2">
            {busy ? 'Please wait…' : sentTo ? 'Verify code and sign in' : 'Send sign-in email'}
          </button>
          {sentTo && <button type="button" disabled={busy} onClick={() => {
            setSentTo(null); setCode(''); setMessage(null); setError(null)
          }} className="ml-3 text-blue-400">Change email or send a new email</button>}
        </form>
      )}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {message && <p role="status">{message}</p>}
    </section>
  )
}
