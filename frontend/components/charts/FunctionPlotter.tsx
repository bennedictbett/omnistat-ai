'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Download, Plus, X } from 'lucide-react'
import { ChartError, StylePreset } from '@/lib/chartStudio'
import {
  FUNCTION_NAMES,
  MAX_FUNCTIONS,
  ParsedExpression,
  buildFunctionFigure,
  evaluateConstant,
  parseExpression,
} from '@/lib/functionPlot'
import { PRESETS, segClass } from './chartStyles'

type PlotlyApi = typeof import('plotly.js-dist-min')

interface Props {
  preset: StylePreset
  setPreset: (p: StylePreset) => void
}

interface Row {
  id: number
  text: string
}

interface RangeText {
  xMin: string
  xMax: string
  yMin: string
  yMax: string
}

const EXAMPLES: { text: string; x: [string, string]; y?: [string, string] }[] = [
  { text: 'sin(x)', x: ['-2pi', '2pi'] },
  { text: 'x^3 - 3x', x: ['-3', '3'] },
  { text: 'exp(-x^2/2)', x: ['-4', '4'] },
  { text: 'tan(x)', x: ['-2pi', '2pi'] },
  { text: 'x^2 + y^2', x: ['-3', '3'], y: ['-3', '3'] },
  { text: 'sin(sqrt(x^2 + y^2))', x: ['-10', '10'], y: ['-10', '10'] },
  { text: 'cos(x)*sin(y)', x: ['-pi', 'pi'], y: ['-pi', 'pi'] },
]

const DEFAULT_RANGE: RangeText = { xMin: '-10', xMax: '10', yMin: '-10', yMax: '10' }
const inputClass =
  'bg-gray-800 border rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none'

function RangeField({
  label,
  from,
  to,
  onFrom,
  onTo,
}: {
  label: string
  from: string
  to: string
  onFrom: (v: string) => void
  onTo: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-300">
      <span className="text-xs text-gray-500 w-12">{label}</span>
      <input
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        aria-label={`${label} (start)`}
        spellCheck={false}
        className={`${inputClass} w-24 border-gray-700 focus:border-green-500/50`}
      />
      <span className="text-xs text-gray-500">to</span>
      <input
        value={to}
        onChange={(e) => onTo(e.target.value)}
        aria-label={`${label} (end)`}
        spellCheck={false}
        className={`${inputClass} w-24 border-gray-700 focus:border-green-500/50`}
      />
    </div>
  )
}

