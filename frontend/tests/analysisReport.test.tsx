import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import AnalysisReport from '@/components/reports/AnalysisReport'
import { buildReportHtml, MAX_REPORT_TABLE_ROWS, printReport } from '@/lib/analysisReport'
import type { AnalysisPlan, RRunResult } from '@/lib/rApi'

afterEach(() => { cleanup(); document.getElementById('omnistat-report-frame')?.remove() })

const plan: AnalysisPlan = {
  schema_version: '1.0', procedure: 'independent_t_test', engine: 'r', title: 'Welch two-sample t-test',
  variables: { outcome: 'bp', group: 'arm' }, data_sha256: 'a'.repeat(64),
  rows_total: 12, rows_used: 10, rows_dropped_missing: 2, group_counts: { '<A>': 5, B: 5 },
  alternative: 'two.sided', confidence_level: 0.95, equal_variances: false,
  missing_data_policy: 'complete_cases', assumptions: ['Observations are independent.'], outputs: ['p-value'],
}
const png = btoa('\x89PNG\r\n\x1a\nfixture')
const result: RRunResult = {
  ok: true, test: 'independent_t_test', title: 'Welch two-sample t-test',
  variables: { outcome: 'bp', group: 'arm' }, error: null, timed_out: false, duration_s: 0.2,
  results: {
    test: 'Welch t-test', p_value: 0.0001234, statistic_t: 4.56789, df: 8.2,
    group_means: { '<A>': 1.5 }, warnings: ['<script>alert(1)</script>'],
    table: Array.from({ length: MAX_REPORT_TABLE_ROWS + 5 }, (_, i) => ({ id: i, p_value: 0.5 })),
  },
  plots: [png, '"><script>bad()</script>'], code: 'df <- read.csv("data.csv")\n# </pre><script>x()</script>',
  r_version: 'R version 4.6.1', data_sha256: 'a'.repeat(64), analysis_plan: plan,
}

it('builds a complete, escaped and script-free report', () => {
  const html = buildReportHtml(result, new Date('2026-01-02T03:04:05Z'))
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const text = doc.body.textContent ?? ''
  expect(doc.querySelectorAll('script')).toHaveLength(0)
  expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("default-src 'none'")
  expect(text).toContain('generated 2026-01-02T03:04:05.000Z')
  expect(text).toContain('R version 4.6.1')
  expect(text).toContain('a'.repeat(64))
  expect(text).toContain('12 / 10 / 2')
  expect(text).toContain('Unequal variances (Welch)')
  expect(text).toContain('Group "<A>" n')
  expect(text).toContain('Observations are independent.')
  expect(text).toContain('< 0.001 (1.23e-4); p < 0.05 at the 0.05 level')
  expect(text).toContain('4.568')
  expect(text).toContain('<script>alert(1)</script>')
  expect(text).toContain('# </pre><script>x()</script>')
  expect(text).toContain(`Showing the first ${MAX_REPORT_TABLE_ROWS} of ${MAX_REPORT_TABLE_ROWS + 5} rows`)
  expect(text).toContain('not a signed attestation')
  expect(doc.querySelectorAll('img')).toHaveLength(1)
  expect(doc.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
  expect(text).toContain('1 chart(s) could not be included')
})

it('reports legacy results without a plan and omits large curve-fit coordinates', () => {
  const html = buildReportHtml({
    ...result, test: 'michaelis_menten', analysis_plan: undefined, r_version: null, plots: [],
    results: {
      parameters: [{ term: 'Vmax', estimate: 2, se: 0.1, lwr: 1.8, upr: 2.2 }],
      curve: [{ x: 1, fit: 1, lwr: 0.9, upr: 1.1 }], points: [{ x: 1, y: 1 }],
      residuals: [{ x: 1, fitted: 1, residual: 0 }], r_squared: 0.99,
    },
  })
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
  expect(text).toContain('R (version not recorded)')
  expect(text).not.toContain('Declared assumptions')
  expect(text).toContain('Vmax')
  expect(text).not.toContain('Residuals')
  expect(text).toContain('Fitted-curve coordinates, data points and residuals are omitted')
})

it('refuses to report failed analyses', () => {
  expect(() => buildReportHtml({ ...result, ok: false })).toThrow('successful')
  render(<AnalysisReport result={{ ...result, ok: false }} />)
  expect(screen.queryByRole('button')).toBeNull()
})

it('prints only the isolated report frame and removes it afterwards', async () => {
  const pending = printReport('<p>report</p>')
  const frame = document.getElementById('omnistat-report-frame') as HTMLIFrameElement
  expect(frame.getAttribute('sandbox')).toBe('allow-same-origin allow-modals')
  expect(frame.srcdoc).toBe('<p>report</p>')
  const win = frame.contentWindow!
  vi.spyOn(win, 'focus').mockImplementation(() => {})
  const print = vi.spyOn(win, 'print').mockImplementation(() => {})
  frame.onload?.(new Event('load'))
  await pending
  expect(print).toHaveBeenCalledOnce()
  win.dispatchEvent(new Event('afterprint'))
  expect(document.getElementById('omnistat-report-frame')).toBeNull()
})

it('shows an explicit error when the browser cannot print', async () => {
  render(<AnalysisReport result={result} />)
  fireEvent.click(screen.getByRole('button', { name: /Print \/ Save as PDF/ }))
  const frame = document.getElementById('omnistat-report-frame') as HTMLIFrameElement
  vi.spyOn(frame.contentWindow!, 'focus').mockImplementation(() => {})
  vi.spyOn(frame.contentWindow!, 'print').mockImplementation(() => { throw new Error('blocked') })
  frame.onload?.(new Event('load'))
  expect((await screen.findByRole('alert')).textContent).toContain('could not open the print dialog')
  expect(document.getElementById('omnistat-report-frame')).toBeNull()
  expect(screen.getByRole('button', { name: /Print \/ Save as PDF/ }).hasAttribute('disabled')).toBe(false)
})
