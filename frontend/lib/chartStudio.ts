import type { Config, Data, Layout, LayoutAxis } from 'plotly.js-dist-min'

// Pure functions that turn an uploaded dataset plus a few choices into a Plotly figure.
// No React and no Plotly runtime in here, so everything is easy to test.

// ---------- Types ----------

export interface Dataset {
  columns: string[]
  numericCols: string[]
  categoricalCols: string[]
  rows: Record<string, unknown>[]
}

export type ChartType = 'scatter' | 'scatter3d'
export type StylePreset = 'dark' | 'graphpad'

export interface ChartConfig {
  type: ChartType
  x: string
  y: string
  z?: string
  /** Optional categorical column: one colour (and legend entry) per category */
  color?: string
  preset: StylePreset
  /** 2D scatter only: add a least-squares line (per group when colouring) */
  trendline?: boolean
}

export interface Figure {
  data: Data[]
  layout: Partial<Layout>
  config: Partial<Config>
  plotted: number
  skipped: number
  groups: number
  /** Plain-language explanations for things the user might wonder about (e.g. a missing fit line) */
  notes: string[]
}

/** An error whose message is safe to show to the user. */
export class ChartError extends Error {}

export const MAX_GROUPS = 30
/** Above this many points, 2D scatter switches to WebGL so it stays smooth. */
export const GL_THRESHOLD = 20_000

// ---------- Dataset ----------

/** Converts the object the Upload tab produces into a Dataset (or null if it is not usable). */
export function toDataset(raw: unknown): Dataset | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.columns) || !Array.isArray(r.full_data)) return null
  const columns = r.columns.map(String)
  const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  return {
    columns,
    numericCols: strings(r.numeric_cols).filter((c) => columns.includes(c)),
    categoricalCols: strings(r.categorical_cols).filter((c) => columns.includes(c)),
    rows: r.full_data as Record<string, unknown>[],
  }
}

/** Sensible starting columns so the chart draws immediately after upload. */
export function defaultSelection(ds: Dataset): { x: string; y: string; z: string; color: string } {
  const n = ds.numericCols
  return { x: n[0] ?? '', y: n[1] ?? n[0] ?? '', z: n[2] ?? n[1] ?? n[0] ?? '', color: '' }
}

// ---------- Numbers ----------

export function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export interface LinearFit {
  slope: number
  intercept: number
  r2: number
}

/** Ordinary least squares. Returns null when it cannot be defined (fewer than 3 points or constant x). */
export function linearFit(xs: number[], ys: number[]): LinearFit | null {
  const n = xs.length
  if (n < 3 || n !== ys.length) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { slope, intercept, r2 }
}

// ---------- Style presets ----------

interface Theme {
  paper: string
  plot: string
  text: string
  grid: string | null
  axisLine: string
  fontFamily: string
  fontSize: number
  palette: string[]
  pointSize: number
  markerOutline: string
}

const THEMES: Record<StylePreset, Theme> = {
  // Matches the app's dark UI.
  dark: {
    paper: 'rgba(0,0,0,0)',
    plot: 'rgba(0,0,0,0)',
    text: '#d1d5db',
    grid: '#1f2937',
    axisLine: '#4b5563',
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 12,
    palette: ['#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#34d399', '#fb923c', '#22d3ee'],
    pointSize: 8,
    markerOutline: 'rgba(0,0,0,0)',
  },
  // Publication look: white, no gridlines, heavy axes, ticks outside, black-first palette.
  graphpad: {
    paper: '#ffffff',
    plot: '#ffffff',
    text: '#000000',
    grid: null,
    axisLine: '#000000',
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontSize: 14,
    palette: ['#000000', '#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#a65628', '#f781bf'],
    pointSize: 9,
    markerOutline: '#000000',
  },
}

export function themeFor(preset: StylePreset): Theme {
  return THEMES[preset]
}

function axisFor(title: string, t: Theme): Partial<LayoutAxis> {
  const axis: Partial<LayoutAxis> = {
    title: { text: title, standoff: 12 },
    showline: true,
    linecolor: t.axisLine,
    linewidth: 2,
    ticks: 'outside',
    tickcolor: t.axisLine,
    tickwidth: 2,
    ticklen: 6,
    showgrid: false,
    zeroline: false,
    mirror: false,
    automargin: true,
  }
  if (t.grid) {
    axis.showgrid = true
    axis.gridcolor = t.grid
  }
  return axis
}

function baseLayout(t: Theme, showLegend: boolean): Partial<Layout> {
  const layout: Partial<Layout> = {
    paper_bgcolor: t.paper,
    plot_bgcolor: t.plot,
    font: { family: t.fontFamily, size: t.fontSize, color: t.text },
    margin: { l: 70, r: 30, t: 30, b: 60 },
    showlegend: showLegend,
    hovermode: 'closest',
  }
  // Only describe the legend when there is one (Plotly's validator rejects it otherwise).
  if (showLegend) layout.legend = { bgcolor: 'rgba(0,0,0,0)', borderwidth: 0 }
  return layout
}

// ---------- Figure ----------

interface Point {
  x: number
  y: number
  z: number
  g: string
}

function groupLabel(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(missing)'
  return String(v)
}

