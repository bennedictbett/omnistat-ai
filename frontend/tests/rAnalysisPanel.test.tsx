import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { AnalysisPlan, runRTest } from '@/lib/rApi'

const fetchMock = vi.fn()
const rows = Array.from({ length: 10 }, (_, i) => ({ bp: i + 1, unused: 'not sent' }))
const spec = { title: 'Shapiro-Wilk', variables: { variable: 'Numeric column' } }
const intentVariables = ['bp']

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('sends all uploaded rows and only confirmed columns to the same-origin R proxy', async () => {
  localStorage.setItem('omnistat_data', JSON.stringify({
    columns: ['bp', 'unused'], numeric_cols: ['bp'], full_data: rows,
  }))
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      ok: true, results: { p_value: 0.4 }, error: null, plots: [], timed_out: false,
      duration_s: 0.1, test: 'shapiro_wilk', title: 'Shapiro-Wilk',
      variables: { variable: 'bp' },
    }),
  })
  render(<RAnalysisPanel test="shapiro_wilk" spec={spec} intentVariables={intentVariables} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Run in R' }))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('/api/r/run')
  expect(JSON.parse(init.body)).toEqual({
    test: 'shapiro_wilk',
    variables: { variable: 'bp' },
    data: rows.map(({ bp }) => ({ bp })),
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
