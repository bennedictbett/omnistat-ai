'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Copy, LineChart, Loader2 } from 'lucide-react'
import { loadMathJax } from '@/lib/mathjax'
import { selectClass, segClass } from './chartStyles'

type Operation = 'derivative' | 'integral' | 'solve' | 'simplify' | 'expand' | 'factor' | 'limit' | 'numeric'

interface Solution {
  latex: string
  text: string
  numeric: string | null
}

interface MathResult {
  operation: Operation
  input_latex: string
  statement_latex: string | null
  result_latex: string
  result_text: string
  numeric: string | null
  plot_text: string | null
  input_plot_text: string | null
  variables: string[]
  notes: string[]
  solutions?: Solution[]
  solved_for?: string
}

interface Props {
  /** Send one or two functions to the Function plotter. */
  onPlot: (texts: string[]) => void
}

const OPERATIONS: { id: Operation; label: string; hint: string }[] = [
  { id: 'derivative', label: 'Differentiate', hint: 'The derivative (slope formula)' },
  { id: 'integral', label: 'Integrate', hint: 'Indefinite, or definite with limits' },
  { id: 'solve', label: 'Solve', hint: 'Find the values that make an equation true' },
  { id: 'simplify', label: 'Simplify', hint: 'Write it in its simplest form' },
  { id: 'expand', label: 'Expand', hint: 'Multiply out brackets' },
  { id: 'factor', label: 'Factor', hint: 'Write as a product' },
  { id: 'limit', label: 'Limit', hint: 'What the expression approaches' },
  { id: 'numeric', label: 'Evaluate', hint: 'A number from an expression with no variables' },
]

const EXAMPLES: { op: Operation; text: string; extra?: Partial<FormState> }[] = [
  { op: 'derivative', text: 'x^2 sin(x)' },
  { op: 'integral', text: 'x e^x' },
  { op: 'integral', text: 'sin(x)^2', extra: { lower: '0', upper: 'pi' } },
  { op: 'solve', text: 'x^2 - 5x + 6 = 0' },
  { op: 'solve', text: 'x^2 + 1 = 0', extra: { complex: true } },
  { op: 'factor', text: 'x^3 - 8' },
  { op: 'limit', text: 'sin(x)/x', extra: { point: '0' } },
  { op: 'numeric', text: 'sqrt(2) + pi' },
]

interface FormState {
  text: string
  variable: string
  order: string
  lower: string
  upper: string
  point: string
  direction: 'both' | '+' | '-'
  complex: boolean
}

const EMPTY: FormState = { text: '', variable: '', order: '1', lower: '', upper: '', point: '', direction: 'both', complex: false }

const inputClass =
  'bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-green-500/50'
const smallBtn =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed'

/** A formula drawn by MathJax. Falls back to the plain LaTeX text while it loads or if it fails. */
export function Formula({ tex, display = true }: { tex: string; display?: boolean }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSvg(null)
    loadMathJax()
      .then((render) => {
        if (!cancelled) setSvg(render(tex, display))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tex, display])
  if (svg === null) return <code className="text-xs text-gray-500 break-all">{tex}</code>
  // The SVG is produced by MathJax from LaTeX in which only the base and ams packages are loaded.
  return <div className="overflow-x-auto text-white" dangerouslySetInnerHTML={{ __html: svg }} />
}

