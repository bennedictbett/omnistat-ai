import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import ResultExplanation from '@/components/jarvis/ResultExplanation'
import { buildReportHtml } from '@/lib/analysisReport'
import { Explanation, explainResult, explanationText, ExplanationValue } from '@/lib/explainResult'
import { formatNumber, RRunResult } from '@/lib/rApi'
import fixtures from './fixtures/rResults.json'

const results = fixtures as unknown as Record<string, RRunResult>
afterEach(cleanup)

/** Independently resolves a token's source so the test proves the number came from the result. */
function resolve(result: RRunResult, source: string): unknown {
  const named = source.match(/^results\.(\w+)\["(.*)"\]$/)
  if (named) return (result.results[named[1]] as Record<string, unknown>)[named[2]]
  let current: unknown = result
  for (const part of source.split(/\.|\[(\d+)\]/).filter(Boolean)) {
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function tokens(explanation: Explanation): ExplanationValue[] {
  return [...explanation.paragraphs, ...explanation.caveats].flat().filter((p): p is ExplanationValue => typeof p !== 'string')
}

function staticText(explanation: Explanation): string {
  return [...explanation.paragraphs, ...explanation.caveats].flat().filter((p) => typeof p === 'string').join(' ')
}

describe.each(Object.keys(results))('%s explanation from real R output', (test) => {
  const result = results[test]

  it('contains only numbers traceable to the result or fixed method settings', () => {
    const explanation = explainResult(result)
    expect(explanation).not.toBeNull()
    expect(staticText(explanation!)).not.toMatch(/\d/)
    for (const token of tokens(explanation!)) {
      if (token.source === 'method setting') {
        expect(['95%', '0.05']).toContain(token.text)
        continue
      }
      const value = resolve(result, token.source)
      expect(typeof value, token.source).toBe('number')
      const n = value as number
      const expected = token.text.startsWith('=') || token.text.startsWith('<')
        ? (n < 0.001 ? '< 0.001' : `= ${formatNumber(n, true)}`) : formatNumber(n)
      expect(token.text, token.source).toBe(expected)
    }
  })

  it('uses caveats appropriate to the procedure', () => {
    const caveats = explainResult(result)!.caveats.map(explanationText).join('\n')
    expect(caveats.includes('clinical importance or causation')).toBe(test !== 'shapiro_wilk')
    if (['chi_square', 'mann_whitney_u', 'kruskal_wallis', 'pearson_correlation', 'wilcoxon_signed_rank'].includes(test)) {
      expect(caveats.includes('does not show that there is no difference or association'))
        .toBe((result.results.p_value as number) >= 0.05)
    }
  })
})

it('describes the direction, interval and significance of the t-test accurately', () => {
  const e = explainResult(results.independent_t_test)!
  const text = e.paragraphs.map(explanationText).join('\n')
  const r = results.independent_t_test.results
  expect(text).toContain('difference (“Control” minus “Treatment”)')
  expect(text).toContain(`was ${formatNumber(r.mean_difference as number)} (95% CI`)
  expect(text).toContain(`${(r.p_value as number) < 0.05 ? 'found' : 'did not find'} a statistically significant`)
  if ((r.p_value as number) >= 0.05) expect(text).toContain('does not show that there is no difference')
})

it('lists only Tukey comparisons below 0.05 for ANOVA', () => {
  const r = results.one_way_anova.results
  const text = explainResult(results.one_way_anova)!.paragraphs.map(explanationText).join('\n')
  for (const row of r.post_hoc_tukey as { comparison: string; p_adj: number }[]) {
    expect(text.includes(`${row.comparison} difference`)).toBe(row.p_adj < 0.05)
  }
})

it('shows value labels beside group codes', () => {
  const coded: RRunResult = {
    ...results.independent_t_test,
    variables: { outcome: 'sbp', group: 'sex' },
    results: {
      ...results.independent_t_test.results,
      groups: (results.independent_t_test.results.groups as Record<string, unknown>[])
        .map((row, i) => ({ ...row, group: String(i + 1) })),
    },
  }
  const text = explanationText(explainResult(coded, { sex: { '1': 'Male', '2': 'Female' } })!.paragraphs[0])
  expect(text).toContain('group “1” (Male)')
  expect(text).toContain('group “2” (Female)')
})

it('refuses to explain incomplete, invalid or unsupported results', () => {
  const t = results.independent_t_test
  expect(explainResult({ ...t, results: { ...t.results, p_value: null } })).toBeNull()
  expect(explainResult({ ...t, results: { ...t.results, ci_95: [1] } })).toBeNull()
  expect(explainResult({ ...t, results: { ...t.results, cohens_d: '0.5' } })).toBeNull()
  expect(explainResult({ ...t, ok: false })).toBeNull()
  expect(explainResult({ ...t, test: 'logistic_regression' })).toBeNull()
})

it('renders source-linked numbers and an unavailable message', () => {
  const { rerender } = render(<ResultExplanation explanation={explainResult(results.pearson_correlation)} />)
  const section = screen.getByRole('region', { name: 'Plain-English summary' })
  const r = section.querySelector('[data-source="results.r"]')
  expect(r?.textContent).toBe(formatNumber(results.pearson_correlation.results.r as number))
  expect(r?.getAttribute('title')).toBe('Source: results.r')
  expect(section.textContent).toContain('not AI')
  rerender(<ResultExplanation explanation={null} />)
  expect(screen.getByText(/not available for this analysis/)).toBeTruthy()
})

it('includes the escaped summary in the printable report', () => {
  const result = { ...results.independent_t_test, variables: { outcome: '<b>sbp</b>', group: 'arm' } }
  const doc = new DOMParser().parseFromString(buildReportHtml(result), 'text/html')
  expect(doc.body.textContent).toContain('Plain-English summary')
  expect(doc.body.textContent).toContain('Mean <b>sbp</b> was')
  expect(doc.querySelector('b')).toBeNull()
})
