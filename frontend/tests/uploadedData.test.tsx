import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JarvisInput from '@/components/jarvis/JarvisInput'
import FileUpload from '@/components/data/FileUpload'
import DescriptiveStats from '@/components/analytics/DescriptiveStats'
import { queryJarvis, uploadDataset } from '@/lib/api'
import { API_URL } from '@/lib/config'
import { fetchRTests } from '@/lib/rApi'

vi.mock('@/components/jarvis/useVoiceInput', () => ({
  useVoiceInput: () => ({ supported: false, state: 'idle' }),
}))
vi.mock('@/components/jarvis/RAnalysisPanel', () => ({
  default: ({ test }: { test: string }) => <div>Column picker for {test}</div>,
}))

const rows = Array.from({ length: 10 }, (_, index) => ({ bp: index + 1 }))
const upload = {
  rows: 10,
  columns: ['bp'],
  numeric_cols: ['bp'],
  full_data: rows,
  preview: rows.slice(0, 5),
  missing: { bp: 0 },
}
const fetchMock = vi.fn()
const reply = (data: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => data })

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function submitQuestion(test = 'shapiro_wilk') {
  fetchMock.mockResolvedValueOnce(reply({ success: true, intent: { test, variables: ['bp'] } }))
  render(<JarvisInput />)
  fireEvent.change(screen.getByPlaceholderText(/Compare survival rates/), { target: { value: 'Check bp' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByText('Suggested Analysis')
}

describe('uploaded-data workflow', () => {
  it('uses the configured server and sends the uploaded file', async () => {
    fetchMock.mockResolvedValueOnce(reply(upload))
    const file = new File(['bp\n1'], 'data.csv', { type: 'text/csv' })
    expect(await uploadDataset(file)).toEqual(upload)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API_URL}/api/analytics/upload`)
    expect(init.body.get('file')).toBe(file)
  })

  it('does not save or report success for a failed upload', async () => {
    fetchMock.mockResolvedValueOnce(reply({ detail: 'Invalid file' }, 422))
    const onUpload = vi.fn()
    const { container } = render(<FileUpload onUpload={onUpload} />)
    const input = container.querySelector('input')
    if (!input) throw new Error('Upload input missing')
    fireEvent.change(input, { target: { files: [new File(['bad'], 'bad.csv')] } })
    await screen.findByText(/HTTP 422/)
    expect(onUpload).not.toHaveBeenCalled()
    expect(screen.queryByText('File parsed successfully')).toBeNull()
  })

  it('rejects truncated or empty upload responses', async () => {
    fetchMock.mockResolvedValueOnce(reply({ ...upload, full_data: rows.slice(0, 5) }))
    await expect(uploadDataset(new File(['bp'], 'data.csv'))).rejects.toThrow('complete dataset')
    fetchMock.mockResolvedValueOnce(reply({ ...upload, rows: 0, full_data: [] }))
    await expect(uploadDataset(new File(['bp'], 'data.csv'))).rejects.toThrow('complete dataset')
  })

  it('sends every numeric row, not just the preview, for descriptive statistics', async () => {
    localStorage.setItem('omnistat_data', JSON.stringify(upload))
    fetchMock.mockResolvedValueOnce(reply({ column: 'bp', n: 10 }))
    render(<DescriptiveStats />)
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API_URL}/api/analytics/descriptive`)
    expect(JSON.parse(init.body)).toEqual({ column: 'bp', values: rows.map((row) => row.bp) })
  })

  it('opens the column picker for a supported test without running sample data', async () => {
    await submitQuestion()
    fetchMock.mockResolvedValueOnce(reply({ shapiro_wilk: { title: 'Shapiro-Wilk', variables: { variable: 'Column' } } }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Data Columns' }))
    await screen.findByText('Column picker for shapiro_wilk')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${API_URL}/api/agent/query`, `${API_URL}/api/r/tests`,
    ])
  })

  it('reports an unsupported survival analysis without running a different test', async () => {
    await submitQuestion('cox_regression')
    fetchMock.mockResolvedValueOnce(reply({}))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Data Columns' }))
    expect((await screen.findByRole('alert')).textContent).toContain('not available')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not fall back to sample data when the catalog is unavailable', async () => {
    await submitQuestion()
    fetchMock.mockRejectedValueOnce(new TypeError('Network unavailable'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Data Columns' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not connect')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('rejects malformed analysis catalogs', async () => {
    fetchMock.mockResolvedValueOnce(reply({ shapiro_wilk: { title: 'Test' } }))
    await expect(fetchRTests()).rejects.toThrow('invalid list')
  })

  it('shows clarification instead of an executable plan', async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, needs_clarification: true }))
    render(<JarvisInput />)
    fireEvent.change(screen.getByPlaceholderText(/Compare survival rates/), { target: { value: 'Compare these' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await screen.findByText(/Your question is ambiguous/)
    expect(screen.queryByRole('button', { name: 'Choose Data Columns' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('rejects incomplete classifier-only plans and malformed optional fields', async () => {
    fetchMock.mockResolvedValueOnce(reply({ success: true, groq_failed: true, intent: { test: 'normality' } }))
    await expect(queryJarvis('normality')).rejects.toThrow('complete analysis plan')
    fetchMock.mockResolvedValueOnce(reply({ success: true, intent: { test: 'shapiro_wilk', variables: 'bp' } }))
    await expect(queryJarvis('normality')).rejects.toThrow('invalid analysis plan')
  })

  it('reports unreadable and HTTP error responses explicitly', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => { throw new SyntaxError('Not JSON') } })
    await expect(queryJarvis('question')).rejects.toThrow('unreadable response')
    fetchMock.mockResolvedValueOnce(reply({ detail: 'Unavailable' }, 503))
    await expect(queryJarvis('question')).rejects.toThrow('HTTP 503')
  })
})
