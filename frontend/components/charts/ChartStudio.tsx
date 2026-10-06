'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Download, Upload } from 'lucide-react'
import {
  ChartConfig,
  ChartError,
  ChartType,
  StylePreset,
  buildFigure,
  defaultSelection,
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
]

const PRESETS: { id: StylePreset; label: string; hint: string }[] = [
  { id: 'dark', label: 'Dark', hint: 'Matches the app' },
  { id: 'graphpad', label: 'GraphPad style', hint: 'White, no grid, heavy axes: for papers and slides' },
]

export default function ChartStudio({ data }: Props) {
  const ds = useMemo(() => toDataset(data), [data])
  const datasetKey = ds ? ds.columns.join('|') : ''

  const [type, setType] = useState<ChartType>('scatter')
  const [preset, setPreset] = useState<StylePreset>('dark')
  const [trendline, setTrendline] = useState(false)
  const [sel, setSel] = useState({ x: '', y: '', z: '', color: '' })
  const [plotly, setPlotly] = useState<PlotlyApi | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{ plotted: number; skipped: number; notes: string[] } | null>(null)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey])

  // Draw whenever the data or any choice changes.
  useEffect(() => {
    const el = chartRef.current
    if (!plotly || !ds || !el) return
    const cfg: ChartConfig = {
      type,
      x: sel.x,
      y: sel.y,
      z: type === 'scatter3d' ? sel.z : undefined,
      color: sel.color || undefined,
      preset,
      trendline: type === 'scatter' ? trendline : false,
    }
    const myDraw = ++drawId.current
    try {
      const fig = buildFigure(ds, cfg)
      setError(null)
      setInfo({ plotted: fig.plotted, skipped: fig.skipped, notes: fig.notes })
      // Drawing can also fail later (e.g. 3D without WebGL); ignore failures from superseded draws.
      Promise.resolve(plotly.newPlot(el, fig.data, fig.layout, fig.config)).catch(() => {
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
  }, [plotly, ds, type, sel, preset, trendline])

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
        <p className="text-xs text-gray-400 mt-1">Scatter charts need at least two columns of numbers.</p>
      </div>
    )
  }

  const is3d = type === 'scatter3d'
  const axisFields: { key: 'x' | 'y' | 'z'; label: string }[] = is3d
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
        </div>

        {!is3d && (
          <label className="flex items-center gap-2 text-sm text-gray-300 w-fit cursor-pointer">
            <input
              type="checkbox"
              checked={trendline}
              onChange={(e) => setTrendline(e.target.checked)}
              className="accent-green-500"
            />
            Add straight-line fit (with R²)
          </label>
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
        style={{ height: 520 }}
      />

      {info && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-xs text-gray-500">
              {info.plotted} points plotted
              {info.skipped > 0 && ` · ${info.skipped} rows skipped (missing or non-numeric values)`}
            </p>
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
    </div>
  )
}