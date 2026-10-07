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

export type ChartType = 'scatter' | 'scatter3d' | 'box' | 'violin' | 'bar'

/** What the error bars on a bar chart show */
export type ErrorBars = 'sd' | 'sem' | 'ci95'
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
  /** Box and violin only: the column that splits the values into groups (omit for one group). The values come from `y`. */
  group?: string
  /** Box and violin only: draw every individual value (default true) */
  showPoints?: boolean
  /** Box and violin only: mark the mean (box: mean ± SD; violin: mean line). Default true */
  showMean?: boolean
  /** Bar chart only: standard deviation, standard error of the mean, or 95% confidence interval (default 'sd') */
  errorBars?: ErrorBars
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
  /** Bar charts: the numbers behind each bar */
  summary?: GroupSummary[]
  /** Bar charts: what the bars and error bars mean, for a figure legend */
  caption?: string
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

/**
 * Columns that make sense for splitting values into groups: the categorical ones, plus numeric
 * columns that only hold a few distinct values (like a 0/1 outcome).
 */
export function groupableColumns(ds: Dataset): string[] {
  const out = [...ds.categoricalCols]
  for (const c of ds.numericCols) {
    if (out.includes(c)) continue
    const seen = new Set<string>()
    let filled = 0
    for (const row of ds.rows) {
      const v = row[c]
      if (v === null || v === undefined || v === '') continue
      filled++
      seen.add(String(v))
      if (seen.size > MAX_GROUPS) break
    }
    // Needs 2 to MAX_GROUPS groups, averaging at least 2 rows each (so IDs and measurements are not offered).
    if (seen.size >= 2 && seen.size <= MAX_GROUPS && seen.size <= filled / 2) out.push(c)
  }
  return out
}

/** Sensible starting columns so the chart draws immediately after upload. */
export function defaultSelection(ds: Dataset): { x: string; y: string; z: string; color: string; group: string } {
  const n = ds.numericCols
  return {
    x: n[0] ?? '',
    y: n[1] ?? n[0] ?? '',
    z: n[2] ?? n[1] ?? n[0] ?? '',
    color: '',
    group: ds.categoricalCols[0] ?? '',
  }
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


// ---------- Statistics ----------

function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  const x0 = z - 1
  let x = c[0]
  for (let i = 1; i < 9; i++) x += c[i] / (x0 + i)
  const t = x0 + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (x0 + 0.5) * Math.log(t) - t + Math.log(x)
}

/** Continued fraction for the incomplete beta function (Numerical Recipes). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 3e-14) break
  }
  return h
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2)
    ? (bt * betaContinuedFraction(a, b, x)) / a
    : 1 - (bt * betaContinuedFraction(b, a, 1 - x)) / b
}

/** Student-t cumulative distribution function for t >= 0. */
function tCdfPositive(t: number, df: number): number {
  return 1 - 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5)
}

/** Student-t quantile (inverse CDF), e.g. tQuantile(0.975, 9) = 2.262. */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1) || !(df > 0)) return NaN
  if (p === 0.5) return 0
  if (p < 0.5) return -tQuantile(1 - p, df)
  let lo = 0
  let hi = 1
  while (tCdfPositive(hi, df) < p && hi < 1e12) hi *= 2
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (tCdfPositive(mid, df) < p) lo = mid
    else hi = mid
    if (hi - lo < 1e-13 * Math.max(1, hi)) break
  }
  return (lo + hi) / 2
}

export interface GroupStats {
  n: number
  mean: number
  /** Sample standard deviation (n - 1); null with fewer than 2 values */
  sd: number | null
  sem: number | null
  ciLow: number | null
  ciHigh: number | null
}

export interface GroupSummary extends GroupStats {
  group: string
}

export function groupStats(values: number[]): GroupStats {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { n, mean, sd: null, sem: null, ciLow: null, ciHigh: null }
  const ss = values.reduce((a, v) => a + (v - mean) * (v - mean), 0)
  const sd = Math.sqrt(ss / (n - 1))
  const sem = sd / Math.sqrt(n)
  const half = tQuantile(0.975, n - 1) * sem
  return { n, mean, sd, sem, ciLow: mean - half, ciHigh: mean + half }
}

