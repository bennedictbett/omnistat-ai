import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import JarvisInput from '@/components/jarvis/JarvisInput'
import { API_URL } from '@/lib/config'
import { chatWithJarvis, datasetContext, runDescriptives, SHARE_COLUMNS_KEY } from '@/lib/jarvisChat'
import { loadUploadedData } from '@/lib/rApi'

vi.mock('@/components/jarvis/useVoiceInput', () => ({
  useVoiceInput: () => ({ supported: false, state: 'idle' }),
}))
const panel = vi.hoisted(() => vi.fn())
vi.mock('@/components/jarvis/RAnalysisPanel', () => ({
  default: (props: { test: string; initialMapping?: Record<string, string>; autoReview?: boolean }) => {
    panel(props)
    return <div>Analysis panel for {props.test}</div>
  },
}))

const rows = Array.from({ length: 6 }, (_, i) => ({ bp: 120 + i, age: 40 + i, site: ['N', 'S', 'E'][i % 3], name: `secret-${i}` }))
const upload = {
  rows: 6, columns: ['bp', 'age', 'site', 'name'], numeric_cols: ['bp', 'age'], full_data: rows,
  missing: {}, variable_labels: { bp: 'Systolic BP' },
}
const catalog = { one_way_anova: { title: 'One-way ANOVA with Tukey HSD', variables: { outcome: 'Outcome', group: 'Group' } } }
const fetchMock = vi.fn()
const reply = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data })
const chatReply = (r: string, action: unknown = null, problem: string | null = null) =>
  reply({ reply: r, action, action_problem: problem })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('omnistat_data', JSON.stringify(upload))
  fetchMock.mockReset()
  panel.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function send(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/Message Jarvis/), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

it('replies to greetings and keeps the conversation history', async () => {
  fetchMock.mockResolvedValueOnce(chatReply('Hi! How can I help with your data?'))
  fetchMock.mockResolvedValueOnce(chatReply('A t-test compares two group means.'))
  render(<JarvisInput />)
  await send('hi')
  expect(await screen.findByText('Hi! How can I help with your data?')).toBeTruthy()
  await send('what is a t-test?')
  await screen.findByText('A t-test compares two group means.')
  const [url, init] = fetchMock.mock.calls[1]
  expect(url).toBe(`${API_URL}/api/agent/chat`)
  expect(JSON.parse(init.body).messages).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hi! How can I help with your data?' },
    { role: 'user', content: 'what is a t-test?' },
  ])
})

it('shares column names and types but never data values', async () => {
  fetchMock.mockResolvedValueOnce(chatReply('Hello'))
  render(<JarvisInput />)
  await send('hi')
  await screen.findByText('Hello')
  const body = JSON.parse(fetchMock.mock.calls[0][1].body)
  expect(body.dataset).toEqual({
    rows: 6,
    columns: [
      { name: 'bp', type: 'numeric', distinct: 6, label: 'Systolic BP' },
      { name: 'age', type: 'numeric', distinct: 6 },
      { name: 'site', type: 'categorical', distinct: 3 },
      { name: 'name', type: 'categorical', distinct: 6 },
    ],
  })
  expect(fetchMock.mock.calls[0][1].body).not.toContain('secret-')
  expect(fetchMock.mock.calls[0][1].body).not.toContain('120')
})

it('sends no dataset context when sharing is turned off', async () => {
  fetchMock.mockResolvedValueOnce(chatReply('Hello'))
  render(<JarvisInput />)
  fireEvent.click(screen.getByRole('checkbox', { name: /Share column names/ }))
  expect(localStorage.getItem(SHARE_COLUMNS_KEY)).toBe('false')
  await send('hi')
  await screen.findByText('Hello')
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).dataset).toBeUndefined()
})

it('opens a prepared analysis with the proposed columns for confirmation', async () => {
  fetchMock.mockResolvedValueOnce(chatReply('I prepared a one-way ANOVA; review and confirm.',
    { type: 'run_analysis', test: 'one_way_anova', variables: { outcome: 'bp', group: 'site' } }))
  fetchMock.mockResolvedValueOnce(reply(catalog))
  render(<JarvisInput />)
  await send('run one way anova of bp by site')
  await screen.findByText('Analysis panel for one_way_anova')
  expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({
    initialMapping: { outcome: 'bp', group: 'site' }, autoReview: true,
  }))
  expect(fetchMock.mock.calls[1][0]).toBe(`${API_URL}/api/r/tests`)
})

