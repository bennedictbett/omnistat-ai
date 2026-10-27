import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { runRTest } from '@/lib/rApi'

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