export function buildFigure(ds: Dataset, cfg: ChartConfig): Figure {
  const is3d = cfg.type === 'scatter3d'
  const needed = is3d ? [cfg.x, cfg.y, cfg.z ?? ''] : [cfg.x, cfg.y]
  if (needed.some((c) => !c)) throw new ChartError('Choose a column for every axis.')
  for (const c of [...needed, ...(cfg.color ? [cfg.color] : [])]) {
    if (!ds.columns.includes(c)) throw new ChartError(`Column "${c}" is not in your data.`)
  }

  const t = THEMES[cfg.preset]
  const pts: Point[] = []
  let skipped = 0
  for (const row of ds.rows) {
    const x = toNumber(row[cfg.x])
    const y = toNumber(row[cfg.y])
    const z = is3d ? toNumber(row[cfg.z as string]) : 0
    if (x === null || y === null || z === null) {
      skipped++
      continue
    }
    pts.push({ x, y, z, g: cfg.color ? groupLabel(row[cfg.color]) : '' })
  }
  if (pts.length < 2) {
    throw new ChartError(
      `Not enough numeric values to plot (${pts.length}). Check that ${needed.join(', ')} contain numbers.`
    )
  }

  const byGroup = new Map<string, Point[]>()
  for (const p of pts) {
    const list = byGroup.get(p.g)
    if (list) list.push(p)
    else byGroup.set(p.g, [p])
  }
  if (byGroup.size > MAX_GROUPS) {
    throw new ChartError(
      `"${cfg.color}" has ${byGroup.size} different values, which is too many to colour by. Choose a column with at most ${MAX_GROUPS}.`
    )
  }
  const names = Array.from(byGroup.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const multi = names.length > 1

  const useGL = !is3d && pts.length > GL_THRESHOLD
  const data: Data[] = []

  names.forEach((name, i) => {
    const list = byGroup.get(name) as Point[]
    const colour = t.palette[i % t.palette.length]
    const marker = {
      size: is3d ? 4 : t.pointSize,
      color: colour,
      opacity: is3d ? 0.9 : cfg.preset === 'graphpad' ? 0.95 : 0.8,
      line: { width: is3d || t.markerOutline === 'rgba(0,0,0,0)' ? 0 : 1, color: t.markerOutline },
    }
    if (is3d) {
      data.push({
        type: 'scatter3d',
        mode: 'markers',
        ...(name ? { name } : {}),
        x: list.map((p) => p.x),
        y: list.map((p) => p.y),
        z: list.map((p) => p.z),
        marker,
        showlegend: multi,
      } as Data)
    } else {
      data.push({
        type: useGL ? 'scattergl' : 'scatter',
        mode: 'markers',
        ...(name ? { name } : {}),
        x: list.map((p) => p.x),
        y: list.map((p) => p.y),
        marker,
        showlegend: multi,
      } as Data)
    }
  })

  const notes: string[] = []
  let hasFitLines = false
  if (!is3d && cfg.trendline) {
    names.forEach((name, i) => {
      const list = byGroup.get(name) as Point[]
      const fit = linearFit(list.map((p) => p.x), list.map((p) => p.y))
      if (!fit) {
        notes.push(`No fit line for ${name ? `"${name}"` : 'this data'}: it needs at least 3 points that are not all at the same x value.`)
        return
      }
      const xs = list.map((p) => p.x)
      const x0 = Math.min(...xs)
      const x1 = Math.max(...xs)
      hasFitLines = true
      data.push({
        type: 'scatter',
        mode: 'lines',
        name: `${name ? name + ' ' : ''}fit (R² = ${fit.r2.toFixed(2)})`,
        x: [x0, x1],
        y: [fit.intercept + fit.slope * x0, fit.intercept + fit.slope * x1],
        line: { color: t.palette[i % t.palette.length], width: 2, dash: 'dash' },
        hoverinfo: 'skip',
        showlegend: true,
      } as Data)
    })
  }

  const showLegend = multi || hasFitLines
  const layout: Partial<Layout> = baseLayout(t, showLegend)

  if (is3d) {
    const sceneAxis = (title: string) => ({
      title: { text: title },
      showline: true,
      linecolor: t.axisLine,
      linewidth: 2,
      showgrid: true,
      gridcolor: cfg.preset === 'graphpad' ? '#d1d5db' : '#374151',
      zeroline: false,
      showbackground: true,
      backgroundcolor: cfg.preset === 'graphpad' ? '#ffffff' : '#111827',
    })
    layout.scene = {
      xaxis: sceneAxis(cfg.x),
      yaxis: sceneAxis(cfg.y),
      zaxis: sceneAxis(cfg.z as string),
    } as Layout['scene']
    layout.margin = { l: 0, r: 0, t: 10, b: 0 }
    delete layout.plot_bgcolor // 3D charts have no 2D plot area; the scene backgrounds above apply
  } else {
    layout.xaxis = axisFor(cfg.x, t)
    layout.yaxis = axisFor(cfg.y, t)
  }

  return {
    data,
    layout,
    config: {
      responsive: true,
      displaylogo: false,
      toImageButtonOptions: { format: 'png', scale: 2, filename: 'omnistat-chart' },
    },
    plotted: pts.length,
    skipped,
    groups: names.length,
    notes,
  }
}