it('reports unsupported tests and column problems instead of running something else', async () => {
  fetchMock.mockResolvedValueOnce(chatReply('Prepared.', { type: 'run_analysis', test: 'cox_regression', variables: {} },
    'Jarvis could not match every column to your dataset, so please choose the columns yourself.'))
  fetchMock.mockResolvedValueOnce(reply(catalog))
  render(<JarvisInput />)
  await send('run a cox model')
  expect((await screen.findByRole('alert')).textContent).toContain('not available')
  expect(screen.getByText(/choose the columns yourself/)).toBeTruthy()
  expect(screen.queryByText(/Analysis panel/)).toBeNull()
})

it('offers clickable test choices when the request is ambiguous', async () => {
  fetchMock.mockResolvedValueOnce(chatReply('Which design matches your data?', {
    type: 'choose_test', options: [{ test: 'one_way_anova', title: 'One-way ANOVA with Tukey HSD', reason: 'three groups' }],
  }))
  fetchMock.mockResolvedValueOnce(reply(catalog))
  render(<JarvisInput />)
  await send('compare these')
  fireEvent.click(await screen.findByRole('button', { name: 'One-way ANOVA with Tukey HSD' }))
  await screen.findByText('Analysis panel for one_way_anova')
  expect(panel).toHaveBeenLastCalledWith(expect.objectContaining({ initialMapping: {}, autoReview: false }))
})

it('runs descriptive statistics directly from the server results', async () => {
  const stats = (column: string, mean: number) => ({ column, count: 6, mean, median: mean, std: 1.8708, min: 1, max: 9, q1: 2, q3: 8 })
  fetchMock.mockResolvedValueOnce(chatReply('Here are descriptive statistics.', { type: 'descriptive', columns: ['bp', 'age'] }))
  fetchMock.mockResolvedValueOnce(reply(stats('bp', 122.5)))
  fetchMock.mockResolvedValueOnce(reply(stats('age', 42.5)))
  render(<JarvisInput />)
  await send('run descriptive statistics')
  const table = await screen.findByRole('region', { name: 'Descriptive statistics' })
  await waitFor(() => expect(table.textContent).toContain('122.5'))
  expect(table.textContent).toContain('42.5')
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ column: 'bp', values: rows.map((r) => r.bp) })
})

it('shows explicit errors when Jarvis is unavailable or returns malformed data', async () => {
  fetchMock.mockResolvedValueOnce(reply({ detail: 'Jarvis chat is not configured on the server (missing GROQ_API_KEY). Use the Test Wizard instead.' }, 503))
  render(<JarvisInput />)
  await send('hi')
  expect((await screen.findByRole('alert')).textContent).toContain('not configured')
  fetchMock.mockResolvedValueOnce(reply({ reply: 'x', action: { type: 'delete' }, action_problem: null }))
  await expect(chatWithJarvis([{ role: 'user', content: 'hi' }], null, true)).rejects.toThrow('invalid response')
  fetchMock.mockResolvedValueOnce(reply({}, 429))
  await expect(chatWithJarvis([{ role: 'user', content: 'hi' }], null, true)).rejects.toThrow('too quickly')
  fetchMock.mockRejectedValueOnce(new TypeError('offline'))
  await expect(chatWithJarvis([{ role: 'user', content: 'hi' }], null, true)).rejects.toThrow('Could not reach Jarvis')
})

it('rejects descriptive results that are incomplete or columns without numbers', async () => {
  const data = loadUploadedData()
  fetchMock.mockResolvedValueOnce(reply({ column: 'bp', count: 6 }))
  await expect(runDescriptives(['bp'], data)).rejects.toThrow('invalid descriptive statistics')
  await expect(runDescriptives(['site'], data)).rejects.toThrow('fewer than two numeric values')
  expect(datasetContext(data!).columns.map((c) => c.name)).toEqual(['bp', 'age', 'site', 'name'])
})
