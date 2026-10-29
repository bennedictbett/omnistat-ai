'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import AccountControls from '@/components/accounts/AccountControls'
import AuditLog from '@/components/audit/AuditLog'
import { useAccount } from '@/components/accounts/AccountProvider'
import { ResultView } from '@/components/jarvis/RAnalysisPanel'
import { deleteAnalysis, HISTORY_PAGE_SIZE, HistoryItem, listAnalyses, openAnalysis } from '@/lib/history'
import type { RRunResult } from '@/lib/rApi'

export default function AnalysisHistory() {
  const { user } = useAccount()
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <h2 className="text-lg font-semibold">Account and Analysis History</h2>
      <AccountControls />
      {user && <UserHistory key={user.id} userId={user.id} />}
      {user && <AuditLog key={`audit-${user.id}`} />}
    </div>
  )
}

function UserHistory({ userId }: { userId: string }) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [page, setPage] = useState(0)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ id: string; result: RRunResult } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    setItems([])
    listAnalyses(userId, page).then((rows) => { if (active) setItems(rows) })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : 'Could not load history.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [userId, page, refresh])

  const act = async (item: HistoryItem, remove: boolean) => {
    setBusy(true)
    setError(null)
    try {
      if (remove) {
        await deleteAnalysis(userId, item.id)
        if (selected?.id === item.id) setSelected(null)
        setDeleting(null)
        setRefresh((n) => n + 1)
      } else {
        setSelected(null)
        setSelected({ id: item.id, result: await openAnalysis(userId, item.id) })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'History request failed.')
    } finally { setBusy(false) }
  }
  return (
    <section aria-label="Saved analyses" className="space-y-4">
      <p className="text-sm text-gray-400">Saved results are snapshots, not restored datasets or a tamper-proof audit log. Re-running requires the original file. <Link href="/" className="text-blue-400">Back to workstation</Link></p>
      <button disabled={busy || loading} onClick={() => setRefresh((n) => n + 1)} className="text-blue-400">Refresh history</button>
      {loading && <p role="status">Loading history…</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {!loading && !error && !items.length && <p>No saved analyses on this page.</p>}
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.id} className="space-y-2 rounded border border-gray-700 p-4">
            <p>{item.title} · {new Date(item.created_at).toLocaleString()}</p>
            <button disabled={busy || loading} onClick={() => act(item, false)} className="mr-4 text-blue-400">Open result</button>
            <button disabled={busy || loading} onClick={() => setDeleting(item.id)} className="text-red-400">Delete</button>
            {deleting === item.id && <div>
              <p>Permanently delete this saved result?</p>
              <button disabled={busy} onClick={() => act(item, true)} className="mr-4 text-red-400">Confirm deletion</button>
              <button disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
            </div>}
          </li>
        ))}
      </ul>
      <div className="flex gap-4">
        <button disabled={busy || loading || page === 0} onClick={() => setPage((n) => n - 1)}>Previous</button>
        <span>Page {page + 1}</span>
        <button disabled={busy || loading || !!error || items.length < HISTORY_PAGE_SIZE} onClick={() => setPage((n) => n + 1)}>Next</button>
      </div>
      {selected && <div className="space-y-4 rounded border border-gray-700 p-4">
        <button onClick={() => setSelected(null)} className="text-blue-400">Close result</button>
        <ResultView result={selected.result} />
        {selected.result.analysis_plan && <details>
          <summary>Executed analysis specification</summary>
          <pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(selected.result.analysis_plan, null, 2)}</pre>
        </details>}
      </div>}
    </section>
  )
}
