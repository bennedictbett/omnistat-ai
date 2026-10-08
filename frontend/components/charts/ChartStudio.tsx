'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Download, Upload } from 'lucide-react'
import {
  ChartConfig,
  ChartError,
  ChartType,
  ErrorBars,
  GroupSummary,
  HistNorm,
  MAX_BINS,
  StylePreset,
  buildFigure,
  defaultSelection,
  formatStat,
  groupableColumns,
  toDataset,
} from '@/lib/chartStudio'

type PlotlyApi = typeof import('plotly.js-dist-min')

interface Props {
  /** The object the Upload tab saved (columns, numeric_cols, categorical_cols, full_data) */
  data: unknown
}

const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'scatter', label: 'Scatter' },
  { id: 'scatter3d', label: '3D Scatter' },
  { id: 'histogram', label: 'Histogram' },
  { id: 'box', label: 'Box' },
  { id: 'violin', label: 'Violin' },
  { id: 'bar', label: 'Bar' },
]

const ERROR_BAR_OPTIONS: { id: ErrorBars; label: string }[] = [
  { id: 'sd', label: 'SD (standard deviation)' },
  { id: 'sem', label: 'SEM (standard error)' },
  { id: 'ci95', label: '95% confidence interval' },
]

const HIST_NORM_OPTIONS: { id: HistNorm; label: string }[] = [
  { id: 'count', label: 'Count' },
  { id: 'percent', label: 'Percent' },
  { id: 'density', label: 'Density' },
]

const PRESETS: { id: StylePreset; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Matches the app' },
  { id: 'graphpad', label: 'GraphPad style', hint: 'White, no grid, heavy axes: for papers and slides' },
]