/** Draws functions typed as text: curves such as sin(x), and 3D surfaces such as x^2 + y^2. */
export default function FunctionPlotter({ preset, setPreset }: Props) {
  const nextId = useRef(2)
  const [rows, setRows] = useState<Row[]>([{ id: 1, text: 'sin(x)' }])
  const [range, setRange] = useState<RangeText>({ ...DEFAULT_RANGE, xMin: '-2pi', xMax: '2pi' })
  // The chart follows the text after a short pause, so it does not redraw on every key press.
  const [committed, setCommitted] = useState({ rows, range })
  const [plotly, setPlotly] = useState<PlotlyApi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{ caption?: string; notes: string[]; surface: boolean } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const drawId = useRef(0)

  useEffect(() => {
    const id = setTimeout(() => setCommitted({ rows, range }), 300)
    return () => clearTimeout(id)
  }, [rows, range])

  // Load Plotly only when this screen is opened (it is a large library).
  useEffect(() => {
    let cancelled = false
    import('plotly.js-dist-min').then((mod) => {
      if (!cancelled) setPlotly(((mod as unknown as { default?: PlotlyApi }).default ?? mod) as PlotlyApi)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Read the text once per pause: which boxes are wrong, whether y is used, and the range numbers.
  const analysis = useMemo(() => {
    const rowErrors: (string | null)[] = []
    const parsed: (ParsedExpression | null)[] = []
    for (const r of committed.rows) {
      if (r.text.trim() === '') {
        parsed.push(null)
        rowErrors.push(null)
        continue
      }
      try {
        parsed.push(parseExpression(r.text))
        rowErrors.push(null)
      } catch (e) {
        parsed.push(null)
        rowErrors.push(e instanceof ChartError ? e.message : 'Could not read this function.')
      }
    }
    const usesY = parsed.some((p) => p?.uses.y)
    const num = (src: string, label: string): { value: number; error: string | null } => {
      try {
        return { value: evaluateConstant(src, label), error: null }
      } catch (e) {
        return { value: NaN, error: e instanceof ChartError ? e.message : `${label} is not a number.` }
      }
    }
    const xMin = num(committed.range.xMin, 'x start')
    const xMax = num(committed.range.xMax, 'x end')
    const yMin = num(committed.range.yMin, 'y start')
    const yMax = num(committed.range.yMax, 'y end')
    let rangeError = xMin.error ?? xMax.error ?? (usesY ? (yMin.error ?? yMax.error) : null)
    if (!rangeError && xMin.value >= xMax.value) rangeError = 'The x range must start below where it ends.'
    if (!rangeError && usesY && yMin.value >= yMax.value) rangeError = 'The y range must start below where it ends.'
    const values = { xMin: xMin.value, xMax: xMax.value, yMin: yMin.value, yMax: yMax.value }
    return { rowErrors, usesY, rangeError, values }
  }, [committed])

  const hasErrors = analysis.rowErrors.some(Boolean) || analysis.rangeError !== null

  useEffect(() => {
    const el = chartRef.current
    if (!plotly || !el) return
    // While the text has a mistake, the last good chart stays on screen (dimmed) so typing does not flicker.
    if (analysis.rowErrors.some(Boolean) || analysis.rangeError !== null) return
    const myDraw = ++drawId.current
    try {
      const fig = buildFunctionFigure({ exprs: committed.rows.map((r) => r.text), ...analysis.values, preset })
      const surface = fig.data.some((d) => (d as { type?: string }).type === 'surface')
      setError(null)
      setInfo({ caption: fig.caption, notes: fig.notes, surface })
      Promise.resolve(plotly.newPlot(el, { data: fig.data, layout: fig.layout, config: fig.config })).catch(() => {
        if (myDraw !== drawId.current) return
        setInfo(null)
        setError(
          surface
            ? 'Your browser could not draw this 3D surface. Check that WebGL (hardware acceleration) is enabled.'
            : 'Your browser could not draw this chart.'
        )
      })
    } catch (e) {
      plotly.purge(el)
      setInfo(null)
      setError(e instanceof ChartError ? e.message : 'Could not draw this chart.')
    }
  }, [plotly, committed, analysis, preset])

  // Free the chart when leaving the screen.
  useEffect(() => {
    const el = chartRef.current
    return () => {
      if (plotly && el) plotly.purge(el)
    }
  }, [plotly])

  const download = (format: 'png' | 'svg') => {
    if (!plotly || !chartRef.current) return
    plotly.downloadImage(chartRef.current, {
      format,
      filename: 'omnistat-function-plot',
      width: 1200,
      height: 800,
      scale: format === 'png' ? 2 : 1,
    })
  }

  const setText = (id: number, text: string) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, text } : r)))
  const addRow = () => setRows((rs) => (rs.length >= MAX_FUNCTIONS ? rs : [...rs, { id: nextId.current++, text: '' }]))
  const removeRow = (id: number) => setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.id !== id) : rs))
  const applyExample = (ex: (typeof EXAMPLES)[number]) => {
    setRows([{ id: nextId.current++, text: ex.text }])
    setRange((r) => ({
      ...r,
      xMin: ex.x[0],
      xMax: ex.x[1],
      ...(ex.y ? { yMin: ex.y[0], yMax: ex.y[1] } : {}),
    }))
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-gray-500">
        Type a formula and see it drawn. Use <span className="font-mono text-gray-300">x</span> for a curve, or add{' '}
        <span className="font-mono text-gray-300">y</span> for a 3D surface. No data needed.
      </p>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-5">
        <div>
          <p className="text-xs text-gray-500 mb-2">Style</p>
          <div className="flex gap-2">
            {PRESETS.map((p) => (
              <button key={p.id} onClick={() => setPreset(p.id)} title={p.hint} className={segClass(preset === p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-xs text-gray-500">{rows.length > 1 ? 'Functions' : 'Function'}</p>
          {rows.map((row, i) => {
            const at = committed.rows.findIndex((c) => c.id === row.id && c.text === row.text)
            const err = at >= 0 ? analysis.rowErrors[at] : null
            return (
              <div key={row.id}>
                <div className="flex items-center gap-2">
                  <input
                    value={row.text}
                    onChange={(e) => setText(row.id, e.target.value)}
                    aria-label={`Function ${i + 1}`}
                    aria-invalid={err ? true : undefined}
                    placeholder="for example  sin(x)  or  x^2 + y^2"
                    spellCheck={false}
                    autoComplete="off"
                    className={`${inputClass} flex-1 ${err ? 'border-red-500/50' : 'border-gray-700 focus:border-green-500/50'}`}
                  />
                  {rows.length > 1 && (
                    <button
                      onClick={() => removeRow(row.id)}
                      aria-label={`Remove function ${i + 1}`}
                      className="p-2 rounded-lg text-gray-500 hover:text-white hover:bg-gray-800"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
                {err && <p className="text-xs text-red-400 mt-1">{err}</p>}
              </div>
            )
          })}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={addRow}
              disabled={rows.length >= MAX_FUNCTIONS}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Plus size={14} /> Add function
            </button>
            <span className="text-xs text-gray-500">Try:</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.text}
                onClick={() => applyExample(ex)}
                className="px-2.5 py-1 rounded-md text-xs font-mono text-gray-300 border border-gray-800 hover:bg-gray-800 hover:text-white"
              >
                {ex.text}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <RangeField
            label="x from"
            from={range.xMin}
            to={range.xMax}
            onFrom={(v) => setRange((r) => ({ ...r, xMin: v }))}
            onTo={(v) => setRange((r) => ({ ...r, xMax: v }))}
          />
          {analysis.usesY && (
            <RangeField
              label="y from"
              from={range.yMin}
              to={range.yMax}
              onFrom={(v) => setRange((r) => ({ ...r, yMin: v }))}
              onTo={(v) => setRange((r) => ({ ...r, yMax: v }))}
            />
          )}
        </div>
        {analysis.rangeError && <p className="text-xs text-red-400 -mt-2">{analysis.rangeError}</p>}

        <details className="text-xs text-gray-400">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-300 w-fit">What can I type?</summary>
          <div className="mt-2 space-y-1.5">
            <p>
              Numbers, <span className="font-mono">x</span>, <span className="font-mono">y</span>, and{' '}
              <span className="font-mono">+ - * / ^</span> with brackets. You can leave out the times sign:{' '}
              <span className="font-mono">2x</span>, <span className="font-mono">3(x+1)</span>. The constants are{' '}
              <span className="font-mono">pi</span> and <span className="font-mono">e</span>, and the range boxes accept
              them too, for example <span className="font-mono">-2pi</span>.
            </p>
            <p>
              Functions: <span className="font-mono">{FUNCTION_NAMES.join(', ')}</span>. Angles are in radians,{' '}
              <span className="font-mono">log</span> is base 10 and <span className="font-mono">ln</span> is the natural
              logarithm.
            </p>
            <p>
              Where a function has no real value (<span className="font-mono">sqrt(x)</span> for negative x, or{' '}
              <span className="font-mono">1/x</span> at 0) the line is left broken. For the cube root of a negative
              number use <span className="font-mono">cbrt(x)</span>, because <span className="font-mono">x^(1/3)</span> is
              undefined there. Up to {MAX_FUNCTIONS} functions can be drawn together.
            </p>
          </div>
        </details>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!plotly && !error && <p className="text-xs text-gray-500">Loading charting library…</p>}

      {/* Plotly draws into the inner element, whose class and size never change: React rewriting its class would erase the
          classes Plotly adds, and display:none would make Plotly measure a width of zero when it redraws after an error. */}
      <div
        className={`w-full rounded-lg overflow-hidden border-gray-800 transition-opacity ${error ? 'h-0 border-0' : 'border'} ${
          hasErrors ? 'opacity-40' : ''
        }`}
      >
        <div ref={chartRef} className="w-full" style={{ height: 520 }} />
      </div>

      {info && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            {hasErrors && <p className="text-xs text-gray-500">Showing the last chart that worked. Fix the message above to update it.</p>}
            {info.caption && <p className="text-xs text-gray-400">{info.caption}</p>}
            {info.notes.map((n) => (
              <p key={n} className="text-xs text-yellow-400">
                {n}
              </p>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => download('png')}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800"
            >
              <Download size={14} /> PNG
            </button>
            <button
              onClick={() => download('svg')}
              disabled={info.surface}
              title={info.surface ? '3D charts cannot be exported as SVG; use PNG' : 'Vector image for papers and slides'}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download size={14} /> SVG
            </button>
          </div>
        </div>
      )}
    </div>
  )
}