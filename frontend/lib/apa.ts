import { RRunResult } from './rApi'

/** APA 7 formatting for one statistic; italic marks APA statistic symbols. */
export interface ApaRun {
  text: string
  italic?: boolean
  superscript?: boolean
  subscript?: boolean
}

const MINUS = '\u2212'
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

class Missing extends Error {}

/** Fixed decimals with a true minus sign; `bounded` drops the leading zero for values that cannot exceed 1. */
export function apaNumber(value: number, decimals = 2, bounded = false): string {
  if (!Number.isFinite(value)) throw new Missing('non-finite')
  let text = Math.abs(value).toFixed(decimals)
  if (bounded) text = text.replace(/^0(?=\.)/, '')
  const rounded = Number(text)
  return value < 0 && rounded !== 0 ? `${MINUS}${text}` : text
}

/** APA p: exact to three decimals, "< .001" below that, no leading zero. */
export function apaP(p: number): ApaRun[] {
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new Missing('p')
  return p < 0.001 ? [{ text: 'p', italic: true }, { text: ' < .001' }] : [{ text: 'p', italic: true }, { text: ` = ${apaNumber(p, 3, true)}` }]
}

/** Degrees of freedom: integers as integers, Welch-type fractional df to two decimals. */
export function apaDf(df: number): string {
  if (!Number.isFinite(df)) throw new Missing('df')
  return Number.isInteger(df) ? String(df) : apaNumber(df)
}

function get(results: Record<string, unknown>, key: string): number {
  const v = results[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Missing(key)
  return v
}

function ci(results: Record<string, unknown>, key: string, bounded = false): ApaRun[] {
  const v = results[key]
  if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) throw new Missing(key)
  return [{ text: `, 95% CI [${apaNumber(v[0], 2, bounded)}, ${apaNumber(v[1], 2, bounded)}]` }]
}

const sym = (text: string): ApaRun => ({ text, italic: true })
const txt = (text: string): ApaRun => ({ text })
const sup = (text: string): ApaRun => ({ text, superscript: true })
const sub = (text: string): ApaRun => ({ text, subscript: true })