/** Compact number formatting for tables: 4 significant figures. */
export function formatStat(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—'
  if (Number.isInteger(n)) return String(n)
  const abs = Math.abs(n)
  if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return n.toExponential(2)
  return String(Number(n.toPrecision(4)))
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

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

function figureConfig(): Partial<Config> {
  return {
    responsive: true,
    displaylogo: false,
    toImageButtonOptions: { format: 'png', scale: 2, filename: 'omnistat-chart' },
  }
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


/**
 * Validates the choices and splits the value column into groups.
 * Shared by box, violin and bar charts.
 */
function collectGroups(
  ds: Dataset,
  cfg: ChartConfig
): { groups: Map<string, number[]>; names: string[]; plotted: number; skipped: number } {
  if (!cfg.y) throw new ChartError('Choose the column to summarise.')
  for (const c of [cfg.y, ...(cfg.group ? [cfg.group] : [])]) {
    if (!ds.columns.includes(c)) throw new ChartError(`Column "${c}" is not in your data.`)
  }

  const groups = new Map<string, number[]>()
  let plotted = 0
  let skipped = 0
  for (const row of ds.rows) {
    const y = toNumber(row[cfg.y])
    if (y === null) {
      skipped++
      continue
    }
    const label = cfg.group ? groupLabel(row[cfg.group]) : cfg.y
    const list = groups.get(label)
    if (list) list.push(y)
    else groups.set(label, [y])
    plotted++
  }
  if (plotted < 2) {
    throw new ChartError(`Not enough numeric values to plot (${plotted}). Check that ${cfg.y} contains numbers.`)
  }
  if (groups.size > MAX_GROUPS) {
    throw new ChartError(
      `"${cfg.group}" has ${groups.size} different values, which is too many to compare. Choose a column with at most ${MAX_GROUPS}.`
    )
  }
  const names = Array.from(groups.keys()).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  return { groups, names, plotted, skipped }
}

/** Box or violin plot: one box/violin per group, with the individual values drawn on top. */
function buildDistribution(ds: Dataset, cfg: ChartConfig): Figure {
  const isViolin = cfg.type === 'violin'
  const t = THEMES[cfg.preset]
  const showPoints = cfg.showPoints !== false
  const showMean = cfg.showMean !== false
  const { groups, names, plotted, skipped } = collectGroups(ds, cfg)
  const graphpad = cfg.preset === 'graphpad'

  const data: Data[] = names.map((name, i) => {
    const colour = t.palette[i % t.palette.length]
    const common = {
      name,
      y: groups.get(name) as number[],
      showlegend: false,
      line: { color: colour, width: 2 },
      fillcolor: graphpad ? 'rgba(255,255,255,0)' : withAlpha(colour, 0.25),
    }
    const pointStyle = {
      marker: { color: colour, size: graphpad ? 7 : 6, opacity: graphpad ? 0.9 : 0.75 },
      jitter: 0.5,
      pointpos: 0,
    }
    if (isViolin) {
      return {
        type: 'violin',
        ...common,
        // point settings only apply (and are only sent) when points are drawn
        ...(showPoints ? { points: 'all', ...pointStyle } : { points: false }),
        box: { visible: true },
        meanline: { visible: showMean },
        spanmode: 'hard',
      } as Data
    }
    return {
      type: 'box',
      ...common,
      ...pointStyle,
      boxpoints: showPoints ? 'all' : 'outliers',
      boxmean: showMean ? 'sd' : false,
    } as Data
  })

  const notes: string[] = []
  const small = names.filter((n) => (groups.get(n) as number[]).length < 5)
  if (small.length > 0) {
    const list = small.map((n) => `${n} (n=${(groups.get(n) as number[]).length})`).join(', ')
    notes.push(
      `Small groups: ${list}. With so few values the ${isViolin ? 'violin' : 'box'} shape is not very reliable${
        showPoints ? '; every individual value is shown.' : '. Turn on individual points to see them all.'
      }`
    )
  }

  const layout = baseLayout(t, false)
  layout.xaxis = { ...axisFor(cfg.group ?? '', t), type: 'category' }
  layout.yaxis = axisFor(cfg.y, t)

  return { data, layout, config: figureConfig(), plotted, skipped, groups: names.length, notes }
}


function errorBarWords(mode: ErrorBars): { short: string; long: string } {
  if (mode === 'sem') return { short: 'SEM', long: 'the standard error of the mean (SEM)' }
  if (mode === 'ci95') return { short: '95% CI', long: 'the 95% confidence interval of the mean' }
  return { short: 'SD', long: 'the standard deviation (SD)' }
}

/** Bar chart of group means with error bars, plus the individual values on top. */
function buildBar(ds: Dataset, cfg: ChartConfig): Figure {
  const t = THEMES[cfg.preset]
  const mode: ErrorBars = cfg.errorBars ?? 'sd'
  const showPoints = cfg.showPoints !== false
  const graphpad = cfg.preset === 'graphpad'
  const { groups, names, plotted, skipped } = collectGroups(ds, cfg)

  const stats = names.map((n) => groupStats(groups.get(n) as number[]))
  const halves: Array<number | null> = stats.map((s) => {
    if (s.sd === null || s.sem === null || s.ciHigh === null) return null
    return mode === 'sd' ? s.sd : mode === 'sem' ? s.sem : s.ciHigh - s.mean
  })
  const colours = names.map((_, i) => t.palette[i % t.palette.length])
  const words = errorBarWords(mode)

  const data: Data[] = [
    {
      type: 'bar',
      name: cfg.y,
      x: names,
      y: stats.map((s) => s.mean),
      marker: {
        color: colours.map((c) => withAlpha(c, graphpad ? 0.15 : 0.45)),
        line: { color: colours, width: 2 },
      },
      error_y: { type: 'data', symmetric: true, array: halves, visible: true, color: t.text, thickness: 2, width: 6 },
      customdata: stats.map((s, i) => [s.n, halves[i]]),
      hovertemplate: `%{x}<br>mean: %{y:.4g}<br>n = %{customdata[0]}<br>± %{customdata[1]:.4g} (${words.short})<extra></extra>`,
      showlegend: false,
    } as Data,
  ]

  if (showPoints) {
    data.push({
      type: 'box',
      name: 'values',
      showlegend: false,
      x: names.flatMap((n) => (groups.get(n) as number[]).map(() => n)),
      y: names.flatMap((n) => groups.get(n) as number[]),
      boxpoints: 'all',
      jitter: 0.6,
      pointpos: 0,
      fillcolor: 'rgba(0,0,0,0)',
      line: { color: 'rgba(0,0,0,0)', width: 0 },
      marker: { color: graphpad ? '#000000' : '#e5e7eb', size: graphpad ? 7 : 6, opacity: graphpad ? 0.9 : 0.8 },
      hoverinfo: 'y',
    } as Data)
  }

  const notes: string[] = []
  const single = names.filter((_, i) => stats[i].n < 2)
  if (single.length > 0) {
    notes.push(`No error bar for ${single.join(', ')}: a group needs at least 2 values.`)
  }

  const layout = baseLayout(t, false)
  layout.xaxis = { ...axisFor(cfg.group ?? '', t), type: 'category' }
  layout.yaxis = axisFor(cfg.y, t)
  layout.bargap = 0.45

  return {
    data,
    layout,
    config: figureConfig(),
    plotted,
    skipped,
    groups: names.length,
    notes,
    summary: names.map((group, i) => ({ group, ...stats[i] })),
    caption:
      `Bars show the mean of each group. Error bars show ${words.long}.` +
      (showPoints ? ' Dots are the individual values.' : ''),
  }
}

export function buildFigure(ds: Dataset, cfg: ChartConfig): Figure {
  if (cfg.type === 'box' || cfg.type === 'violin') return buildDistribution(ds, cfg)
  if (cfg.type === 'bar') return buildBar(ds, cfg)
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
    config: figureConfig(),
    plotted: pts.length,
    skipped,
    groups: names.length,
    notes,
  }
}