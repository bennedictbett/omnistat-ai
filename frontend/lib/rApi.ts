import { requestJson } from '@/lib/api'

// ---------- Types ----------

/** One entry of GET /api/r/tests: what a test is called and which columns it needs. */
export interface RTestSpec {
  title: string
  /** role -> human description, e.g. { outcome: "numeric outcome column" } */
  variables: Record<string, string>
  /** roles the user may leave out (e.g. extra regression predictors) */
  optional?: string[]
}
export type RTestCatalog = Record<string, RTestSpec>

export const REVIEWED_PROCEDURES = [
  'independent_t_test', 'paired_t_test', 'one_way_anova', 'pearson_correlation', 'shapiro_wilk',
] as const

export interface AnalysisPlan {
  schema_version: '1.0'
  procedure: (typeof REVIEWED_PROCEDURES)[number]
  engine: 'r'
  title: string
  variables: Record<string, string>
  data_sha256: string
  rows_total: number
  rows_used: number
  rows_dropped_missing: number
  group_counts: Record<string, number>
  alternative: 'two.sided' | null
  confidence_level: 0.95 | null
  equal_variances: boolean | null
  missing_data_policy: 'complete_cases'
  assumptions: string[]
  outputs: string[]
}

function isAnalysisPlan(value: unknown): value is AnalysisPlan {
  return isRecord(value) && value.schema_version === '1.0' &&
    REVIEWED_PROCEDURES.some((test) => test === value.procedure) && value.engine === 'r' &&
    typeof value.title === 'string' && isRecord(value.variables) &&
    Object.values(value.variables).every((v) => typeof v === 'string') &&
    typeof value.data_sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.data_sha256) &&
    ['rows_total', 'rows_used', 'rows_dropped_missing'].every((key) =>
      typeof value[key] === 'number' && Number.isInteger(value[key]) && value[key] >= 0) &&
    isRecord(value.group_counts) && Object.values(value.group_counts).every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 2) &&
    (value.alternative === 'two.sided' || value.alternative === null) &&
    (value.confidence_level === 0.95 || value.confidence_level === null) &&
    (typeof value.equal_variances === 'boolean' || value.equal_variances === null) &&
    value.missing_data_policy === 'complete_cases' &&
    Array.isArray(value.assumptions) && value.assumptions.every((v) => typeof v === 'string') &&
    Array.isArray(value.outputs) && value.outputs.every((v) => typeof v === 'string')
}

