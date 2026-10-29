'use client'

import { useState } from 'react'
import { useAccount } from '@/components/accounts/AccountProvider'
import { saveAnalysis } from '@/lib/history'
import { analysisAuditFields, audit } from '@/lib/audit'
import type { RRunResult } from '@/lib/rApi'

export default function SaveAnalysis({ result }: { result: RRunResult }) {
  const { user, configured, loading } = useAccount()
  if (!result.ok || !configured || loading) return null
  if (!user) return <p className="text-sm text-gray-400">Sign in from History to save results to your account.</p>
  return <SaveForAccount key={user.id} result={result} userId={user.id} />
}

function SaveForAccount({ result, userId }: { result: RRunResult; userId: string }) {
  const [consent, setConsent] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (!consent || status !== 'idle') return
    setStatus('saving')
    setError(null)
    try {
      await saveAnalysis(result, userId)
      audit(() => analysisAuditFields(result).then((fields) => ({ ...fields, action: 'save_history' as const })))
      setStatus('saved')
    } catch (e) {
      setStatus('idle')
      setError(e instanceof Error ? e.message : 'Could not save this analysis.')
    }
  }
  return (
    <section aria-label="Save analysis" className="space-y-3 rounded-lg border border-gray-700 p-4 text-sm">
      <p>Saving uploads this result, charts, column labels, R code and any reviewed plan to your Supabase account. Raw dataset rows are not attached, but outputs can contain sensitive values and identifiers. Only save data you are authorized to store in the cloud.</p>
      <label className="block">
        <input type="checkbox" checked={consent} disabled={status !== 'idle'}
          onChange={(event) => setConsent(event.target.checked)} /> I consent to storing this result in cloud history.
      </label>
      <button disabled={!consent || status !== 'idle'} onClick={save} className="rounded bg-blue-700 px-4 py-2 disabled:opacity-50">
        {status === 'saved' ? 'Saved to History' : status === 'saving' ? 'Saving…' : 'Save to History'}
      </button>
      {status === 'saved' && <p role="status">Saved to your account.</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </section>
  )
}
