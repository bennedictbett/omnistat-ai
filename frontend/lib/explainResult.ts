import { formatNumber, RRunResult } from './rApi'

/** A number (or fixed method constant) with the result field or method setting it came from. */
export interface ExplanationValue {
  text: string
  source: string
}
export type ExplanationPart = string | ExplanationValue
export interface Explanation {
  paragraphs: ExplanationPart[][]
  caveats: ExplanationPart[][]
}

class Missing extends Error {}

const ALPHA = 0.05
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Builds sentences whose numbers are all read from the result, so none can be invented. */
class Builder {
  constructor(private results: Record<string, unknown>, private valueLabels: Record<string, string>) {}

  raw(path: string): number {
    let current: unknown = this.results
    for (const part of path.split(/\.|\[(\d+)\]/).filter(Boolean)) {
      current = Array.isArray(current) ? current[Number(part)] : isRecord(current) ? current[part] : undefined
    }
    if (typeof current !== 'number' || !Number.isFinite(current)) throw new Missing(path)
    return current
  }

  optional(path: string): number | null {
    try {
      return this.raw(path)
    } catch {
      return null
    }
  }

  num(path: string): ExplanationValue {
    return { text: formatNumber(this.raw(path)), source: `results.${path}` }
  }

  p(path: string): ExplanationValue {
    const p = this.raw(path)
    return { text: p < 0.001 ? '< 0.001' : `= ${formatNumber(p, true)}`, source: `results.${path}` }
  }

  /** p-value stored under a user-supplied key (e.g. a group name), which may contain path characters. */
  pIn(key: string, name: string): ExplanationValue | null {
    const holder = this.results[key]
    const p = isRecord(holder) ? holder[name] : undefined
    if (typeof p !== 'number' || !Number.isFinite(p)) return null
    return { text: p < 0.001 ? '< 0.001' : `= ${formatNumber(p, true)}`, source: `results.${key}["${name}"]` }
  }

  ci(path: string): ExplanationPart[] {
    this.raw(`${path}[0]`)
    this.raw(`${path}[1]`)
    return [constant('95%'), ' CI ', this.num(`${path}[0]`), ' to ', this.num(`${path}[1]`)]
  }

  ciFields(lowerPath: string, upperPath: string): ExplanationPart[] {
    if (this.raw(lowerPath) > this.raw(upperPath)) throw new Missing(lowerPath)
    return [constant('95%'), ' CI ', this.num(lowerPath), ' to ', this.num(upperPath)]
  }

  records(key: string): Record<string, unknown>[] {
    const rows = this.results[key]
    if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isRecord)) throw new Missing(key)
    return rows
  }

  rows(key: string, columns: string[]): Record<string, unknown>[] {
    const rows = this.records(key)
    rows.forEach((_, i) => columns.forEach((c) => this.raw(`${key}[${i}].${c}`)))
    if (!rows.every((r) => typeof r.group === 'string' || typeof r.variable === 'string' || typeof r.comparison === 'string')) {
      throw new Missing(key)
    }
    return rows
  }

  group(name: unknown): string {
    const label = this.valueLabels[String(name)]
    return label ? `“${String(name)}” (${label})` : `“${String(name)}”`
  }
}

const constant = (text: string): ExplanationValue => ({ text, source: 'method setting' })
const alpha = () => constant('0.05')

function significance(b: Builder, path: string): boolean {
  return b.raw(path) < ALPHA
}

function probability(b: Builder, path: string): number {
  const value = b.raw(path)
  if (value < 0 || value > 1) throw new Missing(path)
  return value
}

function wholeNumber(b: Builder, path: string, minimum: number): number {
  const value = b.raw(path)
  if (!Number.isInteger(value) || value < minimum) throw new Missing(path)
  return value
}

