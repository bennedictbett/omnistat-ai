'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { getSupabase } from '@/lib/supabase'

interface AccountState {
  user: User | null
  loading: boolean
  configured: boolean
  error: string | null
}

const AccountContext = createContext<AccountState>({
  user: null, loading: false, configured: false, error: null,
})

export function useAccount() {
  return useContext(AccountContext)
}

/** Reads an error Supabase appended to a sign-in link redirect (e.g. an expired link) and removes it from the URL. */
export function takeSignInLinkError(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  new URLSearchParams(window.location.search).forEach((value, key) => { if (!params.has(key)) params.set(key, value) })
  const description = params.get('error_description') ?? params.get('error')
  if (!description) return null
  window.history.replaceState(null, '', window.location.pathname)
  return `The sign-in link could not be used (${description.replace(/\+/g, ' ')}). Request a new sign-in email.`
}

export default function AccountProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AccountState>({
    user: null, loading: true, configured: false, error: null,
  })
  useEffect(() => {
    const client = getSupabase()
    if (!client) {
      setState({ user: null, loading: false, configured: false, error: null })
      return
    }
    let active = true
    let authChanged = false
    const linkError = takeSignInLinkError()
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      authChanged = true
      if (active) setState({ user: session?.user ?? null, loading: false, configured: true, error: session ? null : linkError })
    })
    client.auth.getSession().then(({ data, error }) => {
      if (active && !authChanged) setState({
        user: data.session?.user ?? null, loading: false, configured: true,
        error: linkError ?? (error ? 'Could not restore your sign-in session. Please sign in again.' : null),
      })
    }).catch(() => {
      if (active && !authChanged) setState({ user: null, loading: false, configured: true, error: 'Could not connect to the account service.' })
    })
    return () => { active = false; subscription.unsubscribe() }
  }, [])
  return <AccountContext.Provider value={state}>{children}</AccountContext.Provider>
}
