'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Play, AlertCircle, Upload, Plus, X } from 'lucide-react'
import RegressionPlot from '@/components/analytics/RegressionPlot'
import AssumptionChecks from '@/components/jarvis/AssumptionChecks'
import AnalysisReport from '@/components/reports/AnalysisReport'
import ReproducibilityBundle from '@/components/reports/ReproducibilityBundle'
import {
  asCurveFit,
  AnalysisPlan,
  AssumptionReport,
  fetchAssumptionChecks,
  RApiError,
  REVIEWED_PROCEDURES,
  RRunResult,
  RTestSpec,
  UploadedData,
  formatNumber,
  guessColumns,
  isPKey,
  loadUploadedData,
  prettyKey,
  prepareRPlan,
  runRTest,
} from '@/lib/rApi'

interface Props {
  /** Backend template name, e.g. "independent_t_test" */
  test: string
  spec: RTestSpec
  /** Variable names suggested by the Jarvis agent (used only to pre-fill the pickers) */
  intentVariables: string[]
}

export default function RAnalysisPanel({ test, spec, intentVariables }: Props) {
  const roles = useMemo(() => Object.keys(spec.variables), [spec])
  const optionalRoles = useMemo(() => new Set(spec.optional ?? []), [spec])
  const requiredRoles = useMemo(() => roles.filter((r) => !optionalRoles.has(r)), [roles, optionalRoles])
  const [extraRoles, setExtraRoles] = useState<string[]>([])
  const [data, setData] = useState<UploadedData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RRunResult | null>(null)
  const [plan, setPlanState] = useState<AnalysisPlan | null>(null)
  const [checks, setChecks] = useState<AssumptionReport | null>(null)
  const [checksError, setChecksError] = useState<string | null>(null)
  const setPlan = (next: AnalysisPlan | null) => {
    setPlanState(next)
    setChecks(null)
    setChecksError(null)
  }
  const needsReview = REVIEWED_PROCEDURES.some((procedure) => procedure === test)

  useEffect(() => {
    setExtraRoles([])
    setResult(null)
    setPlan(null)
    setError(null)
    try {
      const d = loadUploadedData()
      setData(d)
      if (d) setMapping(guessColumns(requiredRoles, intentVariables, d.columns))
    } catch (e) {
      setData(null)
      setError(e instanceof RApiError ? e.message : 'Could not read the uploaded data. Upload your file again.')
    } finally {
      setLoaded(true)
    }
  }, [test, requiredRoles, intentVariables])

  const activeRoles = [...requiredRoles, ...extraRoles]
  const chosen = activeRoles.map((r) => mapping[r]).filter(Boolean)
  const allChosen = requiredRoles.every((r) => mapping[r])
  const hasDuplicate = new Set(chosen).size !== chosen.length
  const nextOptional = roles.find((r) => optionalRoles.has(r) && !extraRoles.includes(r))
  const addRole = () => {
    if (nextOptional) setExtraRoles((x) => [...x, nextOptional])
  }
  const removeRole = (role: string) => {
    setExtraRoles((x) => x.filter((r) => r !== role))
    setMapping((m) => {
      const copy = { ...m }
      delete copy[role]
      return copy
    })
  }

  const handleRun = async () => {
    if (!data || !allChosen || hasDuplicate) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const variables = Object.fromEntries(activeRoles.filter((r) => mapping[r]).map((r) => [r, mapping[r]]))
      if (needsReview && !plan) {
        const reviewed = await prepareRPlan(test, variables, data.rows)
        let report: AssumptionReport | null = null
        let reportError: string | null = null
        try {
          report = await fetchAssumptionChecks(reviewed, data.rows)
        } catch (e) {
          reportError = e instanceof RApiError ? e.message : 'The checks could not be completed.'
        }
        setPlan(reviewed)
        setChecks(report)
        setChecksError(reportError)
      } else {
        setResult(await runRTest(test, variables, data.rows, plan ?? undefined))
        setPlan(null)
      }
    } catch (e) {
      setPlan(null)
      setError(e instanceof RApiError ? e.message : 'Something went wrong running the analysis.')
    } finally {
      setRunning(false)
    }
  }

  if (!loaded) return null

  if (!data) {
    return (
      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-5 flex items-start gap-3">
        <Upload size={18} className="text-yellow-400 mt-0.5 shrink-0" />
        <div>
          <p role={error ? 'alert' : undefined} className="text-sm font-medium text-yellow-400">{error ?? 'Upload your data first'}</p>
          <p className="text-xs text-gray-400 mt-1">
            {spec.title} runs on your own file. Open <span className="text-white">Upload Data</span> in the
            sidebar, add a CSV or Excel file, then come back and run this analysis.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-blue-500/20 bg-gray-900 p-5 space-y-5">
      <div>
        <p className="text-sm font-medium text-blue-400">{spec.title}</p>
        <p className="text-xs text-gray-500 mt-1">
          Choose which column plays each role. {data.rows.length} rows loaded.
        </p>
      </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {activeRoles.map((role) => (
          <label key={role} className="block">
            <span className="flex items-center justify-between text-xs text-gray-500">
              <span>
                <span className="font-mono text-gray-300">{role}</span> — {spec.variables[role]}
              </span>
              {optionalRoles.has(role) && (
                <button
                  type="button"
                  onClick={() => removeRole(role)}
                  aria-label={`Remove ${role}`}
                  className="text-gray-500 hover:text-red-400"
                >
                  <X size={12} />
                </button>
              )}
            </span>
            <select
              disabled={running}
              value={mapping[role] ?? ''}
              onChange={(e) => {
                setMapping((m) => ({ ...m, [role]: e.target.value }))
                setPlan(null)
                setResult(null)
                setError(null)
              }}
              className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500/50"
            >
              <option value="">Select a column…</option>
              {data.columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                  {data.numericCols.includes(c) ? '  (numeric)' : ''}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {nextOptional && (
        <button
          type="button"
          onClick={addRole}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800"
        >
          <Plus size={14} /> Add another column
        </button>
      )}

      {hasDuplicate && (
        <p className="text-xs text-yellow-400">Choose a different column for each role.</p>
      )}

      <button
        onClick={handleRun}
        disabled={running || !allChosen || hasDuplicate}
        className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-all"
      >
        {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {running ? 'Working…' : needsReview ? (plan ? 'Confirm and Run in R' : 'Review Analysis Plan') : 'Run in R'}
      </button>

      {plan && (
        <section aria-label="Analysis plan review" className="rounded-lg border border-blue-500/30 p-4 space-y-3 text-sm text-gray-300">
          <h3 className="font-medium text-white">Review before execution</h3>
          <p>{plan.title} · Engine: {plan.engine.toUpperCase()} · Specification {plan.schema_version}</p>
          <p>{Object.entries(plan.variables).map(([role, column]) => `${role}: ${column}`).join(' · ')}</p>
          <p>{plan.rows_used} of {plan.rows_total} rows used; {plan.rows_dropped_missing} dropped for missing selected values.</p>
          {Object.keys(plan.group_counts).length > 0 && <p>Groups: {Object.entries(plan.group_counts).map(([group, count]) => `${group}: ${count}`).join(', ')}</p>}
          {plan.alternative && <p>Two-sided test</p>}
          {plan.confidence_level && <p>95% confidence intervals</p>}
          {plan.equal_variances !== null && <p>{plan.equal_variances ? 'Equal variances assumed' : 'Unequal variances (Welch)'}</p>}
          <p className="break-all font-mono text-xs">Data SHA-256: {plan.data_sha256}</p>
          <ul className="list-disc pl-5">{plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul>
          <p>Outputs: {plan.outputs.join(', ')}</p>
          <AssumptionChecks report={checks} error={checksError} />
          <p>No analysis has run yet. Confirm that these columns and study-design assumptions are appropriate.</p>
          <button disabled={running} onClick={() => setPlan(null)} className="text-blue-400">Cancel review</button>
        </section>
      )}
      {running && (
        <p className="text-xs text-gray-500">
          The first run after a quiet period can take up to a minute while the server wakes up.
        </p>
      )}

      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {result && <ResultView result={result} />}
      {result && <AnalysisReport result={result} />}
      {result && <ReproducibilityBundle key={JSON.stringify(result.variables)} result={result} rows={data.rows} />}
      {result?.analysis_plan && (
        <details className="text-xs text-gray-400">
          <summary>Executed analysis specification</summary>
          <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(result.analysis_plan, null, 2)}</pre>
        </details>
      )}
    </div>
  )
}

// ---------- Result rendering ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function formatScalar(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return formatNumber(v, isPKey(key))
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function ResultView({ result }: { result: RRunResult }) {
  if (!result.ok) {
    return (
      <div className="flex items-start gap-3 p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
        <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm text-red-400">{result.error ?? 'The analysis failed.'}</p>
          <p className="text-xs text-gray-500 mt-1">
            Check that the selected columns suit this test, for example that the outcome is numeric.
          </p>
        </div>
      </div>
    )
  }

  const { results } = result
  const testName = typeof results.test === 'string' ? results.test : result.title
  const fit = asCurveFit(result)
  if (fit) {
    return (
      <div className="space-y-5 border-t border-gray-800 pt-5">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm font-medium text-white">{testName}</p>
          <p className="text-xs text-gray-500">{result.duration_s.toFixed(1)}s</p>
        </div>
        <RegressionPlot fit={fit} xLabel={result.variables.x ?? 'x'} yLabel={result.variables.y ?? 'y'} />
        <CodeDrawer result={result} />      
      </div>
    )
  }
  const p = typeof results.p_value === 'number' ? results.p_value : null
  const rest = Object.entries(results).filter(([k]) => k !== 'test' && k !== 'p_value')
  const scalars = rest.filter(([, v]) => !Array.isArray(v) && !isPlainObject(v))
  const others = rest.filter(([, v]) => Array.isArray(v) || isPlainObject(v))

  return (
    <div className="space-y-5 border-t border-gray-800 pt-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm font-medium text-white">{testName}</p>
        <p className="text-xs text-gray-500">{result.duration_s.toFixed(1)}s</p>
      </div>

      {p !== null && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-2xl font-bold text-white font-mono">{formatNumber(p, true)}</p>
            <p className="text-xs text-gray-500 mt-1">p-value{p >= 0.001 ? '' : ` (${p.toExponential(2)})`}</p>
          </div>
          <div
            className={`rounded-lg p-3 text-center border ${
              p < 0.05 ? 'bg-green-500/5 border-green-500/20' : 'bg-gray-800 border-gray-700'
            }`}
          >
            <p className={`text-sm font-medium ${p < 0.05 ? 'text-green-400' : 'text-gray-300'}`}>
              {p < 0.05 ? 'p < 0.05' : 'p ≥ 0.05'}
            </p>
            <p className="text-xs text-gray-500 mt-1">at the 0.05 level</p>
          </div>
        </div>
      )}

      {scalars.length > 0 && (
        <div>
          {scalars.map(([k, v]) => (
            <div key={k} className="flex justify-between items-start py-2 border-b border-gray-800 last:border-0">
              <span className="text-xs text-gray-500">{prettyKey(k)}</span>
              <span className="text-xs text-white font-mono text-right">{formatScalar(k, v)}</span>
            </div>
          ))}
        </div>
      )}

      {others.map(([k, v]) => (
        <div key={k}>
          <p className="text-xs text-gray-500 mb-2">{prettyKey(k)}</p>
          <Compound name={k} value={v} />
        </div>
      ))}

      {result.plots.map((b64, i) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          src={`data:image/png;base64,${b64}`}
          alt={`${result.title} plot ${i + 1}`}
          className="w-full rounded-lg border border-gray-800 bg-white"
        />
      ))}
      <CodeDrawer result={result} />
    </div>
  )
}

/** Renders arrays of numbers, arrays of row objects (tables) and plain objects. */
function Compound({ name, value }: { name: string; value: unknown }) {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((x) => isPlainObject(x))) {
      const rows = value as Record<string, unknown>[]
      const cols = Object.keys(rows[0])
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 text-left">
                {cols.map((c) => (
                  <th key={c} className="py-1 pr-4 font-normal">
                    {prettyKey(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-gray-800">
                  {cols.map((c) => (
                    <td key={c} className="py-1 pr-4 text-white font-mono">
                      {formatScalar(c, r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    if (value.length > 0 && value.every((x) => typeof x === 'string')) {
      return (
        <ul className="text-xs text-yellow-400 space-y-1 list-disc pl-4">
          {value.map((x, i) => (
            <li key={i}>{String(x)}</li>
          ))}
        </ul>
      )
    }
    return (
      <p className="text-xs text-white font-mono">
        {value.map((x) => formatScalar(name, x)).join(' to ')}
      </p>
    )
  }
  if (isPlainObject(value)) {
    return (
      <div>
        {Object.entries(value).map(([k, v]) => (
          <div key={k} className="flex justify-between py-1 border-b border-gray-800 last:border-0">
            <span className="text-xs text-gray-500">{k}</span>
            <span className="text-xs text-white font-mono">{formatScalar(name, v)}</span>
          </div>
        ))}
      </div>
    )
  }
  return null
}

/** Collapsible "show the R code" section under a result. */
function CodeDrawer({ result }: { result: RRunResult }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  if (!result.code) return null
  const code = result.code

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: the text can still be selected by hand
    }
  }

  return (
    <div className="rounded-lg border border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-4 py-2 text-xs text-gray-300 hover:bg-gray-800/50"
      >
        <span>R code for this result</span>
        <span className="text-gray-500">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-800 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-gray-500">
              {result.r_version ?? 'R version not recorded'}
              {result.data_sha256 && ` · data fingerprint ${result.data_sha256.slice(0, 12)}…`}
            </p>
            <button
              type="button"
              onClick={copy}
              className="px-3 py-1 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="max-h-96 overflow-auto text-xs text-gray-300 font-mono whitespace-pre">{code}</pre>
          <p className="text-[11px] text-gray-500">
            Save the columns you used as <span className="font-mono">data.csv</span> next to this script and run it in R. Results are printed as plain text.
          </p>
        </div>
      )}
    </div>
  )
}