/** The APA-style inline statistics for a result, e.g. t(27.81) = −0.89, p = .382; null if unsupported or incomplete. */
export function apaStatement(result: RRunResult): ApaRun[] | null {
  if (!result.ok || !isRecord(result.results)) return null
  const r = result.results
  const p = () => [txt(', '), ...apaP(get(r, 'p_value'))]
  try {
    switch (result.test) {
      case 'independent_t_test':
        return [sym('t'), txt(`(${apaDf(get(r, 'df'))}) = ${apaNumber(get(r, 'statistic_t'))}`), ...p(),
          txt(', '), sym('M'), sub('diff'), txt(` = ${apaNumber(get(r, 'mean_difference'))}`), ...ci(r, 'ci_95'),
          txt(', '), sym('d'), txt(` = ${apaNumber(get(r, 'cohens_d'))}`)]
      case 'paired_t_test':
        return [sym('t'), txt(`(${apaDf(get(r, 'df'))}) = ${apaNumber(get(r, 'statistic_t'))}`), ...p(),
          txt(', '), sym('M'), sub('diff'), txt(` = ${apaNumber(get(r, 'mean_difference'))}`), ...ci(r, 'ci_95'),
          txt(', '), sym('d'), sub('z'), txt(` = ${apaNumber(get(r, 'cohens_dz'))}`)]
      case 'one_way_anova':
        return [sym('F'), txt(`(${apaDf(get(r, 'df_between'))}, ${apaDf(get(r, 'df_within'))}) = ${apaNumber(get(r, 'F'))}`), ...p(),
          txt(', η'), sup('2'), txt(` = ${apaNumber(get(r, 'eta_squared'), 2, true)}`)]
      case 'pearson_correlation':
        return [sym('r'), txt(` = ${apaNumber(get(r, 'r'), 2, true)}`), ...ci(r, 'ci_95', true), ...p(),
          txt(', '), sym('N'), txt(` = ${apaDf(get(r, 'n'))}`)]
      case 'shapiro_wilk':
        return [sym('W'), txt(` = ${apaNumber(get(r, 'W'), 2, true)}`), ...p(), txt(', '), sym('N'), txt(` = ${apaDf(get(r, 'n'))}`)]
      case 'mann_whitney_u':
        return [sym('W'), txt(` = ${apaNumber(get(r, 'statistic_W'))}`), ...p(),
          txt(', '), sym('r'), sub('rb'), txt(` = ${apaNumber(get(r, 'rank_biserial_r'), 2, true)}`)]
      case 'wilcoxon_signed_rank':
        return [sym('V'), txt(` = ${apaNumber(get(r, 'statistic_V'))}`), ...p(),
          txt(', '), sym('r'), sub('rb'), txt(` = ${apaNumber(get(r, 'rank_biserial_r'), 2, true)}`)]
      case 'kruskal_wallis':
        return [sym('H'), txt(`(${apaDf(get(r, 'df'))}) = ${apaNumber(get(r, 'statistic_H'))}`), ...p(),
          txt(', ε'), sup('2'), txt(` = ${apaNumber(get(r, 'epsilon_squared'), 2, true)}`)]
      case 'chi_square':
        return [sym('χ'), sup('2'), txt(`(${apaDf(get(r, 'df'))}) = ${apaNumber(get(r, 'statistic_chi2'))}`), ...p(),
          txt(', '), sym('V'), txt(` = ${apaNumber(get(r, 'cramers_v'), 2, true)}`)]
      case 'linear_regression':
        return [sym('F'), txt(`(${apaDf(get(r, 'df_model'))}, ${apaDf(get(r, 'df_residual'))}) = ${apaNumber(get(r, 'statistic_F'))}`), ...p(),
          txt(', '), sym('R'), sup('2'), txt(` = ${apaNumber(get(r, 'r_squared'), 2, true)}`),
          txt(', adjusted '), sym('R'), sup('2'), txt(` = ${apaNumber(get(r, 'adj_r_squared'), 2, true)}`)]
      case 'logistic_regression':
        return [sym('χ'), sup('2'), txt(`(${apaDf(get(r, 'df'))}) = ${apaNumber(get(r, 'statistic_chi2'))}`), ...p(),
          txt(', McFadden '), sym('R'), sup('2'), txt(` = ${apaNumber(get(r, 'mcfadden_r2'), 2, true)}`),
          txt(', AUC = '), txt(apaNumber(get(r, 'auc'), 2, true))]
      default:
        return null
    }
  } catch (e) {
    if (e instanceof Missing) return null
    throw e
  }
}

export interface ApaTable {
  title: string
  columns: string[]
  rows: string[][]
  note?: string
}

function tableRows(r: Record<string, unknown>, key: string): Record<string, unknown>[] | null {
  const rows = r[key]
  return Array.isArray(rows) && rows.length > 0 && rows.every(isRecord) ? rows : null
}

const cell = (v: unknown, decimals = 2, bounded = false): string =>
  typeof v === 'number' && Number.isFinite(v) ? (Number.isInteger(v) && decimals === 0 ? String(v) : apaNumber(v, decimals, bounded))
    : typeof v === 'string' ? v : '—'
const pCell = (v: unknown): string =>
  typeof v === 'number' && Number.isFinite(v) ? (v < 0.001 ? '< .001' : apaNumber(v, 3, true)) : '—'

function regressionCoefficientTable(r: Record<string, unknown>, test: string): ApaTable | null {
  const rows = tableRows(r, 'coefficients')
  if (!rows || rows.length < 2 || rows.filter((row) => row.term === '(Intercept)').length !== 1) return null
  const linear = test === 'linear_regression'
  const required = linear ? ['estimate', 'se', 'ci_lwr', 'ci_upr', 't', 'p_value'] : ['odds_ratio', 'or_lwr', 'or_upr', 'p_value']
  if (!rows.every((row) => typeof row.term === 'string' && row.term.length > 0 && required.every((key) =>
    typeof row[key] === 'number' && Number.isFinite(row[key]))) || !rows.every((row) => {
    const p = row.p_value as number
    return p >= 0 && p <= 1
  })) return null

  if (linear) {
    if (!rows.every((row) => (row.se as number) >= 0 && (row.ci_lwr as number) <= (row.ci_upr as number))) return null
    return {
      title: 'Regression Coefficients',
      columns: ['Term', 'b', 'SE', '95% CI', 't', 'p'],
      rows: rows.map((row) => [String(row.term), cell(row.estimate), cell(row.se),
        `[${cell(row.ci_lwr)}, ${cell(row.ci_upr)}]`, cell(row.t), pCell(row.p_value)]),
    }
  }

  if (!rows.every((row) => (row.odds_ratio as number) > 0 && (row.or_lwr as number) > 0 &&
    (row.or_lwr as number) <= (row.or_upr as number))) return null
  return {
    title: 'Logistic Regression Odds Ratios',
    columns: ['Term', 'OR', '95% CI', 'p'],
    rows: rows.map((row) => [String(row.term), cell(row.odds_ratio),
      `[${cell(row.or_lwr)}, ${cell(row.or_upr)}]`, pCell(row.p_value)]),
  }
}

