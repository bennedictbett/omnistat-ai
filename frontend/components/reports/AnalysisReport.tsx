'use client'

import { useState } from 'react'
import { Printer } from 'lucide-react'
import { RRunResult } from '@/lib/rApi'
import { buildReportHtml, printReport } from '@/lib/analysisReport'

export default function AnalysisReport({ result, valueLabels = {} }: {
  result: RRunResult
  valueLabels?: Record<string, Record<string, string>>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!result.ok) return null

  const print = async () => {
    setBusy(true)
    setError(null)
    try {
      await printReport(buildReportHtml(result, new Date(), valueLabels))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the report. Your result remains on screen.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label="Analysis report" className="space-y-2 rounded-lg border border-gray-700 p-4 text-sm text-gray-300">
      <h3 className="font-medium text-white">Printable report</h3>
      <p>
        Opens your browser’s print dialog with methods, results, charts and the R script. Choose
        “Save as PDF” to keep a copy. The report is created in this browser and is not uploaded or saved.
        It can include sensitive group labels or values.
      </p>
      <button onClick={print} disabled={busy}
        className="flex items-center gap-2 rounded bg-gray-700 px-4 py-2 text-white disabled:opacity-50">
        <Printer size={16} /> {busy ? 'Preparing report…' : 'Print / Save as PDF'}
      </button>
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </section>
  )
}
