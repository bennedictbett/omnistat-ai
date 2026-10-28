'use client'

import { useEffect, useState } from 'react'
import {
  AUDIT_PAGE_SIZE, AuditEvent, ChainVerification, exportAuditLog, listAuditEvents, useAuditFailure, verifyAuditChain,
} from '@/lib/audit'

const ACTIONS: Record<string, string> = {
  upload_data: 'Uploaded data', run_analysis: 'Ran analysis', save_history: 'Saved to history',
  export: 'Exported', ai_suggestion_accepted: 'Accepted AI suggestion',
}
const short = (hash: string | null) => (hash ? `${hash.slice(0, 10)}…` : '—')

export function AuditFailureBanner() {
  const [message, dismiss] = useAuditFailure()
  if (!message) return null
  return (
    <div role="alert" className="mb-4 flex items-start justify-between gap-4 rounded border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm text-yellow-400">
      <span>{message}</span>
      <button onClick={dismiss} className="text-gray-300">Dismiss</button>
    </div>
  )
}

export default function AuditLog() {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [verification, setVerification] = useState<ChainVerification | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    listAuditEvents(page).then((rows) => { if (active) setEvents(rows) })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Could not load the audit log.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [page, refresh])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The audit request failed.')
    } finally {
      setBusy(false)
    }
  }

  const verify = () => run(async () => setVerification(await verifyAuditChain()))
  const exportLog = () => run(async () => {
    const url = URL.createObjectURL(await exportAuditLog())
    const link = document.createElement('a')
    link.href = url
    link.download = `omnistat-audit-log-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    // Let the browser start the download before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  })

  return (
    <section aria-label="Audit log" className="space-y-3 rounded-lg border border-gray-700 p-4 text-sm">
      <h3 className="font-medium text-white">Audit log</h3>
      <p className="text-gray-400">
        While you are signed in, uploads, analysis runs, saves and exports are recorded automatically. Entries store
        fingerprints (SHA-256) of data, code and plans, not the data itself. They cannot be edited or deleted, and each
        entry is chained to the previous one so changes are detectable.
      </p>
      <div className="flex flex-wrap gap-2">
        <button onClick={verify} disabled={busy} className="rounded bg-blue-700 px-3 py-1 text-white disabled:opacity-50">Verify integrity</button>
        <button onClick={exportLog} disabled={busy} className="rounded border border-gray-600 px-3 py-1 disabled:opacity-50">Export JSON</button>
        <button onClick={() => setRefresh((n) => n + 1)} disabled={busy || loading} className="rounded border border-gray-600 px-3 py-1 disabled:opacity-50">Refresh</button>
      </div>
      {verification && (verification.ok
        ? <p role="status" className="text-green-400">Integrity verified: all {verification.events} entries are intact and correctly chained.</p>
        : <p role="alert" className="text-red-400">Integrity check failed at entry {verification.first_invalid_seq}: {verification.reason} Contact your administrator.</p>)}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {loading ? <p>Loading audit log…</p> : events.length === 0 ? <p className="text-gray-500">No audit entries on this page.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-gray-500">
              <tr><th className="pr-3">#</th><th className="pr-3">Time</th><th className="pr-3">Action</th><th className="pr-3">Procedure</th><th className="pr-3">Data</th><th className="pr-3">Code</th><th>Entry hash</th></tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.event_id} className="border-t border-gray-800 font-mono">
                  <td className="pr-3">{e.seq}</td>
                  <td className="pr-3 font-sans">{new Date(e.created_at).toLocaleString()}</td>
                  <td className="pr-3 font-sans">{ACTIONS[e.action] ?? e.action}{typeof e.details.format === 'string' ? ` (${e.details.format})` : ''}{e.details.ok === false ? ' — failed' : ''}</td>
                  <td className="pr-3">{e.procedure ?? '—'}</td>
                  <td className="pr-3" title={e.dataset_hash ?? undefined}>{short(e.dataset_hash)}</td>
                  <td className="pr-3" title={e.code_hash ?? undefined}>{short(e.code_hash)}</td>
                  <td title={e.hash}>{short(e.hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)} className="text-blue-400 disabled:text-gray-600">Newer</button>
        <span>Page {page + 1}</span>
        <button disabled={events.length < AUDIT_PAGE_SIZE || loading} onClick={() => setPage((p) => p + 1)} className="text-blue-400 disabled:text-gray-600">Older</button>
      </div>
    </section>
  )
}
