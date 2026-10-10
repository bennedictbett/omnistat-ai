import type { Config, Data, Frame, Layout, LayoutAxis } from 'plotly.js-dist-min'

// Pure functions that turn an uploaded dataset plus a few choices into a Plotly figure.
// No React and no Plotly runtime in here, so everything is easy to test.

// ---------- Types ----------

export interface Dataset {
  columns: string[]
  numericCols: string[]
  categoricalCols: string[]
  rows: Record<string, unknown>[]
}

export type ChartType = 'scatter' | 'scatter3d' | 'histogram' | 'box' | 'violin' | 'bar'

/** What the error bars on a bar chart show */
export type ErrorBars = 'sd' | 'sem' | 'ci95'
export type StylePreset = 'dark' | 'graphpad'
/** What the bar heights of a histogram show */
export type HistNorm = 'count' | 'percent' | 'density'

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
  /** Histogram only: number of bins (omit or 0 for automatic) */
  bins?: number
  /** Histogram only: bar heights as counts, percent of values, or density (default 'count') */
  histNorm?: HistNorm
  /** 2D scatter only: a column to animate over. One frame per distinct value (sorted if numeric or a date). */
  animateBy?: string
  /** 2D scatter only: keep the points of earlier frames on screen as the animation advances (default false) */
  cumulative?: boolean
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
  /** Animated charts: one frame per value of the animation column (the first frame is also in `data`) */
  frames?: Partial<Frame>[]
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

