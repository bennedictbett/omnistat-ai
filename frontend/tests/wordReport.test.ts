// @vitest-environment node
import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { apaDf, apaNumber, apaP, apaStatement, apaTables } from '@/lib/apa'
import { buildWordReport, decodePng } from '@/lib/wordReport'
import type { RRunResult } from '@/lib/rApi'
import fixtures from './fixtures/rResults.json'

const results = fixtures as unknown as Record<string, RRunResult>
const plain = (runs: { text: string }[] | null) => runs?.map((r) => r.text).join('') ?? null
// 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

describe('APA number formatting', () => {
  it('uses fixed decimals, true minus signs and no leading zero for bounded values', () => {
    expect(apaNumber(-3.9533)).toBe('−3.95')
    expect(apaNumber(0.4532, 2, true)).toBe('.45')
    expect(apaNumber(-0.2133, 2, true)).toBe('−.21')
    expect(apaNumber(-0.001)).toBe('0.00')
    expect(apaDf(29)).toBe('29')
    expect(apaDf(27.8127)).toBe('27.81')
  })

  it('formats p values the APA way', () => {
    expect(plain(apaP(0.38215))).toBe('p = .382')
    expect(plain(apaP(0.0004))).toBe('p < .001')
    expect(apaP(0.04)[0].italic).toBe(true)
    expect(() => apaP(Number.NaN)).toThrow()
  })
})

it.each([
  ['independent_t_test', /^t\(27\.81\) = −0\.89, p = \.382, Mdiff = −3\.95, 95% CI \[−13\.08, 5\.17\], d = −0\.32$/],
  ['paired_t_test', /^t\(29\) = 5\.24, p < \.001, Mdiff = 7\.14, 95% CI \[4\.36, 9\.93\], dz = 0\.96$/],
  ['one_way_anova', /^F\(2, 27\) = 11\.19, p < \.001, η2 = \.45$/],
  ['pearson_correlation', /^r = \.87, 95% CI \[\.74, \.94\], p < \.001, N = 30$/],
  ['shapiro_wilk', /^W = \.96, p = \.304, N = 30$/],
  ['mann_whitney_u', /^W = 88\.50, p = \.330, rrb = −\.21$/],
  ['wilcoxon_signed_rank', /^V = 419\.00, p < \.001, rrb = \.80$/],
  ['kruskal_wallis', /^H\(2\) = 13\.14, p = \.001, ε2 = \.45$/],
  ['chi_square', /^χ2\(1\) = 0\.54, p = \.461, V = \.20$/],
  ['linear_regression', 'F(3, 596) = 435.93, p < .001, R2 = .69, adjusted R2 = .69'],
  ['logistic_regression', 'χ2(3) = 69.99, p < .001, McFadden R2 = .09, AUC = .69'],
])('writes the APA statement for real %s output', (test, expected) => {
  const statement = plain(apaStatement(results[test]))
  if (typeof expected === 'string') expect(statement).toBe(expected)
  else expect(statement).toMatch(expected)
})

it('marks APA symbols as italic and indices as sub/superscripts', () => {
  const runs = apaStatement(results.one_way_anova)!
  expect(runs[0]).toEqual({ text: 'F', italic: true })
  expect(runs.find((r) => r.text === '2')).toMatchObject({ superscript: true })
  const t = apaStatement(results.independent_t_test)!
  expect(t.find((r) => r.text === 'diff')).toMatchObject({ subscript: true })
})

it('returns no statement for incomplete or unsupported results', () => {
  const t = results.independent_t_test
  expect(apaStatement({ ...t, results: { ...t.results, df: null } })).toBeNull()
  expect(apaStatement({ ...t, results: { ...t.results, ci_95: [1, 'x'] } })).toBeNull()
  expect(apaStatement({ ...t, test: 'logistic_regression' })).toBeNull()
  expect(apaStatement({ ...t, ok: false })).toBeNull()
})

it('builds APA tables with labels and adjusted p values', () => {
  const groups = apaTables(results.independent_t_test, { Control: 'Usual care' })[0]
  expect(groups.columns).toEqual(['Group', 'n', 'M', 'SD'])
  expect(groups.rows[0]).toEqual(['Control (Usual care)', '15', '126.54', '11.68'])
  const tukey = apaTables(results.one_way_anova).find((t) => t.title.startsWith('Tukey'))!
  expect(tukey.rows[0]).toEqual(['North-East', '−19.61', '[−29.93, −9.29]', '< .001'])
  expect(apaTables(results.mann_whitney_u)[0].columns).toEqual(['Group', 'n', 'Mdn', 'Q1', 'Q3'])
  expect(apaTables(results.chi_square)[0].title).toBe('Observed Counts')
})