export async function prepareRPlan(
  test: string, variables: Record<string, string>, rows: Record<string, unknown>[]
): Promise<AnalysisPlan> {
  let response: Response
  try {
    response = await fetch('/api/r/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test, variables, data: trimRows(rows, Object.values(variables)) }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new RApiError(0, 'Could not prepare the analysis plan. Check your connection and try again.')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new RApiError(502, 'The server returned an unreadable analysis plan.')
  }
  if (!response.ok) throw new RApiError(response.status, detailText(body) ?? 'Could not prepare the analysis plan.')
  if (!isAnalysisPlan(body)) throw new RApiError(502, 'The server returned an invalid analysis plan.')
  return body
}

export interface AssumptionCheck {
  id: string
  label: string
  status: 'ok' | 'warning' | 'info' | 'not_assessed'
  detail: string
  n?: number | null
  statistic?: number | null
  p_value?: number | null
}

export interface AssumptionReport {
  procedure: string
  variables: Record<string, string>
  data_sha256: string
  alpha: number
  checks: AssumptionCheck[]
  suggestion: { test: string | null; title: string; reason: string } | null
  notes: string[]
}

const CHECK_STATUSES = ['ok', 'warning', 'info', 'not_assessed']

function isAssumptionReport(value: unknown): value is AssumptionReport {
  const s = isRecord(value) ? value.suggestion : undefined
  return isRecord(value) && typeof value.procedure === 'string' && typeof value.data_sha256 === 'string' &&
    isRecord(value.variables) && Object.values(value.variables).every((v) => typeof v === 'string') &&
    typeof value.alpha === 'number' &&
    Array.isArray(value.checks) && value.checks.every((c) => isRecord(c) && typeof c.id === 'string' &&
      typeof c.label === 'string' && typeof c.detail === 'string' && CHECK_STATUSES.includes(c.status as string)) &&
    (s === null || (isRecord(s) && (s.test === null || typeof s.test === 'string') &&
      typeof s.title === 'string' && typeof s.reason === 'string')) &&
    Array.isArray(value.notes) && value.notes.every((n) => typeof n === 'string')
}

/** Read-only diagnostics for a reviewed plan; rejects reports that do not describe the same data and columns. */
export async function fetchAssumptionChecks(
  plan: AnalysisPlan, rows: Record<string, unknown>[],
): Promise<AssumptionReport> {
  let response: Response
  try {
    response = await fetch('/api/r/checks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: plan.procedure, variables: plan.variables, data: trimRows(rows, Object.values(plan.variables)) }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new RApiError(0, 'Could not run assumption checks. Check your connection.')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new RApiError(502, 'The server returned unreadable assumption checks.')
  }
  if (!response.ok) throw new RApiError(response.status, detailText(body) ?? 'Could not run assumption checks.')
  if (!isAssumptionReport(body)) throw new RApiError(502, 'The server returned invalid assumption checks.')
  if (body.procedure !== plan.procedure || body.data_sha256 !== plan.data_sha256 ||
    JSON.stringify(body.variables) !== JSON.stringify(plan.variables)) {
    throw new RApiError(409, 'The assumption checks do not match this plan. Review the plan again.')
  }
  return body
}

export interface RRunResult {
  analysis_plan?: AnalysisPlan
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
    /** standalone R script that reproduces the run (reads data.csv, then runs the analysis) */
  code?: string
  r_version?: string | null
  /** SHA-256 of the CSV sent to R: a fingerprint of the exact data used */
  data_sha256?: string
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
  paired_t: 'paired_t_test',
  paired_samples_t_test: 'paired_t_test',
  wilcoxon: 'wilcoxon_signed_rank',
  wilcoxon_signed_rank_test: 'wilcoxon_signed_rank',
  wilcoxon_rank_sum: 'mann_whitney_u',
  kruskal: 'kruskal_wallis',
  kruskal_wallis_test: 'kruskal_wallis',
  ols: 'linear_regression',
  multiple_regression: 'linear_regression',
  linear_model: 'linear_regression',
  logistic: 'logistic_regression',
  logit: 'logistic_regression',
}

export function normalizeTestName(test: string): string {
  const key = test
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return ALIASES[key] ?? key
}

export async function fetchRTests(): Promise<RTestCatalog> {
  const data = await requestJson<unknown>('/api/r/tests')
  if (!isRecord(data) || !Object.values(data).every((spec) =>
    isRecord(spec) && typeof spec.title === 'string' && isRecord(spec.variables) &&
    Object.values(spec.variables).every((v) => typeof v === 'string') &&
    (spec.optional === undefined || (Array.isArray(spec.optional) && spec.optional.every((v) => typeof v === 'string')))
  )) {
    throw new RApiError(502, 'The server returned an invalid list of analyses. No analysis was run.')
  }
  return data as RTestCatalog
}

// ---------- Uploaded data ----------

/** Reads the dataset that the Upload tab saved in localStorage. */
export function loadUploadedData(): UploadedData | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem('omnistat_data')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (
      !Array.isArray(parsed?.columns) || !parsed.columns.every((c: unknown) => typeof c === 'string') ||
      !Array.isArray(parsed?.full_data) || !parsed.full_data.every(isRecord) ||
      !Array.isArray(parsed?.numeric_cols) || !parsed.numeric_cols.every((c: unknown) => typeof c === 'string')
    ) {
      throw new RApiError(0, 'Saved dataset is invalid. Upload your CSV or Excel file again.')
    }
    return {
      columns: parsed.columns as string[],
      numericCols: Array.isArray(parsed.numeric_cols) ? (parsed.numeric_cols as string[]) : [],
      rows: parsed.full_data as Record<string, unknown>[],
    }
  } catch (e) {
    if (e instanceof RApiError) throw e
    throw new RApiError(0, 'Could not read the saved dataset. Check browser storage and upload your file again.')
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

function isRRunResult(body: unknown): body is RRunResult {
  return isRecord(body) && typeof body.ok === 'boolean' && isRecord(body.results) &&
    Array.isArray(body.plots) && body.plots.every((plot) => typeof plot === 'string') &&
    (body.error === null || typeof body.error === 'string') &&
    typeof body.test === 'string' && typeof body.title === 'string' &&
    isRecord(body.variables) && Object.values(body.variables).every((v) => typeof v === 'string') &&
    typeof body.timed_out === 'boolean' && typeof body.duration_s === 'number' &&
    (body.code === undefined || typeof body.code === 'string') &&
    (body.r_version === undefined || body.r_version === null || typeof body.r_version === 'string') &&
    (body.data_sha256 === undefined || typeof body.data_sha256 === 'string') &&
    (body.analysis_plan === undefined || isAnalysisPlan(body.analysis_plan))
}

export async function runRTest(
  test: string,
  variables: Record<string, string>,
  rows: Record<string, unknown>[],
  analysisPlan?: AnalysisPlan
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
      body: JSON.stringify({ test, variables, data, ...(analysisPlan ? { analysis_plan: analysisPlan } : {}) }),
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

  if (res.ok) {
    if (!isRRunResult(body)) {
      throw new RApiError(502, 'The analysis service returned an invalid result. Please try again.')
    }
    if (analysisPlan && (
      !body.analysis_plan || body.data_sha256 !== analysisPlan.data_sha256 ||
      JSON.stringify(body.analysis_plan) !== JSON.stringify(analysisPlan)
    )) {
      throw new RApiError(502, 'The result does not match the reviewed analysis plan. Review a new plan before running again.')
    }
    return body
  }

  const detail = detailText(body)
  switch (res.status) {
    case 413:
      throw new RApiError(413, 'This dataset is too large to analyse online. Try a smaller sample of rows.')
    case 422:
      throw new RApiError(422, detail ?? 'The request was not valid for this analysis.')
    case 409:
      throw new RApiError(409, detail ?? 'The plan changed. Review it again before running.')
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
    statistic_V: 'V statistic',
  statistic_H: 'H statistic',
  statistic_W: 'W statistic',
  epsilon_squared: 'Epsilon squared',
  cohens_dz: "Cohen's dz",
  n_pairs: 'Number of pairs',
  n_zero_differences: 'Pairs with zero difference',
  median_difference: 'Median difference',
  hodges_lehmann_shift: 'Hodges-Lehmann shift',
  shift_ci_95: 'Shift (95% CI)',
  assumption_shapiro_p_differences: 'Normality of differences (Shapiro p)',
  post_hoc_pairwise: 'Post-hoc: pairwise Wilcoxon (Holm-adjusted)',
  term: 'Term',
  estimate: 'Estimate',
  se: 'Std. error',
  t: 't',
  ci_lwr: '95% CI low',
  ci_upr: '95% CI high',
  se_hc3: 'Robust SE (HC3)',
  p_hc3: 'Robust p (HC3)',
  odds_ratio: 'Odds ratio',
  or_lwr: 'OR 95% CI low',
  or_upr: 'OR 95% CI high',
  estimate_log_odds: 'Log-odds',
  vif: 'VIF',
  statistic_F: 'F statistic',
  df_model: 'Model degrees of freedom',
  adj_r_squared: 'Adjusted R²',
  rmse: 'RMSE',
  n_used: 'Rows used',
  n_dropped_missing: 'Rows dropped (missing values)',
  n_events: 'Events',
  events_per_parameter: 'Events per parameter (aim for 10+)',
  mcfadden_r2: 'McFadden R²',
  aic: 'AIC',
  auc: 'AUC',
  'sensitivity_at_0.5': 'Sensitivity (0.5 cutoff)',
  'specificity_at_0.5': 'Specificity (0.5 cutoff)',
  event: 'Event level',
  reference: 'Reference level',
  assumption_breusch_pagan_p: 'Equal residual variance (Breusch-Pagan p)',
  assumption_hosmer_lemeshow_p: 'Calibration (Hosmer-Lemeshow p)',
  n_high_influence: "Highly influential rows (Cook's D > 4/n)",
  model_warnings: 'Model warnings',
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