export default function ChartStudio({ data }: Props) {
  const ds = useMemo(() => toDataset(data), [data])
  const datasetKey = ds ? ds.columns.join('|') : ''
  const groupable = useMemo(() => (ds ? groupableColumns(ds) : []), [ds])

  const [type, setType] = useState<ChartType>('scatter')
  const [preset, setPreset] = useState<StylePreset>('dark')
  const [trendline, setTrendline] = useState(false)
  const [showPoints, setShowPoints] = useState(true)
  const [showMean, setShowMean] = useState(true)
  const [errorBars, setErrorBars] = useState<ErrorBars>('sd')
  const [histNorm, setHistNorm] = useState<HistNorm>('count')
  const [bins, setBins] = useState('') // empty = automatic
  const [animateBy, setAnimateBy] = useState('') // empty = no animation
  const [cumulative, setCumulative] = useState(false)
  const [sel, setSel] = useState({ x: '', y: '', z: '', color: '', group: '' })
  const [plotly, setPlotly] = useState<PlotlyApi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{
    plotted: number
    skipped: number
    notes: string[]
    summary?: GroupSummary[]
    caption?: string
  } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  const drawId = useRef(0)

  // Load Plotly only when this tab is opened (it is a large library).
  useEffect(() => {
    let cancelled = false
    import('plotly.js-dist-min').then((mod) => {
      if (!cancelled) setPlotly(((mod as unknown as { default?: PlotlyApi }).default ?? mod) as PlotlyApi)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // New dataset: start from sensible columns.
  useEffect(() => {
    if (ds) setSel(defaultSelection(ds))
    setAnimateBy('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey])

  // Draw whenever the data or any choice changes.
  useEffect(() => {
    const el = chartRef.current
    if (!plotly || !ds || !el) return
    const grouped = type === 'box' || type === 'violin' || type === 'bar' || type === 'histogram'
    const binCount = Number(bins)
    const cfg: ChartConfig = {
      type,
      x: sel.x,
      y: sel.y,
      z: type === 'scatter3d' ? sel.z : undefined,
      color: !grouped && sel.color ? sel.color : undefined,
      group: grouped && sel.group ? sel.group : undefined,
      showPoints,
      showMean,
      errorBars,
      histNorm,
      bins: bins !== '' && Number.isFinite(binCount) ? Math.min(MAX_BINS, Math.max(1, Math.floor(binCount))) : undefined,
      preset,
      trendline: type === 'scatter' ? trendline : false,
      animateBy: type === 'scatter' && animateBy ? animateBy : undefined,
      cumulative,
    }
    const myDraw = ++drawId.current
    try {
      const fig = buildFigure(ds, cfg)
      setError(null)
      setInfo({ plotted: fig.plotted, skipped: fig.skipped, notes: fig.notes, summary: fig.summary, caption: fig.caption })
      // Drawing can also fail later (e.g. 3D without WebGL); ignore failures from superseded draws.
      Promise.resolve(plotly.newPlot(el, { data: fig.data, layout: fig.layout, frames: fig.frames, config: fig.config })).catch(() => {
        if (myDraw !== drawId.current) return
        setInfo(null)
        setError(
          type === 'scatter3d'
            ? 'Your browser could not draw this 3D chart. Check that WebGL (hardware acceleration) is enabled, or try the 2D scatter.'
            : 'Your browser could not draw this chart.'
        )
      })
    } catch (e) {
      plotly.purge(el)
      setInfo(null)
      setError(e instanceof ChartError ? e.message : 'Could not draw this chart.')
    }
  }, [plotly, ds, type, sel, preset, trendline, showPoints, showMean, errorBars, histNorm, bins, animateBy, cumulative])

  // Free the chart when leaving the tab.
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
      filename: 'omnistat-chart',
      width: 1200,
      height: 800,
      scale: format === 'png' ? 2 : 1,
    })
  }

  if (!ds) {
    return (
      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-5 flex items-start gap-3 max-w-2xl">
        <Upload size={18} className="text-yellow-400 mt-0.5 shrink-0" />
        <div>
          <p className="text-sm font-medium text-yellow-400">Upload your data first</p>
          <p className="text-xs text-gray-400 mt-1">
            Chart Studio draws from your own file. Open <span className="text-white">Upload Data</span> in the
            sidebar, add a CSV or Excel file, then come back.
          </p>
        </div>
      </div>
    )
  }

  if (ds.numericCols.length === 0) {
    return (
      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-5 max-w-2xl">
        <p className="text-sm font-medium text-yellow-400">No numeric columns found</p>
        <p className="text-xs text-gray-400 mt-1">Charts need at least one column of numbers.</p>
      </div>
    )
  }

  const is3d = type === 'scatter3d'
  const isDist = type === 'box' || type === 'violin'
  const isHist = type === 'histogram'
  const isGrouped = isDist || type === 'bar'
  const usesGroup = isGrouped || isHist
  const axisFields: { key: 'x' | 'y' | 'z'; label: string }[] = usesGroup
    ? [{ key: 'y', label: 'Value' }]
    : is3d
      ? [
          { key: 'x', label: 'X axis' },
          { key: 'y', label: 'Y axis' },
          { key: 'z', label: 'Z axis' },
        ]
      : [
          { key: 'x', label: 'X axis' },
          { key: 'y', label: 'Y axis' },
        ]

  const selectClass =
    'mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500/50'
  const segClass = (active: boolean) =>
    `px-4 py-2 rounded-lg text-sm border transition-all ${
      active
        ? 'bg-green-500/10 text-green-400 border-green-500/20'
        : 'text-gray-400 border-gray-700 hover:bg-gray-800 hover:text-white'
    }`

  return (
    <div className="space-y-5 max-w-5xl">
      <div>
        <h2 className="text-lg font-semibold text-white">Chart Studio</h2>
        <p className="text-xs text-gray-500 mt-1">
          Build a chart from your uploaded data ({ds.rows.length} rows). Everything runs in your browser.
        </p>
      </div>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-5 space-y-5">
        <div className="flex flex-wrap gap-6">
          <div>
            <p className="text-xs text-gray-500 mb-2">Chart type</p>
            <div className="flex gap-2">
              {CHART_TYPES.map((c) => (
                <button key={c.id} onClick={() => setType(c.id)} className={segClass(type === c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
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
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {axisFields.map((f) => (
            <label key={f.key} className="block">
              <span className="text-xs text-gray-500">{f.label}</span>
              <select
                value={sel[f.key]}
                onChange={(e) => setSel((s) => ({ ...s, [f.key]: e.target.value }))}
                className={selectClass}
              >
                {ds.numericCols.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {usesGroup ? (
            <label className="block">
              <span className="text-xs text-gray-500">{isHist ? 'Overlay by (optional)' : 'Group by (optional)'}</span>
              <select
                value={sel.group}
                onChange={(e) => setSel((s) => ({ ...s, group: e.target.value }))}
                className={selectClass}
              >
                <option value="">{isHist ? 'None (one histogram)' : 'None (one group)'}</option>
                {groupable
                  .filter((c) => c !== sel.y)
                  .map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
              </select>
            </label>
          ) : (
            <label className="block">
              <span className="text-xs text-gray-500">Colour by (optional)</span>
              <select
                value={sel.color}
                onChange={(e) => setSel((s) => ({ ...s, color: e.target.value }))}
                className={selectClass}
              >
                <option value="">None</option>
                {ds.categoricalCols.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
          {type === 'scatter' && (
            <label className="block">
              <span className="text-xs text-gray-500">Animate over (optional)</span>
              <select value={animateBy} onChange={(e) => setAnimateBy(e.target.value)} className={selectClass}>
                <option value="">None</option>
                {ds.columns.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {type === 'scatter' && (
          <div className="flex flex-wrap items-center gap-6">
            <label
              className={`flex items-center gap-2 text-sm w-fit ${
                animateBy ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 cursor-pointer'
              }`}
              title={animateBy ? 'The fit line is not drawn while animating' : undefined}
            >
              <input
                type="checkbox"
                checked={trendline && !animateBy}
                disabled={!!animateBy}
                onChange={(e) => setTrendline(e.target.checked)}
                className="accent-green-500"
              />
              Add straight-line fit (with R²)
            </label>
            {animateBy && (
              <label className="flex items-center gap-2 text-sm text-gray-300 w-fit cursor-pointer">
                <input
                  type="checkbox"
                  checked={cumulative}
                  onChange={(e) => setCumulative(e.target.checked)}
                  className="accent-green-500"
                />
                Keep earlier points on screen
              </label>
            )}
          </div>
        )}

        {isHist && (
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <span className="text-xs text-gray-500">Bins</span>
              <input
                type="number"
                min={1}
                max={MAX_BINS}
                step={1}
                value={bins}
                placeholder="Auto"
                onChange={(e) => setBins(e.target.value)}
                className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-green-500/50"
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-300">
              <span className="text-xs text-gray-500">Bar height</span>
              <select
                value={histNorm}
                onChange={(e) => setHistNorm(e.target.value as HistNorm)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-green-500/50"
              >
                {HIST_NORM_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {isGrouped && (
          <div className="flex flex-wrap items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-gray-300 w-fit cursor-pointer">
              <input
                type="checkbox"
                checked={showPoints}
                onChange={(e) => setShowPoints(e.target.checked)}
                className="accent-green-500"
              />
              Show individual points
            </label>
            {isDist && (
              <label className="flex items-center gap-2 text-sm text-gray-300 w-fit cursor-pointer">
                <input
                  type="checkbox"
                  checked={showMean}
                  onChange={(e) => setShowMean(e.target.checked)}
                  className="accent-green-500"
                />
                {type === 'box' ? 'Show mean ± SD' : 'Show mean line'}
              </label>
            )}
            {type === 'bar' && (
              <label className="flex items-center gap-2 text-sm text-gray-300">
                <span className="text-xs text-gray-500">Error bars</span>
                <select
                  value={errorBars}
                  onChange={(e) => setErrorBars(e.target.value as ErrorBars)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-green-500/50"
                >
                  {ERROR_BAR_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
          <AlertCircle size={18} className="text-red-400 mt-0.5 shrink-0" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!plotly && !error && <p className="text-xs text-gray-500">Loading charting library…</p>}

      <div
        ref={chartRef}
        className={`w-full rounded-lg overflow-hidden border border-gray-800 ${error ? 'hidden' : ''}`}
        style={{ height: type === 'scatter' && animateBy ? 640 : 520 }}
      />

      {info && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs text-gray-500">
              {info.plotted} {type === 'histogram' ? 'values' : 'points'} plotted
              {info.skipped > 0 && ` · ${info.skipped} rows skipped (missing or non-numeric values)`}
            </p>
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
              disabled={is3d}
              title={is3d ? '3D charts cannot be exported as SVG; use PNG' : 'Vector image for papers and slides'}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Download size={14} /> SVG
            </button>
          </div>
        </div>
      )}

      {info?.summary && info.summary.length > 0 && (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 text-left">
                {['Group', 'n', 'Mean', 'SD', 'SEM', '95% CI'].map((h) => (
                  <th key={h} className="py-1 pr-4 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {info.summary.map((r) => (
                <tr key={r.group} className="border-t border-gray-800">
                  <td className="py-1 pr-4 text-white">{r.group}</td>
                  <td className="py-1 pr-4 text-white font-mono">{r.n}</td>
                  <td className="py-1 pr-4 text-white font-mono">{formatStat(r.mean)}</td>
                  <td className="py-1 pr-4 text-white font-mono">{formatStat(r.sd)}</td>
                  <td className="py-1 pr-4 text-white font-mono">{formatStat(r.sem)}</td>
                  <td className="py-1 pr-4 text-white font-mono">
                    {r.ciLow === null || r.ciHigh === null ? '—' : `${formatStat(r.ciLow)} to ${formatStat(r.ciHigh)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}