function coefficientRows(b: Builder, key: string, fields: string[]): Record<string, unknown>[] {
  const rows = b.records(key)
  const terms = new Set<string>()
  let intercepts = 0
  rows.forEach((row, i) => {
    if (typeof row.term !== 'string' || row.term.length === 0 || terms.has(row.term)) throw new Missing(`${key}[${i}].term`)
    terms.add(row.term)
    if (row.term === '(Intercept)') intercepts++
    fields.forEach((field) => b.raw(`${key}[${i}].${field}`))
  })
  if (intercepts !== 1 || rows.length < 2) throw new Missing(key)
  return rows
}

function coefficientPredictor(term: string, variables: Record<string, string>): { predictor: string; level: string | null } {
  const predictors = Object.entries(variables)
    .filter(([role]) => /^predictor_\d+$/.test(role))
    .map(([, name]) => name)
    .sort((a, b) => b.length - a.length)
  const exact = predictors.find((name) => name === term)
  if (exact) return { predictor: exact, level: null }
  const categorical = predictors.find((name) => term.startsWith(name) && term.length > name.length)
  return categorical ? { predictor: categorical, level: term.slice(categorical.length) } : { predictor: term, level: null }
}

function nullableProbability(result: RRunResult, b: Builder, path: string): number | null {
  const value = result.results[path]
  if (value === undefined || value === null) return null
  return probability(b, path)
}

function magnitude(value: number, cuts: [number, number, number]): string {
  const v = Math.abs(value)
  return v < cuts[0] ? 'negligible' : v < cuts[1] ? 'small' : v < cuts[2] ? 'medium' : 'large'
}

const NOT_EQUAL = 'This does not show that there is no difference; the confidence interval shows the range of values compatible with the data.'
const GENERAL = 'Statistical significance does not by itself establish clinical importance or causation.'