/** APA tables for group summaries and post-hoc comparisons; values are rounded copies of the result fields. */
export function apaTables(result: RRunResult, valueLabels: Record<string, string> = {}): ApaTable[] {
  if (!result.ok || !isRecord(result.results)) return []
  const r = result.results
  const tables: ApaTable[] = []
  const label = (g: unknown) => (valueLabels[String(g)] ? `${String(g)} (${valueLabels[String(g)]})` : String(g))
  if (result.test === 'linear_regression' || result.test === 'logistic_regression') {
    const coefficients = regressionCoefficientTable(r, result.test)
    return coefficients ? [coefficients] : []
  }
  const groups = tableRows(r, 'groups')
  if (groups && 'mean' in groups[0]) {
    tables.push({ title: `Descriptive Statistics for ${result.variables.outcome ?? 'Outcome'} by Group`,
      columns: ['Group', 'n', 'M', 'SD'],
      rows: groups.map((g) => [label(g.group), cell(g.n, 0), cell(g.mean), cell(g.sd)]) })
  } else if (groups && 'median' in groups[0]) {
    tables.push({ title: `Descriptive Statistics for ${result.variables.outcome ?? 'Outcome'} by Group`,
      columns: ['Group', 'n', 'Mdn', 'Q1', 'Q3'],
      rows: groups.map((g) => [label(g.group), cell(g.n, 0), cell(g.median), cell(g.q1), cell(g.q3)]) })
  }
  const summary = tableRows(r, 'summary')
  if (summary && 'mean' in summary[0]) {
    tables.push({ title: 'Descriptive Statistics for Paired Measurements', columns: ['Measurement', 'n', 'M', 'SD'],
      rows: summary.map((s) => [cell(s.variable), cell(s.n, 0), cell(s.mean), cell(s.sd)]) })
  } else if (summary && 'median' in summary[0]) {
    tables.push({ title: 'Descriptive Statistics for Paired Measurements', columns: ['Measurement', 'n', 'Mdn', 'Q1', 'Q3'],
      rows: summary.map((s) => [cell(s.variable), cell(s.n, 0), cell(s.median), cell(s.q1), cell(s.q3)]) })
  }
  const tukey = tableRows(r, 'post_hoc_tukey')
  if (tukey) {
    tables.push({ title: 'Tukey HSD Pairwise Comparisons', columns: ['Comparison', 'Mdiff', '95% CI', 'padj'],
      rows: tukey.map((t) => [cell(t.comparison), cell(t.diff), `[${cell(t.lwr)}, ${cell(t.upr)}]`, pCell(t.p_adj)]),
      note: 'Differences are the first group minus the second. p values are Tukey-adjusted.' })
  }
  const pairwise = tableRows(r, 'post_hoc_pairwise')
  if (pairwise) {
    tables.push({ title: 'Pairwise Wilcoxon Comparisons', columns: ['Comparison', 'padj'],
      rows: pairwise.map((t) => [cell(t.comparison), pCell(t.p_adj)]), note: 'p values are Holm-adjusted.' })
  }
  const observed = tableRows(r, 'observed')
  if (observed) {
    const cols = Object.keys(observed[0])
    tables.push({ title: 'Observed Counts', columns: cols.map((c) => (c === 'count' ? 'n' : c)),
      rows: observed.map((o) => cols.map((c) => cell(o[c], 0))) })
  }
  return tables
}
