'use client'

import { useEffect, useState } from 'react'
import { AlertCircle } from 'lucide-react'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { CURVE_FIT_TESTS, CurveFitTest, RApiError, RTestCatalog, fetchRTests } from '@/lib/rApi'
import { segClass } from './chartStyles'

const MODELS: Record<CurveFitTest, { label: string; hint: string }> = {
  dose_response_4pl: {
    label: 'Dose-response (4PL)',
    hint: 'EC50 / IC50 from a sigmoidal curve. x is the concentration; it is fitted on a log10 scale.',
  },
  michaelis_menten: {
    label: 'Michaelis-Menten / one-site binding',
    hint: 'Vmax and Km (Bmax and Kd for binding data) from a hyperbola.',
  },
}

// A stable reference: RAnalysisPanel resets its pickers whenever this prop changes identity.
const NO_HINTS: string[] = []

export default function CurveFit() {
  const [catalog, setCatalog] = useState<RTestCatalog | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [model, setModel] = useState<CurveFitTest>('dose_response_4pl')

  useEffect(() => {
    let cancelled = false
    fetchRTests()
      .then((c) => {
        if (!cancelled) setCatalog(c)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof RApiError ? e.message : 'Could not load the curve-fit models.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const spec = catalog?.[model]

  return (
    <div className="space-y-5 max-w-5xl">
      <p className="text-xs text-gray-500">
        Fit a curve to your uploaded data and get the parameters with 95% confidence intervals. The fit runs in R on the server.
      </p>

      <div>
        <p className="text-xs text-gray-500 mb-2">Model</p>
        <div className="flex flex-wrap gap-2">
          {CURVE_FIT_TESTS.map((m) => (
            <button key={m} onClick={() => setModel(m)} title={MODELS[m].hint} className={segClass(model === m)}>
              {MODELS[m].label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-2">{MODELS[model].hint}</p>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!catalog && !error && (
        <p className="text-xs text-gray-500">Loading models… the server can take up to a minute to wake up.</p>
      )}

      {catalog && !spec && (
        <p className="text-sm text-yellow-400">This server does not have curve fitting yet. It needs the latest backend version.</p>
      )}

      {spec && <RAnalysisPanel test={model} spec={spec} intentVariables={NO_HINTS} />}
    </div>
  )
}