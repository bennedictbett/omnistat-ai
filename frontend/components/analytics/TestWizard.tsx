'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, RotateCcw } from 'lucide-react'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { RApiError, RTestCatalog, fetchRTests } from '@/lib/rApi'
import { START, WIZARD, WizardNode, WizardOption } from '@/lib/testWizard'

// Stable reference: RAnalysisPanel resets its pickers whenever this prop changes identity.
const NO_HINTS: string[] = []

interface Step {
  id: string
  answer: string
}

export default function TestWizard() {
  const [catalog, setCatalog] = useState<RTestCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [nodeId, setNodeId] = useState(START)
  const [trail, setTrail] = useState<Step[]>([])
  // set when the user takes the "switch to ..." alternative on a result
  const [override, setOverride] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchRTests()
      .then((c) => {
        if (!cancelled) setCatalog(c)
      })
      .catch((e) => {
        if (!cancelled) setCatalogError(e instanceof RApiError ? e.message : 'Could not load the list of tests.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const node: WizardNode | undefined = WIZARD[nodeId]
  if (!node) return null

  const choose = (opt: WizardOption) => {
    setTrail((t) => [...t, { id: nodeId, answer: opt.label }])
    setNodeId(opt.next)
    setOverride(null)
  }
  const back = () => {
    const last = trail[trail.length - 1]
    if (!last) return
    setTrail((t) => t.slice(0, -1))
    setNodeId(last.id)
    setOverride(null)
  }
  const reset = () => {
    setTrail([])
    setNodeId(START)
    setOverride(null)
  }

  const result = node.kind === 'result' ? node : null
  const alt = result?.alternative
  const activeTest = result ? override ?? result.test : null
  const spec = activeTest && catalog ? catalog[activeTest] : undefined

  return (
    <div className="space-y-5 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-white">Test Wizard</h2>
        <p className="text-xs text-gray-500 mt-1">
          Answer a few questions and get a suggested test, then run it on your uploaded data. Suggestions follow standard textbook
          rules and are a starting point: always check the assumption lines in the results.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={back}
          disabled={trail.length === 0}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowLeft size={14} /> Back
        </button>
        <button
          onClick={reset}
          disabled={trail.length === 0}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <RotateCcw size={14} /> Start over
        </button>
        {trail.length > 0 && <p className="text-xs text-gray-500">{trail.map((s) => s.answer).join('  ›  ')}</p>}
      </div>

      {node.kind === 'question' && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-4">
          <div>
            <p className="text-sm font-medium text-white">{node.text}</p>
            {node.help && <p className="text-xs text-gray-500 mt-1">{node.help}</p>}
          </div>
          <div className="space-y-2">
            {node.options.map((opt) => (
              <button
                key={opt.label}
                onClick={() => choose(opt)}
                className="w-full text-left rounded-lg border border-gray-700 bg-gray-800/50 px-4 py-3 hover:border-green-500/40 hover:bg-gray-800 transition-all"
              >
                <span className="text-sm text-white">{opt.label}</span>
                {opt.hint && <span className="block text-xs text-gray-500 mt-0.5">{opt.hint}</span>}
              </button>
            ))}
          </div>
        </div>
      )}

      {result && (
        <div className="space-y-5">
          <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-5 space-y-3">
            <p className="text-xs text-green-400">{override ? 'Switched to' : 'Suggested test'}</p>
            <p className="text-lg font-semibold text-white">
              {override ? (catalog?.[override]?.title ?? override) : result.title}
            </p>
            <p className="text-sm text-gray-300">
              {override ? `Switched from ${result.title}.` : result.reason}
            </p>
            {result.note && !override && <p className="text-xs text-yellow-400">{result.note}</p>}

            {alt && !override && (
              <div className="rounded-lg border border-gray-700 bg-gray-900 p-3 space-y-2">
                <p className="text-xs text-gray-400">{alt.when}</p>
                <button
                  onClick={() => setOverride(alt.test)}
                  className="px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800"
                >
                  {alt.label}
                </button>
              </div>
            )}
            {override && (
              <button
                onClick={() => setOverride(null)}
                className="px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                Back to {result.title}
              </button>
            )}
          </div>

          {result.test === null && (
            <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 flex items-start gap-3">
              <AlertCircle size={18} className="text-yellow-400 mt-0.5 shrink-0" />
              <p className="text-sm text-yellow-400">{result.reason}</p>
            </div>
          )}

          {activeTest && (
            <>
              {catalogError && (
                <div className="flex items-start gap-3 p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
                  <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
                  <p className="text-sm text-red-400">{catalogError}</p>
                </div>
              )}
              {!catalog && !catalogError && (
                <p className="text-xs text-gray-500">Loading tests… the server can take up to a minute to wake up.</p>
              )}
              {catalog && !spec && (
                <p className="text-sm text-yellow-400">
                  This server does not have this test yet. It needs the latest backend version.
                </p>
              )}
              {spec && <RAnalysisPanel key={activeTest} test={activeTest} spec={spec} intentVariables={NO_HINTS} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}