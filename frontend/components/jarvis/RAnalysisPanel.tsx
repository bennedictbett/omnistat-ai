'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Play, AlertCircle, Upload } from 'lucide-react'
import {
  RApiError,
  RRunResult,
  RTestSpec,
  UploadedData,
  formatNumber,
  guessColumns,
  isPKey,
  loadUploadedData,
  prettyKey,
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
  const [data, setData] = useState<UploadedData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RRunResult | null>(null)

  useEffect(() => {
    const d = loadUploadedData()
    setData(d)
    setLoaded(true)
    if (d) setMapping(guessColumns(roles, intentVariables, d.columns))
    setResult(null)
    setError(null)
  }, [test, roles, intentVariables])

  const chosen = roles.map((r) => mapping[r]).filter(Boolean)
  const allChosen = roles.every((r) => mapping[r])
  const hasDuplicate = new Set(chosen).size !== chosen.length

  const handleRun = async () => {
    if (!data || !allChosen || hasDuplicate) return
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      setResult(await runRTest(test, mapping, data.rows))
    } catch (e) {
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
          <p className="text-sm font-medium text-yellow-400">Upload your data first</p>
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
        {roles.map((role) => (
          <label key={role} className="block">
            <span className="text-xs text-gray-500">
              <span className="font-mono text-gray-300">{role}</span> — {spec.variables[role]}
            </span>
            <select
              value={mapping[role] ?? ''}
              onChange={(e) => setMapping((m) => ({ ...m, [role]: e.target.value }))}
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

      {hasDuplicate && (
        <p className="text-xs text-yellow-400">Choose a different column for each role.</p>
      )}

      <button
        onClick={handleRun}
        disabled={running || !allChosen || hasDuplicate}
        className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg text-sm font-medium transition-all"
      >
        {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {running ? 'Running…' : 'Run in R'}
      </button>

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