import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { AnalysisPlan, runRTest } from '@/lib/rApi'

const fetchMock = vi.fn()
// Assumption checks are routed separately so call-order assertions cover plan and run requests only.
const checksMock = vi.fn()
const rows = Array.from({ length: 10 }, (_, i) => ({ bp: i + 1, unused: 'not sent' }))
const spec = { title: 'Shapiro-Wilk', variables: { variable: 'Numeric column' } }
const intentVariables = ['bp']

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  checksMock.mockReset()
  checksMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({ detail: 'Server is not configured' }) })
  vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
    url === '/api/r/checks' ? checksMock(url, init) : fetchMock(url, init))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('sends all uploaded rows and only confirmed columns to the same-origin R proxy', async () => {
  localStorage.setItem('omnistat_data', JSON.stringify({
    columns: ['bp', 'unused'], numeric_cols: ['bp'], full_data: rows,
  }))
  const normalityPlan: AnalysisPlan = {
    ...plan, procedure: 'shapiro_wilk', title: 'Shapiro-Wilk',
    variables: { variable: 'bp' }, group_counts: {},
    alternative: null, confidence_level: null, equal_variances: null,
  }
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => normalityPlan })
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      ok: true, results: { p_value: 0.4 }, error: null, plots: [], timed_out: false,
      duration_s: 0.1, test: 'shapiro_wilk', title: 'Shapiro-Wilk',
      variables: { variable: 'bp' },
      analysis_plan: normalityPlan, data_sha256: normalityPlan.data_sha256,
    }),
  })
  render(<RAnalysisPanel test="shapiro_wilk" spec={spec} intentVariables={intentVariables} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm and Run in R' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  const [url, init] = fetchMock.mock.calls[1]
  expect(url).toBe('/api/r/run')
  expect(JSON.parse(init.body)).toEqual({
    test: 'shapiro_wilk',
    variables: { variable: 'bp' },
    data: rows.map(({ bp }) => ({ bp })),
    analysis_plan: normalityPlan,
  })
  await screen.findByText('p-value')
})

it('requires an upload instead of supplying sample rows', async () => {
  render(<RAnalysisPanel test="shapiro_wilk" spec={spec} intentVariables={intentVariables} />)
  await screen.findByText('Upload your data first')
  expect(screen.queryByRole('button', { name: 'Run in R' })).toBeNull()
  expect(fetchMock).not.toHaveBeenCalled()
})

it('reports corrupt saved data instead of treating it as an absent upload', async () => {
  localStorage.setItem('omnistat_data', '{broken')
  render(<RAnalysisPanel test="shapiro_wilk" spec={spec} intentVariables={intentVariables} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Could not read the saved dataset')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('rejects unreadable successful R responses', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => null })
  await expect(runRTest('shapiro_wilk', { variable: 'bp' }, rows)).rejects.toThrow('invalid result')
})

const plan: AnalysisPlan = {
  schema_version: '1.0', procedure: 'independent_t_test', engine: 'r',
  title: 'Welch two-sample t-test', variables: { outcome: 'bp', group: 'arm' },
  data_sha256: 'a'.repeat(64), rows_total: 10, rows_used: 10, rows_dropped_missing: 0,
  group_counts: { A: 5, B: 5 }, alternative: 'two.sided', confidence_level: 0.95,
  equal_variances: false, missing_data_policy: 'complete_cases',
  assumptions: ['Observations are independent.'], outputs: ['p-value'],
}
const tSpec = { title: plan.title, variables: { outcome: 'Outcome', group: 'Group' } }
const tVariables = ['bp', 'arm']

function renderTTest() {
  localStorage.setItem('omnistat_data', JSON.stringify({
    columns: ['bp', 'arm', 'other'], numeric_cols: ['bp', 'other'],
    full_data: rows.map((row, i) => ({ ...row, arm: i < 5 ? 'A' : 'B', other: 2 * row.bp })),
  }))
  render(<RAnalysisPanel test="independent_t_test" spec={tSpec} intentVariables={tVariables} />)
}

it('requires plan review and explicit confirmation before executing a t-test', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => plan })
  renderTTest()
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  await screen.findByRole('region', { name: 'Analysis plan review' })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(fetchMock.mock.calls[0][0]).toBe('/api/r/plan')
  expect(screen.queryByText('Executed analysis specification')).toBeNull()
  fetchMock.mockResolvedValueOnce({
    ok: true, json: async () => ({
      ok: true, results: { p_value: 0.4 }, error: null, plots: [], timed_out: false,
      duration_s: 0.1, test: 'independent_t_test', title: plan.title,
      variables: plan.variables, analysis_plan: plan, data_sha256: plan.data_sha256,
    }),
  })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and Run in R' }))
  await screen.findByText('Executed analysis specification')
  expect(fetchMock.mock.calls[1][0]).toBe('/api/r/run')
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).analysis_plan).toEqual(plan)
})

it('invalidates a reviewed plan when columns change', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => plan })
  renderTTest()
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  await screen.findByRole('region', { name: 'Analysis plan review' })
  fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'other' } })
  expect(screen.queryByRole('region', { name: 'Analysis plan review' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Review Analysis Plan' })).toBeTruthy()
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('can cancel review without running the analysis', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => plan })
  renderTTest()
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel review' }))
  expect(screen.queryByRole('button', { name: 'Confirm and Run in R' })).toBeNull()
  expect(fetchMock).toHaveBeenCalledOnce()
})