export function axisFor(title: string, t: Theme): Partial<LayoutAxis> {
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

export function baseLayout(t: Theme, showLegend: boolean): Partial<Layout> {
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

/** Styling of one axis of a 3D scene, shared by every 3D chart so they look alike. */
export function sceneAxisFor(title: string, preset: StylePreset, t: Theme, extra: Record<string, unknown> = {}) {
  return {
    title: { text: title },
    showline: true,
    linecolor: t.axisLine,
    linewidth: 2,
    showgrid: true,
    gridcolor: preset === 'graphpad' ? '#d1d5db' : '#374151',
    zeroline: false,
    showbackground: true,
    backgroundcolor: preset === 'graphpad' ? '#ffffff' : '#111827',
    ...extra,
  }
}

function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

export function figureConfig(): Partial<Config> {
  return {
    responsive: true,
    displaylogo: false,
    toImageButtonOptions: { format: 'png', scale: 2, filename: 'omnistat-chart' },
  }
}


// ---------- Animation ----------

/** Most frames one animation may have; more makes the slider unusable and the chart heavy. */
export const MAX_FRAMES = 200
const FRAME_MS = 600
const TRANSITION_MS = 300
// Only strict year-first dates are treated as dates, because Date.parse also accepts odd text like "Group 1".
const ISO_DATE = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?([T ].*)?$/

/**
 * Puts the distinct values of the animation column in playing order: numbers ascending,
 * year-first dates chronologically, anything else in the order it first appears in the data.
 * Numeric labels must already be normalised (String(number)).
 */
export function orderFrameLabels(labels: string[], numeric: boolean): string[] {
  const uniq = Array.from(new Set(labels))
  if (numeric) return uniq.sort((a, b) => Number(a) - Number(b))
  if (uniq.length > 0 && uniq.every((l) => ISO_DATE.test(l))) {
    const time = new Map(uniq.map((l) => [l, Date.parse(l.replace(/\//g, '-'))]))
    if (Array.from(time.values()).every((v) => !Number.isNaN(v))) {
      return uniq.sort((a, b) => (time.get(a) as number) - (time.get(b) as number))
    }
  }
  return uniq
}

export interface AnimationFrame {
  label: string
  /** x and y values per group, in the same order as the chart's traces */
  x: number[][]
  y: number[][]
}

/** Splits the points into one frame per label. With `cumulative`, a frame also holds all earlier points. */
export function buildFrames(
  pts: { x: number; y: number; g: string; f: string }[],
  names: string[],
  labels: string[],
  cumulative: boolean
): AnimationFrame[] {
  const groupIndex = new Map(names.map((n, i) => [n, i]))
  const frameIndex = new Map(labels.map((l, i) => [l, i]))
  const cells = labels.map(() => names.map(() => ({ x: [] as number[], y: [] as number[] })))
  for (const p of pts) {
    const cell = cells[frameIndex.get(p.f) as number][groupIndex.get(p.g) as number]
    cell.x.push(p.x)
    cell.y.push(p.y)
  }
  let runX: number[][] = names.map(() => [])
  let runY: number[][] = names.map(() => [])
  return labels.map((label, i) => {
    if (!cumulative) return { label, x: cells[i].map((c) => c.x), y: cells[i].map((c) => c.y) }
    // concat returns new arrays, so frames already handed out are never changed afterwards
    runX = runX.map((a, g) => a.concat(cells[i][g].x))
    runY = runY.map((a, g) => a.concat(cells[i][g].y))
    return { label, x: [...runX], y: [...runY] }
  })
}

/** Axis range that fits every frame, so the axes stay still while the points move. */
function paddedRange(values: number[]): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const v of values) {
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  const span = hi - lo
  const pad = span > 0 ? span * 0.05 : Math.abs(lo) * 0.05 || 1
  return [lo - pad, hi + pad]
}

/** Play and Pause buttons plus a slider, drawn by Plotly itself. */
function animationControls(frames: AnimationFrame[], column: string, t: Theme): Partial<Layout> {
  const play = {
    frame: { duration: FRAME_MS, redraw: false },
    transition: { duration: TRANSITION_MS, easing: 'linear' },
    fromcurrent: true,
    mode: 'immediate',
  }
  const stop = { frame: { duration: 0, redraw: false }, transition: { duration: 0 }, mode: 'immediate' }
  const hidden = 'rgba(0,0,0,0)'
  // Past about a dozen frames the slider's own tick labels collide, so they are hidden;
  // the label of the current frame is still shown above the slider.
  const crowded = frames.length > 12
  return {
    updatemenus: [
      {
        type: 'buttons',
        direction: 'left',
        showactive: false,
        x: 0,
        xanchor: 'left',
        y: 1,
        yanchor: 'bottom',
        pad: { b: 10 },
        bgcolor: t.plot === hidden ? '#1f2937' : '#ffffff',
        bordercolor: t.axisLine,
        borderwidth: 1,
        font: { color: t.text, size: t.fontSize },
        buttons: [
          { label: '▶ Play', method: 'animate', args: [null, play] },
          { label: '❚❚ Pause', method: 'animate', args: [[null], stop] },
        ],
      },
    ],
    sliders: [
      {
        active: 0,
        x: 0,
        len: 1,
        xanchor: 'left',
        y: 0,
        yanchor: 'top',
        pad: { t: 90, b: 0 },
        font: { color: crowded ? hidden : t.text, size: t.fontSize },
        tickcolor: t.axisLine,
        bgcolor: t.plot === hidden ? '#374151' : '#e5e7eb',
        bordercolor: t.axisLine,
        activebgcolor: t.palette[0],
        currentvalue: { prefix: `${column}: `, xanchor: 'left', font: { color: t.text, size: t.fontSize } },
        steps: frames.map((f) => ({
          label: f.label,
          method: 'animate',
          args: [[f.label], { mode: 'immediate', frame: { duration: 0, redraw: false }, transition: { duration: 0 } }],
        })),
      },
    ],
  } as unknown as Partial<Layout>
}

// ---------- Figure ----------

interface Point {
  x: number
  y: number
  z: number
  g: string
  /** Animation frame label (empty when not animating) */
  f: string
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


// ---------- Histogram ----------

/** Maximum number of groups that can be overlaid on one histogram before it becomes unreadable. */
export const MAX_HIST_GROUPS = 8
export const MAX_BINS = 100

/** Linear-interpolated quantile of an ascending-sorted array. */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * p
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export interface BinPlan {
  start: number
  end: number
  size: number
  count: number
}

/**
 * Chooses bins shared by every group, so overlaid histograms line up.
 * `requested` > 0 fixes the bin count; otherwise the Freedman-Diaconis rule is used,
 * falling back to Sturges' rule when the interquartile range is zero.
 */
export function planBins(values: number[], requested?: number): BinPlan {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const min = sorted[0]
  const max = sorted[n - 1]
  if (min === max) return { start: min - 0.5, end: min + 0.5, size: 1, count: 1 }

  let count: number
  if (requested && requested > 0) {
    count = Math.floor(requested)
  } else {
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25)
    const width = iqr > 0 ? (2 * iqr) / Math.cbrt(n) : 0
    count = width > 0 ? Math.ceil((max - min) / width) : Math.ceil(Math.log2(n)) + 1
  }
  count = Math.max(1, Math.min(MAX_BINS, count))

  // Widen each bin very slightly so the largest value falls inside the last bin instead of
  // starting a bin of its own (Plotly bins are closed on the left only).
  const size = ((max - min) / count) * (1 + 1e-6)
  return { start: min, end: min + size * count, size, count }
}

const HIST_NORM: Record<HistNorm, { plotly: string; axis: string; words: string }> = {
  count: { plotly: '', axis: 'Count', words: 'the number of values in each bin' },
  percent: { plotly: 'percent', axis: 'Percent of values (%)', words: 'the percent of values in each bin' },
  density: { plotly: 'probability density', axis: 'Density', words: 'the density (the total area is 1)' },
}

/** Histogram of one column, optionally one overlaid histogram per group. */
function buildHistogram(ds: Dataset, cfg: ChartConfig): Figure {
  const t = THEMES[cfg.preset]
  const norm: HistNorm = cfg.histNorm ?? 'count'
  const graphpad = cfg.preset === 'graphpad'
  const { groups, names, plotted, skipped } = collectGroups(ds, cfg)
  if (names.length > MAX_HIST_GROUPS) {
    throw new ChartError(
      `"${cfg.group}" has ${names.length} different values, which is too many to overlay. Choose a column with at most ${MAX_HIST_GROUPS}.`
    )
  }
  const multi = names.length > 1
  const plan = planBins(names.flatMap((n) => groups.get(n) as number[]), cfg.bins)

  const data: Data[] = names.map((name, i) => {
    const colour = t.palette[i % t.palette.length]
    return {
      type: 'histogram',
      name,
      x: groups.get(name) as number[],
      xbins: { start: plan.start, end: plan.end, size: plan.size },
      autobinx: false,
      histnorm: HIST_NORM[norm].plotly,
      marker: {
        color: withAlpha(colour, graphpad ? (multi ? 0.25 : 0.15) : multi ? 0.55 : 0.7),
        line: { color: colour, width: graphpad ? 2 : 1 },
      },
      showlegend: multi,
      hovertemplate: `${cfg.y}: %{x}<br>${HIST_NORM[norm].axis}: %{y:.4g}<extra>${multi ? name : ''}</extra>`,
    } as Data
  })

  const layout = baseLayout(t, multi)
  layout.xaxis = axisFor(cfg.y, t)
  layout.yaxis = axisFor(HIST_NORM[norm].axis, t)
  layout.barmode = 'overlay'
  layout.bargap = graphpad ? 0 : 0.03

  const notes: string[] = []
  const small = names.filter((n) => (groups.get(n) as number[]).length < 10)
  if (small.length > 0) {
    const list = small.map((n) => `${multi ? n + ' ' : ''}(n=${(groups.get(n) as number[]).length})`).join(', ')
    notes.push(`Few values: ${list}. A histogram of fewer than 10 values says little about the shape of the data.`)
  }
  if (multi && norm !== 'count') {
    notes.push('Each group is scaled by its own total, so groups of different sizes can be compared by shape.')
  }

  return {
    data,
    layout,
    config: figureConfig(),
    plotted,
    skipped,
    groups: names.length,
    notes,
    caption:
      `Bar heights show ${HIST_NORM[norm].words}. ${plan.count} ${plan.count === 1 ? 'bin' : 'bins'} of width ${formatStat(plan.size)}` +
      `${cfg.bins && cfg.bins > 0 ? '' : ' (chosen automatically)'}.`,
  }
}

export function buildFigure(ds: Dataset, cfg: ChartConfig): Figure {
  if (cfg.type === 'histogram') return buildHistogram(ds, cfg)
  if (cfg.type === 'box' || cfg.type === 'violin') return buildDistribution(ds, cfg)
  if (cfg.type === 'bar') return buildBar(ds, cfg)
  const is3d = cfg.type === 'scatter3d'
  const needed = is3d ? [cfg.x, cfg.y, cfg.z ?? ''] : [cfg.x, cfg.y]
  if (needed.some((c) => !c)) throw new ChartError('Choose a column for every axis.')
  for (const c of [...needed, ...(cfg.color ? [cfg.color] : [])]) {
    if (!ds.columns.includes(c)) throw new ChartError(`Column "${c}" is not in your data.`)
  }

  const t = THEMES[cfg.preset]
  const animateBy = !is3d && cfg.animateBy ? cfg.animateBy : ''
  if (animateBy && !ds.columns.includes(animateBy)) throw new ChartError(`Column "${animateBy}" is not in your data.`)
  const animNumeric = animateBy !== '' && ds.numericCols.includes(animateBy)
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
    let f = ''
    if (animateBy) {
      const raw = row[animateBy]
      if (animNumeric) {
        const n = toNumber(raw)
        if (n === null) {
          skipped++
          continue
        }
        f = String(n)
      } else {
        f = raw === null || raw === undefined ? '' : String(raw).trim()
        if (f === '') {
          skipped++
          continue
        }
      }
    }
    pts.push({ x, y, z, g: cfg.color ? groupLabel(row[cfg.color]) : '', f })
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

  // Animation: one frame per value of the animation column.
  let frames: AnimationFrame[] | null = null
  let frameLabels: string[] = []
  if (animateBy) {
    frameLabels = orderFrameLabels(pts.map((p) => p.f), animNumeric)
    if (frameLabels.length < 2) {
      throw new ChartError(`"${animateBy}" has only one value in the plotted rows, so there is nothing to animate over.`)
    }
    if (frameLabels.length > MAX_FRAMES) {
      throw new ChartError(
        `"${animateBy}" has ${frameLabels.length} different values, which is more than the ${MAX_FRAMES} frames an animation can have. Choose a column with fewer values, such as a year instead of a full date.`
      )
    }
    frames = buildFrames(pts, names, frameLabels, !!cfg.cumulative)
  }

  // The WebGL scatter cannot animate smoothly, so animated charts always use the standard one.
  const useGL = !is3d && !frames && pts.length > GL_THRESHOLD
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
        x: frames ? frames[0].x[i] : list.map((p) => p.x),
        y: frames ? frames[0].y[i] : list.map((p) => p.y),
        marker,
        showlegend: multi,
      } as Data)
    }
  })

  const notes: string[] = []
  let hasFitLines = false
  if (frames && cfg.trendline) notes.push('The straight-line fit is not drawn while animating. Set "Animate over" to None to see it.')
  if (!is3d && cfg.trendline && !frames) {
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
    const sceneAxis = (title: string) => sceneAxisFor(title, cfg.preset, t)
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

  if (frames) {
    layout.xaxis = { ...layout.xaxis, range: paddedRange(pts.map((p) => p.x)), autorange: false }
    layout.yaxis = { ...layout.yaxis, range: paddedRange(pts.map((p) => p.y)), autorange: false }
    Object.assign(layout, animationControls(frames, animateBy, t))
    layout.margin = { l: 70, r: 30, t: 60, b: 160 }
  }

  return {
    data,
    layout,
    config: figureConfig(),
    plotted: pts.length,
    skipped,
    groups: names.length,
    notes,
    ...(frames
      ? {
          frames: frames.map((f) => ({ name: f.label, data: f.x.map((x, i) => ({ x, y: f.y[i] })) })) as Partial<Frame>[],
          caption:
            `Animating over "${animateBy}": ${frames.length} frames, from ${frameLabels[0]} to ${frameLabels[frameLabels.length - 1]}` +
            `${cfg.animateBy && cfg.cumulative ? ', keeping earlier points on screen' : ', one frame at a time'}. Use Play, or drag the slider.`,
        }
      : {}),
  }
}