export default function Equations({ onPlot }: Props) {
  const [op, setOp] = useState<Operation>('derivative')
  const [form, setForm] = useState<FormState>(EMPTY)
  const [result, setResult] = useState<MathResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const runId = useRef(0)
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }))

  // Warm up MathJax while the person types the first expression.
  useEffect(() => {
    loadMathJax().catch(() => {})
  }, [])

  const run = async (operation: Operation, f: FormState) => {
    const id = ++runId.current
    setBusy(true)
    setError(null)
    const body: Record<string, unknown> = { operation, expression: f.text }
    if (f.variable.trim()) body.variable = f.variable.trim()
    if (operation === 'derivative') body.order = Number(f.order) || 1
    if (operation === 'integral' && (f.lower.trim() || f.upper.trim())) {
      body.lower = f.lower
      body.upper = f.upper
    }
    if (operation === 'limit') {
      body.point = f.point
      body.direction = f.direction
    }
    if (operation === 'solve' && f.complex) body.domain = 'complex'
    try {
      const res = await fetch('/api/math/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (id !== runId.current) return // a newer request replaced this one
      if (!res.ok) {
        setResult(null)
        setError(
          typeof data.detail === 'string'
            ? data.detail
            : res.status === 429
              ? 'Too many requests, please wait a moment.'
              : 'Could not work this out. Try again.'
        )
      } else {
        setResult(data as MathResult)
      }
    } catch {
      if (id !== runId.current) return
      setResult(null)
      setError('Could not reach the maths server. Check your connection and try again.')
    } finally {
      if (id === runId.current) setBusy(false)
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!busy) run(op, form)
  }

  const copy = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
    } catch {
      /* clipboard blocked: nothing to do */
    }
  }

  const placeholder =
    op === 'solve' ? 'x^2 - 5x + 6 = 0' : op === 'numeric' ? 'sqrt(2) + pi' : op === 'limit' ? 'sin(x)/x' : 'x^2 sin(x)'
  const plots = result ? [result.input_plot_text, result.plot_text].filter((t): t is string => !!t) : []
  // the same text twice (for example "simplify" of something already simple) is drawn once
  const uniquePlots = plots.filter((t, i) => plots.indexOf(t) === i)

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500">
        Type an expression or an equation. Use <code className="text-gray-400">^</code> for powers, <code className="text-gray-400">sqrt(x)</code>,{' '}
        <code className="text-gray-400">ln(x)</code>, <code className="text-gray-400">e^x</code>, <code className="text-gray-400">pi</code>. A number
        in front of a letter multiplies: <code className="text-gray-400">3x</code>.
      </p>

      <form onSubmit={submit} className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-4">
        <div>
          <p className="text-xs text-gray-500 mb-2">What do you want to do?</p>
          <div className="flex flex-wrap gap-2">
            {OPERATIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                title={o.hint}
                aria-pressed={op === o.id}
                onClick={() => {
                  setOp(o.id)
                  setResult(null)
                  setError(null)
                }}
                className={segClass(op === o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="block text-xs text-gray-500">{op === 'solve' ? 'Equation' : 'Expression'}</span>
          <input
            value={form.text}
            onChange={(e) => set({ text: e.target.value })}
            placeholder={placeholder}
            maxLength={300}
            spellCheck={false}
            autoComplete="off"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>

        <div className="flex flex-wrap items-end gap-4">
          {(op === 'derivative' || op === 'integral' || op === 'solve' || op === 'limit') && (
            <label className="block">
              <span className="block text-xs text-gray-500">With respect to (optional)</span>
              <input
                value={form.variable}
                onChange={(e) => set({ variable: e.target.value })}
                placeholder="x"
                maxLength={12}
                spellCheck={false}
                className={`${inputClass} mt-1 w-28`}
              />
            </label>
          )}
          {op === 'derivative' && (
            <label className="block">
              <span className="block text-xs text-gray-500">Order</span>
              <select value={form.order} onChange={(e) => set({ order: e.target.value })} className={`${selectClass} w-24`}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`}
                  </option>
                ))}
              </select>
            </label>
          )}
          {op === 'integral' && (
            <>
              <label className="block">
                <span className="block text-xs text-gray-500">Lower limit (optional)</span>
                <input value={form.lower} onChange={(e) => set({ lower: e.target.value })} placeholder="0" className={`${inputClass} mt-1 w-28`} />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500">Upper limit (optional)</span>
                <input value={form.upper} onChange={(e) => set({ upper: e.target.value })} placeholder="pi" className={`${inputClass} mt-1 w-28`} />
              </label>
            </>
          )}
          {op === 'limit' && (
            <>
              <label className="block">
                <span className="block text-xs text-gray-500">As the variable approaches</span>
                <input value={form.point} onChange={(e) => set({ point: e.target.value })} placeholder="0 or oo" className={`${inputClass} mt-1 w-32`} />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500">From</span>
                <select
                  value={form.direction}
                  onChange={(e) => set({ direction: e.target.value as FormState['direction'] })}
                  className={`${selectClass} w-36`}
                >
                  <option value="both">Both sides</option>
                  <option value="+">The right (above)</option>
                  <option value="-">The left (below)</option>
                </select>
              </label>
            </>
          )}
          {op === 'solve' && (
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer pb-2">
              <input type="checkbox" checked={form.complex} onChange={(e) => set({ complex: e.target.checked })} className="accent-green-500" />
              Include complex solutions
            </label>
          )}
          <button
            type="submit"
            disabled={busy || form.text.trim() === ''}
            className="px-5 py-2 rounded-lg text-sm bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy ? 'Working…' : 'Work it out'}
          </button>
        </div>

        <div>
          <p className="text-xs text-gray-500 mb-2">Try an example</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  const next = { ...EMPTY, text: ex.text, ...ex.extra }
                  setOp(ex.op)
                  setForm(next)
                  run(ex.op, next)
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-mono border border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-white"
                title={OPERATIONS.find((o) => o.id === ex.op)?.label}
              >
                {ex.text}
              </button>
            ))}
          </div>
        </div>
      </form>

      {error && (
        <div role="alert" className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 flex gap-3 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-4" data-testid="equation-result">
          {result.operation === 'solve' ? (
            <div className="space-y-3">
              <div>
                <p className="text-xs text-gray-500 mb-1">Equation</p>
                <Formula tex={result.input_latex} />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-1">
                  {result.solutions && result.solutions.length > 0 ? 'Solutions' : 'Answer'}
                </p>
                <Formula tex={result.result_latex} />
              </div>
              {result.solutions && result.solutions.some((s) => s.numeric) && (
                <ul className="text-xs text-gray-400 space-y-0.5">
                  {result.solutions.map((s, i) =>
                    s.numeric ? (
                      <li key={i} className="font-mono">
                        {result.solved_for} ≈ {s.numeric}
                      </li>
                    ) : null
                  )}
                </ul>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <Formula tex={result.statement_latex ? `${result.statement_latex} = ${result.result_latex}` : `${result.input_latex} = ${result.result_latex}`} />
              {result.numeric && result.operation !== 'numeric' && (
                <p className="text-xs text-gray-400 font-mono">≈ {result.numeric}</p>
              )}
              {result.operation === 'numeric' && result.numeric && <p className="text-xs text-gray-400 font-mono">≈ {result.numeric}</p>}
            </div>
          )}

          {result.notes.length > 0 && (
            <ul className="space-y-1">
              {result.notes.map((n, i) => (
                <li key={i} className="text-xs text-gray-400">
                  {n}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            {uniquePlots.length > 0 && (
              <button onClick={() => onPlot(uniquePlots)} className={smallBtn}>
                <LineChart className="w-3.5 h-3.5" />
                {uniquePlots.length > 1 ? 'Plot the expression and the answer' : 'Plot this'}
              </button>
            )}
            <button onClick={() => copy('text', result.result_text)} className={smallBtn}>
              <Copy className="w-3.5 h-3.5" />
              {copied === 'text' ? 'Copied' : 'Copy answer'}
            </button>
            <button onClick={() => copy('latex', result.result_latex)} className={smallBtn}>
              <Copy className="w-3.5 h-3.5" />
              {copied === 'latex' ? 'Copied' : 'Copy as LaTeX'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}