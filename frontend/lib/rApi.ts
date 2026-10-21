import { API_URL } from '@/lib/config'

// ---------- Types ----------

/** One entry of GET /api/r/tests: what a test is called and which columns it needs. */
export interface RTestSpec {
  title: string
  /** role -> human description, e.g. { outcome: "numeric outcome column" } */
  variables: Record<string, string>
}
export type RTestCatalog = Record<string, RTestSpec>

export interface RRunResult {
  ok: boolean
  results: Record<string, unknown>
  error: string | null
  /** base64-encoded PNG images */
  plots: string[]
  timed_out: boolean
  duration_s: number
  test: string
  title: string
  variables: Record<string, string>
}

export interface UploadedData {
  columns: string[]
  numericCols: string[]
  rows: Record<string, unknown>[]
}

/** An error whose message is safe to show to the user. */
export class RApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------- Test names ----------

// The agent's wording sometimes differs from the backend's template names.
const ALIASES: Record<string, string> = {
  mann_whitney: 'mann_whitney_u',
  mannwhitney: 'mann_whitney_u',
  mann_whitney_u_test: 'mann_whitney_u',
  chi_squared: 'chi_square',
  chi_square_test: 'chi_square',
  shapiro: 'shapiro_wilk',
  shapiro_wilk_test: 'shapiro_wilk',
  dose_response: 'dose_response_4pl',
  four_parameter_logistic: 'dose_response_4pl',
  '4pl': 'dose_response_4pl',
  one_site_binding: 'michaelis_menten',
  enzyme_kinetics: 'michaelis_menten',
}

export function normalizeTestName(test: string): string {
  const key = test
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return ALIASES[key] ?? key
}

export async function fetchRTests(): Promise<RTestCatalog> {
  const res = await fetch(`${API_URL}/api/r/tests`)
  if (!res.ok) throw new RApiError(res.status, 'Could not load the list of R analyses')
  return (await res.json()) as RTestCatalog
}

// ---------- Uploaded data ----------

/** Reads the dataset that the Upload tab saved in localStorage. */
export function loadUploadedData(): UploadedData | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem('omnistat_data')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed?.columns) || !Array.isArray(parsed?.full_data)) return null
    return {
      columns: parsed.columns as string[],
      numericCols: Array.isArray(parsed.numeric_cols) ? (parsed.numeric_cols as string[]) : [],
      rows: parsed.full_data as Record<string, unknown>[],
    }
  } catch {
    return null
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/**
 * Pre-fills the column pickers. Step 1: a column named like the role itself
 * (role "group" -> column "group"). Step 2: the agent's variable names, matched
 * to real columns, fill the remaining roles in order. The user can always change them.
 */
export function guessColumns(
  roles: string[],
  intentVariables: string[],
  columns: string[]
): Record<string, string> {
  const mapping: Record<string, string> = {}
  const used = new Set<string>()

  for (const role of roles) {
    const hit = columns.find((c) => !used.has(c) && norm(c) === norm(role))
    if (hit) {
      mapping[role] = hit
      used.add(hit)
    }
  }

  const matched: string[] = []
  for (const v of intentVariables) {
    const nv = norm(v)
    if (!nv) continue
    const hit =
      columns.find((c) => !used.has(c) && norm(c) === nv) ??
      columns.find((c) => !used.has(c) && (norm(c).includes(nv) || nv.includes(norm(c))) && norm(c).length > 1)
    if (hit && !matched.includes(hit)) matched.push(hit)
  }

  for (const role of roles) {
    if (mapping[role]) continue
    const next = matched.find((c) => !used.has(c))
    if (next) {
      mapping[role] = next
      used.add(next)
    }
  }

  return mapping
}

/** Keep only the chosen columns, so the request stays small. */
export function trimRows(
  rows: Record<string, unknown>[],
  columns: string[]
): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const c of columns) out[c] = row[c]
    return out
  })
}

// ---------- Curve fits ----------

export const CURVE_FIT_TESTS = ['dose_response_4pl', 'michaelis_menten'] as const
export type CurveFitTest = (typeof CURVE_FIT_TESTS)[number]

export interface FitParameter {
  parameter: string
  estimate: number
  se: number
  lwr: number
  upr: number
}
export interface FitCurvePoint {
  x: number
  fit: number
  lwr: number
  upr: number
}
export interface FitDataPoint {
  x: number
  y: number
}
export interface FitResidual {
  x: number
  fitted: number
  residual: number
}