it('builds coefficient tables from the real regression outputs', () => {
  const linear = apaTables(results.linear_regression)[0]
  expect(linear.title).toBe('Regression Coefficients')
  expect(linear.columns).toEqual(['Term', 'b', 'SE', '95% CI', 't', 'p'])
  expect(linear.rows.find((row) => row[0] === 'armusual care')).toEqual([
    'armusual care', '−1.61', '0.33', '[−2.27, −0.96]', '−4.85', '< .001',
  ])

  const logistic = apaTables(results.logistic_regression)[0]
  expect(logistic.title).toBe('Logistic Regression Odds Ratios')
  expect(logistic.columns).toEqual(['Term', 'OR', '95% CI', 'p'])
  expect(logistic.rows.find((row) => row[0] === 'armusual care')).toEqual([
    'armusual care', '0.44', '[0.31, 0.63]', '< .001',
  ])
})

it('validates chart images before embedding', () => {
  expect(decodePng(PNG)).toMatchObject({ width: 1, height: 1 })
  expect(decodePng(btoa('not a png at all, definitely not'))).toBeNull()
  expect(decodePng('"><script>')).toBeNull()
})

async function documentXml(result: RRunResult, labels = {}) {
  const blob = await buildWordReport(result, labels, new Date('2026-10-28T12:00:00Z'))
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  return { files, xml: strFromU8(files['word/document.xml']) }
}

it('creates a valid Word document with APA results, tables, methods, figures and code', async () => {
  const result = {
    ...results.one_way_anova, plots: [PNG, 'bad'], code: 'fit <- aov(y ~ g)\nsummary(fit)', r_version: 'R version 4.6.1',
    data_sha256: 'a'.repeat(64),
  }
  const { files, xml } = await documentXml(result)
  expect(Object.keys(files)).toContain('[Content_Types].xml')
  expect(Object.keys(files).some((f) => f.startsWith('word/media/') && f.endsWith('.png'))).toBe(true)
  const text = xml.replace(/<[^>]+>/g, '')
  expect(text).toContain('OmniStat Analysis Report: One-way ANOVA with Tukey HSD')
  expect(text).toContain('One-way ANOVA: F(2, 27) = 11.19, p &lt; .001, η2 = .45.')
  expect(text).toContain('Plain-English summary'.slice(0, 0) + 'One-way ANOVA found statistically significant evidence')
  expect(text).toContain('Table 1Descriptive Statistics for sbp by Group')
  expect(text).toContain('Table 2Tukey HSD Pairwise Comparisons')
  expect(text).toContain('Note. Differences are the first group minus the second.')
  expect(text).toContain('Engine: R (R version 4.6.1).')
  expect(text).toContain('a'.repeat(64))
  expect(text).toContain('Figure 1')
  expect(text).toContain('Figure 2')
  expect(text).toContain('could not be included because its image data was invalid')
  expect(text).toContain('fit &lt;- aov(y ~ g)')
  expect(xml).toContain('w:vertAlign w:val="superscript"')
  expect(xml).toMatch(/<w:left w:val="none"/)
  expect(xml).not.toContain('<w:insideV w:val="single"')
})

it.each([
  ['linear_regression', 'F(3, 596) = 435.93, p &lt; .001, R2 = .69, adjusted R2 = .69', 'Table 1Regression Coefficients'],
  ['logistic_regression', 'χ2(3) = 69.99, p &lt; .001, McFadden R2 = .09, AUC = .69', 'Table 1Logistic Regression Odds Ratios'],
])('includes the %s APA statement and coefficient table in the Word document', async (test, statement, table) => {
  const { xml } = await documentXml(results[test])
  const text = xml.replace(/<[^>]+>/g, '')
  expect(text).toContain(statement)
  expect(text).toContain(table)
  expect(text).toContain('95% CI')
  expect(xml).toContain('<w:i/>')
  expect(xml).toContain('<w:vertAlign w:val="superscript"')
})

it('falls back to a results table for procedures without an APA statement and escapes text', async () => {
  const { xml } = await documentXml({
    ...results.independent_t_test, test: 'logistic_regression', title: 'Logistic <regression>',
    results: { test: 'Logistic regression', auc: 0.81234, p_value: 0.0002 },
  })
  const text = xml.replace(/<[^>]+>/g, '')
  expect(text).toContain('Logistic &lt;regression&gt;')
  expect(text).toContain('AUC0.8123')
  expect(text).not.toContain('Plain-English')
})

it('refuses failed analyses', async () => {
  await expect(buildWordReport({ ...results.shapiro_wilk, ok: false })).rejects.toThrow('successful')
})
