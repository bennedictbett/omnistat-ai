'use client'

import { useState } from 'react'
import { FileText, Printer } from 'lucide-react'
import { RRunResult } from '@/lib/rApi'
import { buildReportHtml, printReport } from '@/lib/analysisReport'
import { buildWordReport, downloadWordReport } from '@/lib/wordReport'
import { analysisAuditFields, audit } from '@/lib/audit'

export default function AnalysisReport({ result, valueLabels = {} }: {
  result: RRunResult
  valueLabels?: Record<string, Record<string, string>>
}) {
  const [busy, setBusy] = useState<'print' | 'word' | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!result.ok) return null

  const run = async (kind: 'print' | 'word') => {
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'print') await printReport(buildReportHtml(result, new Date(), valueLabels))
      else downloadWordReport(await buildWordReport(result, valueLabels), result.title)
      audit(() => analysisAuditFields(result).then((fields) => ({
        ...fields, action: 'export' as const, details: { ...fields.details, format: kind === 'print' ? 'pdf_print' : 'docx' },
      })))
    } catch (e) {
      setError(kind === 'word'
        ? 'Could not create the Word document. Your result remains on screen.'
        : e instanceof Error ? e.message : 'Could not prepare the report. Your result remains on screen.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Analysis report" className="space-y-2 rounded-lg border border-gray-700 p-4 text-sm text-gray-300">
      <h3 className="font-medium text-white">Report</h3>
      <p>
        Print or save as PDF, or download an editable Word document with APA-style statistics and tables. Both
        include the plain-English summary, methods, charts and the R script. Reports are created in this browser
        and are not uploaded or saved. They can include sensitive group labels or values.
      </p>
      <div className="flex flex-wrap gap-2">
        <button onClick={() => run('print')} disabled={busy !== null}
          className="flex items-center gap-2 rounded bg-gray-700 px-4 py-2 text-white disabled:opacity-50">
          <Printer size={16} /> {busy === 'print' ? 'Preparing report…' : 'Print / Save as PDF'}
        </button>
        <button onClick={() => run('word')} disabled={busy !== null}
          className="flex items-center gap-2 rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">
          <FileText size={16} /> {busy === 'word' ? 'Creating document…' : 'Download Word (.docx)'}
        </button>
      </div>
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </section>
  )
}