export interface CurveFit {
  model: CurveFitTest
  /** true when x should be drawn on a log axis (dose-response) */
  logX: boolean
  parameters: FitParameter[]
  curve: FitCurvePoint[]
  points: FitDataPoint[]
  residuals: FitResidual[]
  rSquared: number | null
  n: number | null
  dfResidual: number | null
  ec50: number | null
  ec50Ci: [number, number] | null
  hillSlope: number | null
  hillSlopeCi: [number, number] | null
  excludedZero: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function pair(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const a = num(v[0])
  const b = num(v[1])
  return a !== null && b !== null ? [a, b] : null
}
/** Returns the rows only if every row is an object whose listed keys are all finite numbers. */
function numericRows<T>(v: unknown, keys: string[]): T[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  for (const r of v) {
    if (!isRecord(r)) return null
    for (const k of keys) if (num(r[k]) === null) return null
  }
  return v as T[]
}

/** Parses a curve-fit run into typed data, or null so callers fall back to the generic view. */
export function asCurveFit(result: RRunResult): CurveFit | null {
  if (!result.ok || !(CURVE_FIT_TESTS as readonly string[]).includes(result.test)) return null
  const r = result.results
  const parameters = numericRows<FitParameter>(r.parameters, ['estimate', 'se', 'lwr', 'upr'])
  const curve = numericRows<FitCurvePoint>(r.curve, ['x', 'fit', 'lwr', 'upr'])
  const points = numericRows<FitDataPoint>(r.points, ['x', 'y'])
  const residuals = numericRows<FitResidual>(r.residuals, ['x', 'fitted', 'residual'])
  if (!parameters || !curve || !points || !residuals) return null
  return {
    model: result.test as CurveFitTest,
    logX: result.test === 'dose_response_4pl',
    parameters,
    curve,
    points,
    residuals,
    rSquared: num(r.r_squared),
    n: num(r.n),
    dfResidual: num(r.df_residual),
    ec50: num(r.ec50),
    ec50Ci: pair(r.ec50_ci_95),
    hillSlope: num(r.hill_slope),
    hillSlopeCi: pair(r.hill_slope_ci_95),
    excludedZero: num(r.excluded_zero_concentration_points) ?? 0,
  }
}

// ---------- Running a test ----------

function detailText(body: unknown): string | null {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail
    if (typeof d === 'string') return d
  }
  return null
}

export async function runRTest(
  test: string,
  variables: Record<string, string>,
  rows: Record<string, unknown>[]
): Promise<RRunResult> {
  const data = trimRows(rows, Array.from(new Set(Object.values(variables))))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 65_000)
  let res: Response
  try {
    // Same-origin call to our Next.js route, which adds the API key on the server.
    res = await fetch('/api/r/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test, variables, data }),
      signal: controller.signal,
    })
  } catch {
    throw new RApiError(0, 'Could not reach the analysis service. Check your connection and try again.')
  } finally {
    clearTimeout(timer)
  }

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // non-JSON body (e.g. a platform error page)
  }

  if (res.ok) return body as RRunResult

  const detail = detailText(body)
  switch (res.status) {
    case 413:
      throw new RApiError(413, 'This dataset is too large to analyse online. Try a smaller sample of rows.')
    case 422:
      throw new RApiError(422, detail ?? 'The request was not valid for this analysis.')
    case 429: {
      const wait = res.headers.get('Retry-After')
      throw new RApiError(429, `Too many requests. Please wait ${wait ? `${wait} seconds` : 'a moment'} and try again.`)
    }
    case 502:
    case 504:
      throw new RApiError(res.status, 'The analysis server is waking up. Please try again in a few seconds.')
    case 503:
      throw new RApiError(503, detail ?? 'The analysis service is busy. Please try again shortly.')
    default:
      throw new RApiError(res.status, 'The analysis service returned an unexpected error.')
  }
}

// ---------- Formatting ----------

const KEY_LABELS: Record<string, string> = {
  p_value: 'p-value',
  ci_95: '95% confidence interval',
  cohens_d: "Cohen's d",
  statistic_t: 't statistic',
  statistic_w: 'W statistic',
  statistic_chi2: 'Chi-square statistic',
  df: 'Degrees of freedom',
  eta_squared: 'Eta squared',
  cramers_v: "Cramér's V",
  r_squared: 'R²',
  spearman_rho: 'Spearman ρ',
  spearman_p_value: 'Spearman p-value',
  rank_biserial_r: 'Rank-biserial r',
  location_shift_ci_95: 'Location shift (95% CI)',
  fisher_exact_p: 'Fisher exact p-value',
  post_hoc_tukey: 'Post-hoc comparisons (Tukey HSD)',
  assumption_shapiro_p_by_group: 'Normality check by group (Shapiro p)',
  assumption_shapiro_p_residuals: 'Normality of residuals (Shapiro p)',
  assumption_fligner_p: 'Equal variances (Fligner p)',
  pct_expected_counts_below_5: '% of expected counts below 5',
  'normal_at_0.05': 'Normal at α = 0.05',
  ec50: 'EC50',
  ec50_ci_95: 'EC50 (95% CI)',
  hill_slope: 'Hill slope',
  hill_slope_ci_95: 'Hill slope (95% CI)',
  df_residual: 'Residual degrees of freedom',
  excluded_zero_concentration_points: 'Zero-concentration points excluded',
}

export function prettyKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key]
  const spaced = key.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** True for keys that hold p-values: p_value, spearman_p_value, fisher_exact_p, assumption_*_p_*, p_adj. */
export function isPKey(key: string): boolean {
  return /(^|_)p(_value|_adj)?($|_)/.test(key)
}

export function formatNumber(n: number, asP = false): string {
  if (!Number.isFinite(n)) return String(n)
  if (asP) return n < 0.001 ? '< 0.001' : n.toFixed(4)
  if (Number.isInteger(n)) return String(n)
  const abs = Math.abs(n)
  if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return n.toExponential(2)
  return String(Number(n.toPrecision(4)))
}