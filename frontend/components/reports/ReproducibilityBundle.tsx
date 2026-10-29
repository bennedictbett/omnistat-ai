'use client'

import { useState } from 'react'
import { RApiError, RRunResult } from '@/lib/rApi'
import { downloadBundle, fetchBundle } from '@/lib/reproducibilityBundle'
import { analysisAuditFields, audit } from '@/lib/audit'

export default function ReproducibilityBundle({
  result, rows,
}: { result: RRunResult; rows: Record<string, unknown>[] }) {
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [downloaded, setDownloaded] = useState(false)
  if (!result.ok) return null

  const download = async () => {
    if (!consent || busy) return
    setBusy(true)
    setError(null)
    setDownloaded(false)
    try {
      downloadBundle(await fetchBundle(result, rows))
      audit(() => analysisAuditFields(result).then((fields) => ({
        ...fields, action: 'export' as const, details: { ...fields.details, format: 'reproducibility_zip' },
      })))
      setDownloaded(true)
    } catch (e) {
      setError(e instanceof RApiError ? e.message : 'Could not create the download. Your analysis is still available on screen.')
    } finally { setBusy(false) }
  }
  return (
    <section aria-label="Reproducibility bundle" className="space-y-3 rounded-lg border border-gray-700 p-4 text-sm text-gray-300">
      <h3 className="font-medium text-white">Download reproducibility bundle</h3>
      <p>The ZIP contains the selected data rows sent to R, code, results, charts, manifest and reviewed plan when available.
        It can contain sensitive patient data. Export sends those selected rows back to the configured analysis server to verify the fingerprint;
        it does not rerun the analysis or save the bundle to account history.</p>
      <label className="block">
        <input type="checkbox" checked={consent} disabled={busy}
          onChange={(event) => setConsent(event.target.checked)} /> I am authorized to download and store these data and results.
      </label>
      <button disabled={!consent || busy} onClick={download} className="rounded bg-blue-700 px-4 py-2 disabled:opacity-50">
        {busy ? 'Preparing ZIP…' : 'Download ZIP'}
      </button>
      {downloaded && <p role="status">Download requested. Check your browser downloads.</p>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </section>
  )
}