export function explainResult(
  result: RRunResult, valueLabels: Record<string, Record<string, string>> = {},
): Explanation | null {
  if (!result.ok || !isRecord(result.results)) return null
  const v = result.variables
  const groupLabels = valueLabels[v.group ?? v.var1 ?? ''] ?? {}
  const b = new Builder(result.results, groupLabels)
  const paragraphs: ExplanationPart[][] = []
  const caveats: ExplanationPart[][] = []
  try {
    switch (result.test) {
      case 'independent_t_test': {
        const g = b.rows('groups', ['n', 'mean', 'sd'])
        if (g.length !== 2) return null
        const sig = significance(b, 'p_value')
        const d = b.raw('cohens_d')
        paragraphs.push([
          `Mean ${v.outcome} was `, b.num('groups[0].mean'), ' (SD ', b.num('groups[0].sd'), ', n = ', b.num('groups[0].n'),
          `) in group ${b.group(g[0].group)} and `, b.num('groups[1].mean'), ' (SD ', b.num('groups[1].sd'), ', n = ',
          b.num('groups[1].n'), `) in group ${b.group(g[1].group)}.`,
        ])
        paragraphs.push([
          `The difference (${b.group(g[0].group)} minus ${b.group(g[1].group)}) was `, b.num('mean_difference'),
          ' (', ...b.ci('ci_95'), `). Welch's t-test ${sig ? 'found' : 'did not find'} a statistically significant difference at the `,
          alpha(), ' level (t = ', b.num('statistic_t'), ', df = ', b.num('df'), ', p ', b.p('p_value'), ').',
          sig ? '' : ` ${NOT_EQUAL}`,
        ])
        paragraphs.push([`Cohen's d was `, b.num('cohens_d'), `, a ${magnitude(d, [0.2, 0.5, 0.8])} standardized difference by conventional benchmarks.`])
        const sw = result.results.assumption_shapiro_p_by_group
        if (isRecord(sw)) {
          for (const [group, p] of Object.entries(sw)) {
            const token = b.pIn('assumption_shapiro_p_by_group', group)
            if (token && typeof p === 'number' && p < ALPHA) {
              caveats.push([`Values in group ${b.group(group)} may not be normally distributed (Shapiro-Wilk p `,
                token, '); with small groups, consider the Mann-Whitney U test.'])
            }
          }
        }
        break
      }
      case 'paired_t_test': {
        b.rows('summary', ['n', 'mean', 'sd'])
        const sig = significance(b, 'p_value')
        paragraphs.push([
          'Across ', b.num('n_pairs'), ` pairs, mean ${v.first} was `, b.num('summary[0].mean'), ` and mean ${v.second} was `,
          b.num('summary[1].mean'), `. The mean paired difference (${v.first} minus ${v.second}) was `, b.num('mean_difference'),
          ' (', ...b.ci('ci_95'), ').',
        ])
        paragraphs.push([
          `The paired t-test ${sig ? 'found' : 'did not find'} a statistically significant difference at the `, alpha(),
          ' level (t = ', b.num('statistic_t'), ', df = ', b.num('df'), ', p ', b.p('p_value'), `). Cohen's dz was `,
          b.num('cohens_dz'), `, a ${magnitude(b.raw('cohens_dz'), [0.2, 0.5, 0.8])} standardized difference by conventional benchmarks.`,
          sig ? '' : ` ${NOT_EQUAL}`,
        ])
        const sw = b.optional('assumption_shapiro_p_differences')
        if (sw !== null && sw < ALPHA) {
          caveats.push(['Paired differences may not be normally distributed (Shapiro-Wilk p ', b.p('assumption_shapiro_p_differences'),
            '); with few pairs, consider the Wilcoxon signed-rank test.'])
        }
        break
      }
      case 'one_way_anova': {
        const g = b.rows('groups', ['n', 'mean'])
        const sig = significance(b, 'p_value')
        paragraphs.push([`Mean ${v.outcome} by group: `, ...g.flatMap((row, i) => [
          i ? '; ' : '', `${b.group(row.group)} `, b.num(`groups[${i}].mean`), ' (n = ', b.num(`groups[${i}].n`), ')',
        ]), '.'])
        paragraphs.push([
          `One-way ANOVA ${sig ? 'found' : 'did not find'} statistically significant evidence that mean ${v.outcome} differs across groups at the `,
          alpha(), ' level (F(', b.num('df_between'), ', ', b.num('df_within'), ') = ', b.num('F'), ', p ', b.p('p_value'),
          '). Eta squared was ', b.num('eta_squared'), `, a ${magnitude(b.raw('eta_squared'), [0.01, 0.06, 0.14])} effect by conventional benchmarks.`,
        ])
        const tukey = b.rows('post_hoc_tukey', ['diff', 'lwr', 'upr', 'p_adj'])
        const pairs = tukey.map((row, i) => ({ row, i })).filter(({ i }) => b.raw(`post_hoc_tukey[${i}].p_adj`) < ALPHA)
        if (pairs.length) {
          paragraphs.push(['Tukey-adjusted comparisons with p < ', alpha(), ': ', ...pairs.flatMap(({ row, i }, k) => [
            k ? '; ' : '', `${String(row.comparison)} difference `, b.num(`post_hoc_tukey[${i}].diff`),
            ' (', constant('95%'), ' CI ', b.num(`post_hoc_tukey[${i}].lwr`), ' to ', b.num(`post_hoc_tukey[${i}].upr`),
            ', adjusted p ', b.p(`post_hoc_tukey[${i}].p_adj`), ')',
          ]), '. Each comparison is the first group minus the second.'])
        } else if (sig) {
          paragraphs.push(['No individual Tukey-adjusted comparison reached p < ', alpha(), ', so the overall difference cannot be attributed to a specific pair.'])
        }
        const fl = b.optional('assumption_fligner_p')
        if (fl !== null && fl < ALPHA) caveats.push(['Group variances may differ (Fligner-Killeen p ', b.p('assumption_fligner_p'), '), which standard ANOVA and Tukey assume they do not.'])
        const sw = b.optional('assumption_shapiro_p_residuals')
        if (sw !== null && sw < ALPHA) caveats.push(['Residuals may not be normally distributed (Shapiro-Wilk p ', b.p('assumption_shapiro_p_residuals'), '); with small groups, consider the Kruskal-Wallis test.'])
        if (!sig) caveats.push(['This does not show that the group means are equal; the Tukey intervals show the range of differences compatible with the data.'])
        break
      }
      case 'pearson_correlation': {
        const r = b.raw('r')
        const sig = significance(b, 'p_value')
        paragraphs.push([
          `Pearson's r between ${v.x} and ${v.y} was `, b.num('r'), ' (', ...b.ci('ci_95'), ', n = ', b.num('n'),
          `), a ${magnitude(r, [0.1, 0.3, 0.5])}${r > 0 ? ' positive' : r < 0 ? ' negative' : ''} linear association by conventional benchmarks. `,
          `The association ${sig ? 'was' : 'was not'} statistically significant at the `, alpha(), ' level (p ', b.p('p_value'), ').',
        ])
        paragraphs.push(["Spearman's rank correlation was ", b.num('spearman_rho'), ' (p ', b.p('spearman_p_value'), '), for comparison.'])
        caveats.push(['Correlation does not imply causation, and Pearson’s r only measures linear association; check the scatter plot.'])
        break
      }
      case 'shapiro_wilk': {
        const sig = significance(b, 'p_value')
        paragraphs.push([
          `The Shapiro-Wilk test for ${v.variable} gave W = `, b.num('W'), ', p ', b.p('p_value'), ' (n = ', b.num('n'), '). ',
          sig ? 'This is evidence that the values are not normally distributed.'
            : 'There is no clear evidence of non-normality, but this does not prove the values are normally distributed.',
        ])
        caveats.push(['With large samples, small departures from normality are flagged; with small samples, real departures can be missed. Inspect the Q-Q plot.'])
        break
      }
      case 'mann_whitney_u': {
        const g = b.rows('groups', ['n', 'median', 'q1', 'q3'])
        if (g.length !== 2) return null
        const sig = significance(b, 'p_value')
        paragraphs.push([`Median ${v.outcome} was `, ...g.flatMap((row, i) => [
          i ? ' and ' : '', b.num(`groups[${i}].median`), ' (IQR ', b.num(`groups[${i}].q1`), ' to ', b.num(`groups[${i}].q3`),
          ', n = ', b.num(`groups[${i}].n`), `) in group ${b.group(row.group)}`,
        ]), '.'])
        paragraphs.push([
          `The Mann-Whitney U test ${sig ? 'found' : 'did not find'} a statistically significant difference in distributions at the `,
          alpha(), ' level (W = ', b.num('statistic_W'), ', p ', b.p('p_value'), '). The rank-biserial correlation was ',
          b.num('rank_biserial_r'), `, a ${magnitude(b.raw('rank_biserial_r'), [0.1, 0.3, 0.5])} effect by conventional benchmarks. `,
          `The estimated location shift (${b.group(g[0].group)} minus ${b.group(g[1].group)}) has `, ...b.ci('location_shift_ci_95'), '.',
        ])
        break
      }
      case 'wilcoxon_signed_rank': {
        b.rows('summary', ['median'])
        const sig = significance(b, 'p_value')
        paragraphs.push([
          'Across ', b.num('n_pairs'), ` pairs, median ${v.first} was `, b.num('summary[0].median'), ` and median ${v.second} was `,
          b.num('summary[1].median'), `. The median difference (${v.first} minus ${v.second}) was `, b.num('median_difference'),
          '; the Hodges-Lehmann estimated shift was ', b.num('hodges_lehmann_shift'), ' (', ...b.ci('shift_ci_95'), ').',
        ])
        paragraphs.push([
          `The Wilcoxon signed-rank test ${sig ? 'found' : 'did not find'} a statistically significant difference at the `, alpha(),
          ' level (V = ', b.num('statistic_V'), ', p ', b.p('p_value'), '). The rank-biserial correlation was ', b.num('rank_biserial_r'),
          `, a ${magnitude(b.raw('rank_biserial_r'), [0.1, 0.3, 0.5])} effect by conventional benchmarks.`,
        ])
        if (b.raw('n_zero_differences') > 0) caveats.push([b.num('n_zero_differences'), ' pair(s) had zero difference and were excluded from the ranks.'])
        break
      }
      case 'kruskal_wallis': {
        const g = b.rows('groups', ['n', 'median'])
        const sig = significance(b, 'p_value')
        paragraphs.push([`Median ${v.outcome} by group: `, ...g.flatMap((row, i) => [
          i ? '; ' : '', `${b.group(row.group)} `, b.num(`groups[${i}].median`), ' (n = ', b.num(`groups[${i}].n`), ')',
        ]), '.'])
        paragraphs.push([
          `The Kruskal-Wallis test ${sig ? 'found' : 'did not find'} statistically significant evidence that distributions differ across groups at the `,
          alpha(), ' level (H = ', b.num('statistic_H'), ', df = ', b.num('df'), ', p ', b.p('p_value'), '). Epsilon squared was ',
          b.num('epsilon_squared'), `, a ${magnitude(b.raw('epsilon_squared'), [0.01, 0.06, 0.14])} effect by conventional benchmarks.`,
        ])
        const posthoc = result.results.post_hoc_pairwise
        if (Array.isArray(posthoc)) {
          const hits = posthoc.map((row, i) => ({ row, i })).filter(({ i }) => (b.optional(`post_hoc_pairwise[${i}].p_adj`) ?? 1) < ALPHA)
          if (hits.length) {
            paragraphs.push(['Holm-adjusted pairwise comparisons with p < ', alpha(), ': ', ...hits.flatMap(({ row, i }, k) => [
              k ? '; ' : '', `${String((row as Record<string, unknown>).comparison)} (adjusted p `, b.p(`post_hoc_pairwise[${i}].p_adj`), ')',
            ]), '.'])
          }
        }
        break
      }
      case 'chi_square': {
        const sig = significance(b, 'p_value')
        paragraphs.push([
          `The chi-square test ${sig ? 'found' : 'did not find'} a statistically significant association between ${v.var1} and ${v.var2} at the `,
          alpha(), ' level (χ² = ', b.num('statistic_chi2'), ', df = ', b.num('df'), ', p ', b.p('p_value'), "). Cramér's V was ",
          b.num('cramers_v'), `, a ${magnitude(b.raw('cramers_v'), [0.1, 0.3, 0.5])} association by conventional benchmarks.`,
        ])
        if (b.raw('pct_expected_counts_below_5') > 20) {
          const fisher: ExplanationPart[] = b.optional('fisher_exact_p') !== null ? [" Fisher's exact test gave p ", b.p('fisher_exact_p'), '.'] : []
          caveats.push([b.num('pct_expected_counts_below_5'), '% of expected counts are below 5, so the chi-square approximation may be unreliable.', ...fisher])
        }
        break
      }
      case 'linear_regression': {
        wholeNumber(b, 'n_used', 1)
        wholeNumber(b, 'n_dropped_missing', 0)
        if (b.raw('df_model') <= 0 || b.raw('df_residual') <= 0 || b.raw('statistic_F') < 0) throw new Missing('model statistics')
        probability(b, 'p_value')
        if (b.raw('r_squared') < 0 || b.raw('r_squared') > 1) throw new Missing('r_squared')
        probability(b, 'assumption_breusch_pagan_p')
        wholeNumber(b, 'n_high_influence', 0)
        const coefficients = coefficientRows(b, 'coefficients', ['estimate', 'ci_lwr', 'ci_upr', 'p_value'])
        coefficients.forEach((_, i) => {
          if (b.raw(`coefficients[${i}].ci_lwr`) > b.raw(`coefficients[${i}].ci_upr`)) throw new Missing(`coefficients[${i}]`)
          probability(b, `coefficients[${i}].p_value`)
        })
        const shapiro = nullableProbability(result, b, 'assumption_shapiro_p_residuals')
        const vifValue = result.results.vif
        let vif: Record<string, unknown>[] = []
        if (vifValue !== undefined && vifValue !== null) {
          if (!Array.isArray(vifValue) || !vifValue.every(isRecord)) throw new Missing('vif')
          vif = vifValue
          vif.forEach((row, i) => {
            if (typeof row.term !== 'string' || b.raw(`vif[${i}].vif`) < 1) throw new Missing(`vif[${i}]`)
          })
        }
        const sig = significance(b, 'p_value')
        paragraphs.push([
          `The linear regression model ${sig ? 'found' : 'did not find'} a statistically significant association at the `, alpha(),
          ' level (F(', b.num('df_model'), ', ', b.num('df_residual'), ') = ', b.num('statistic_F'), ', p ', b.p('p_value'),
          '). R² was ', b.num('r_squared'), ' and adjusted R² was ', b.num('adj_r_squared'), '. It used ', b.num('n_used'),
          ' observations and excluded ', b.num('n_dropped_missing'), ' for missing values.',
        ])
        coefficients.forEach((row, i) => {
          if (row.term === '(Intercept)') return
          const term = String(row.term)
          const { predictor, level } = coefficientPredictor(term, v)
          const label = level === null ? predictor : (valueLabels[predictor]?.[level] ?? level)
          paragraphs.push([
            level === null ? `Each unit increase in ${predictor} was associated with a change of `
              : `Compared with the reference level of ${predictor}, ${label} was associated with a change of `,
            b.num(`coefficients[${i}].estimate`), ` in ${v.outcome}, holding other predictors constant (`,
            ...b.ciFields(`coefficients[${i}].ci_lwr`, `coefficients[${i}].ci_upr`), ', p ',
            b.p(`coefficients[${i}].p_value`), ').',
          ])
        })
        if (shapiro !== null && shapiro < ALPHA) {
          caveats.push(['Residuals may not be normally distributed (Shapiro-Wilk p ', b.p('assumption_shapiro_p_residuals'), ').'])
        }
        if (b.raw('assumption_breusch_pagan_p') < ALPHA) {
          caveats.push(['Residual variance may not be constant (Breusch-Pagan p ', b.p('assumption_breusch_pagan_p'),
            '); the reported heteroscedasticity-consistent, leverage-adjusted robust standard errors can help assess sensitivity.'])
        }
        if (b.raw('n_high_influence') > 0) {
          caveats.push([b.num('n_high_influence'), ' high-influence observation(s) were flagged; inspect them rather than removing them automatically.'])
        }
        vif.forEach((row, i) => {
          if (b.raw(`vif[${i}].vif`) > 5) {
            caveats.push([`Variance inflation for ${String(row.term)} exceeds the conventional threshold (VIF `,
              b.num(`vif[${i}].vif`), ').'])
          }
        })
        caveats.push(['These are associations, not evidence of causation; statistical significance does not by itself establish clinical importance.'])
        break
      }
      case 'logistic_regression': {
        if (typeof result.results.event !== 'string' || result.results.event.length === 0 ||
          typeof result.results.reference !== 'string' || result.results.reference.length === 0 || result.results.event === result.results.reference) {
          throw new Missing('event or reference')
        }
        const nUsed = wholeNumber(b, 'n_used', 1)
        wholeNumber(b, 'n_dropped_missing', 0)
        const nEvents = wholeNumber(b, 'n_events', 1)
        if (nEvents >= nUsed || b.raw('statistic_chi2') < 0 || b.raw('df') <= 0 || b.raw('events_per_parameter') <= 0) {
          throw new Missing('model statistics')
        }
        probability(b, 'p_value')
        probability(b, 'auc')
        if (b.raw('mcfadden_r2') < 0 || b.raw('mcfadden_r2') > 1) throw new Missing('mcfadden_r2')
        const coefficients = coefficientRows(b, 'coefficients', ['odds_ratio', 'or_lwr', 'or_upr', 'p_value'])
        coefficients.forEach((_, i) => {
          if (b.raw(`coefficients[${i}].odds_ratio`) <= 0 || b.raw(`coefficients[${i}].or_lwr`) <= 0 ||
            b.raw(`coefficients[${i}].or_lwr`) > b.raw(`coefficients[${i}].or_upr`)) throw new Missing(`coefficients[${i}]`)
          probability(b, `coefficients[${i}].p_value`)
        })
        const hosmer = nullableProbability(result, b, 'assumption_hosmer_lemeshow_p')
        const warningValue = result.results.model_warnings
        if (warningValue !== undefined && warningValue !== null &&
          (!Array.isArray(warningValue) || !warningValue.every((warning) => typeof warning === 'string'))) throw new Missing('model_warnings')
        const event = valueLabels[v.outcome ?? '']?.[result.results.event] ?? result.results.event
        const reference = valueLabels[v.outcome ?? '']?.[result.results.reference] ?? result.results.reference
        const sig = significance(b, 'p_value')
        paragraphs.push([
          `The logistic regression likelihood-ratio test ${sig ? 'found' : 'did not find'} a statistically significant association at the `,
          alpha(), ' level (χ²(', b.num('df'), ') = ', b.num('statistic_chi2'), ', p ', b.p('p_value'),
          '). The event was ', event, ' and the reference outcome was ', reference, '. McFadden R² was ', b.num('mcfadden_r2'),
          '. The AUC was ', b.num('auc'), ', indicating the model\'s ability to discriminate between the two outcomes.',
        ])
        coefficients.forEach((row, i) => {
          if (row.term === '(Intercept)') return
          const { predictor, level } = coefficientPredictor(String(row.term), v)
          const levelLabel = level === null ? null : (valueLabels[predictor]?.[level] ?? level)
          const comparison = levelLabel === null
            ? `For each unit increase in ${predictor}, the odds of ${event} are `
            : `Compared with the reference level of ${predictor}, the odds of ${event} for ${levelLabel} are `
          paragraphs.push([
            comparison, b.num(`coefficients[${i}].odds_ratio`), ' times as high, holding other predictors constant (',
            ...b.ciFields(`coefficients[${i}].or_lwr`, `coefficients[${i}].or_upr`), ', p ',
            b.p(`coefficients[${i}].p_value`), ').',
          ])
        })
        if (b.raw('events_per_parameter') < 10) {
          caveats.push(['There are fewer events per parameter than recommended, so estimates may be unstable.'])
        }
        if (hosmer !== null && hosmer < ALPHA) {
          caveats.push(['The Hosmer-Lemeshow test may indicate poor model calibration (p ', b.p('assumption_hosmer_lemeshow_p'), ').'])
        }
        if (Array.isArray(warningValue) && warningValue.length > 0) {
          caveats.push(['The model reported one or more warnings; review them in the results.'])
        }
        caveats.push(['These are associations, not evidence of causation; statistical significance does not by itself establish clinical importance.'])
        break
      }
      default:
        return null
    }
  } catch (e) {
    if (e instanceof Missing) return null
    throw e
  }
  const covered = ['independent_t_test', 'paired_t_test', 'one_way_anova', 'shapiro_wilk']
  if (!covered.includes(result.test) && b.raw('p_value') >= ALPHA) {
    caveats.push(['A non-significant result does not show that there is no difference or association; it may reflect limited data.'])
  }
  if (!['shapiro_wilk', 'linear_regression', 'logistic_regression'].includes(result.test)) caveats.push([GENERAL])
  return { paragraphs, caveats }
}

export function explanationText(parts: ExplanationPart[]): string {
  return parts.map((part) => (typeof part === 'string' ? part : part.text)).join('')
}