it('rejects a result without the reviewed specification', async () => {
  fetchMock.mockResolvedValueOnce({
    ok: true, json: async () => ({
      ok: true, results: {}, error: null, plots: [], timed_out: false,
      duration_s: 0.1, test: 'independent_t_test', title: plan.title,
      variables: plan.variables, data_sha256: plan.data_sha256,
    }),
  })
  await expect(runRTest('independent_t_test', plan.variables, rows, plan)).rejects.toThrow('does not match')
})

it.each([
  {
    procedure: 'paired_t_test' as const, variables: { first: 'bp', second: 'other' },
    equal_variances: null, alternative: 'two.sided' as const, confidence_level: 0.95 as const,
  },
  {
    procedure: 'pearson_correlation' as const, variables: { x: 'bp', y: 'other' },
    equal_variances: null, alternative: 'two.sided' as const, confidence_level: 0.95 as const,
  },
  {
    procedure: 'one_way_anova' as const, variables: { outcome: 'bp', group: 'arm' },
    equal_variances: true, alternative: null, confidence_level: 0.95 as const,
  },
])('reviews $procedure with procedure-specific settings before execution', async (settings) => {
  const reviewed: AnalysisPlan = {
    ...plan, ...settings, title: settings.procedure,
    group_counts: settings.procedure === 'one_way_anova' ? { A: 3, B: 3, C: 4 } : {},
  }
  const variables = Object.values(settings.variables)
  localStorage.setItem('omnistat_data', JSON.stringify({
    columns: ['bp', 'other', 'arm'], numeric_cols: ['bp', 'other'],
    full_data: rows.map((row, i) => ({ bp: row.bp, other: row.bp * 2, arm: ['A', 'B', 'C'][i % 3] })),
  }))
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => reviewed })
  render(<RAnalysisPanel test={settings.procedure}
    spec={{ title: settings.procedure, variables: Object.fromEntries(Object.keys(settings.variables).map((role) => [role, role])) }}
    intentVariables={variables} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  await screen.findByRole('region', { name: 'Analysis plan review' })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(screen.queryByText('Unequal variances (Welch)')).toBeNull()
  if (settings.procedure === 'one_way_anova') {
    expect(screen.getByText('Equal variances assumed')).toBeTruthy()
    expect(screen.queryByText('Two-sided test')).toBeNull()
  } else {
    expect(screen.getByText('Two-sided test')).toBeTruthy()
    expect(screen.queryByText(/^Groups:/)).toBeNull()
  }
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
    ok: true, results: { p_value: 0.3 }, error: null, plots: [], timed_out: false,
    duration_s: 0.1, test: settings.procedure, title: settings.procedure,
    variables: settings.variables, analysis_plan: reviewed, data_sha256: reviewed.data_sha256,
  }) })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and Run in R' }))
  await screen.findByText('Executed analysis specification')
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).analysis_plan).toEqual(reviewed)
})

const checksFor = (reviewed: AnalysisPlan, overrides: Record<string, unknown> = {}) => ({
  procedure: reviewed.procedure, variables: reviewed.variables, data_sha256: reviewed.data_sha256, alpha: 0.05,
  checks: [
    { id: 'normality:A', label: 'Normality in group “A”', status: 'warning', detail: 'Shapiro-Wilk W = 0.700, p = 0.004: evidence of non-normality.' },
    { id: 'equal_variances', label: 'Equal variances (Brown-Forsythe)', status: 'info', detail: 'Welch does not assume equal variances.' },
    { id: 'outliers:B', label: 'Outliers in group “B”', status: 'not_assessed', detail: 'Too few values.' },
  ],
  suggestion: { test: 'mann_whitney_u', title: 'Mann-Whitney U (Wilcoxon rank-sum)', reason: 'Normality is questionable.' },
  notes: ['Independence and study design cannot be checked from the data.'],
  ...overrides,
})

it('shows assumption checks and a suggested alternative during review without running R', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => plan })
  checksMock.mockResolvedValueOnce({ ok: true, json: async () => checksFor(plan) })
  renderTTest()
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  const section = await screen.findByRole('region', { name: 'Assumption checks' })
  expect(section.textContent).toContain('evidence of non-normality')
  expect(section.textContent).toContain('(Review)')
  expect(section.textContent).toContain('(Not assessed)')
  expect(screen.getByRole('note').textContent).toContain('Consider: Mann-Whitney U')
  expect(JSON.parse(checksMock.mock.calls[0][1].body)).toEqual({
    test: 'independent_t_test', variables: plan.variables,
    data: rows.map((row, i) => ({ bp: row.bp, arm: i < 5 ? 'A' : 'B' })),
  })
  expect(fetchMock).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Confirm and Run in R' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel review' }))
  expect(screen.queryByRole('region', { name: 'Assumption checks' })).toBeNull()
})

it('rejects checks for different data and keeps the plan usable', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => plan })
  checksMock.mockResolvedValueOnce({ ok: true, json: async () => checksFor(plan, { data_sha256: 'b'.repeat(64) }) })
  renderTTest()
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('do not match this plan')
  expect(screen.queryByRole('region', { name: 'Assumption checks' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Confirm and Run in R' })).toBeTruthy()
})

it('reports unavailable or malformed checks explicitly', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => plan })
  checksMock.mockResolvedValueOnce({ ok: true, json: async () => checksFor(plan, { checks: [{ id: 'x', status: 'great' }] }) })
  renderTTest()
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  expect((await screen.findByRole('alert')).textContent).toContain('invalid assumption checks')
  cleanup()
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => plan })
  checksMock.mockRejectedValueOnce(new TypeError('offline'))
  renderTTest()
  fireEvent.click(await screen.findByRole('button', { name: 'Review Analysis Plan' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not run assumption checks')
})
