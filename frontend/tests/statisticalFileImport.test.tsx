import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import FileUpload from '@/components/data/FileUpload'
import RAnalysisPanel from '@/components/jarvis/RAnalysisPanel'
import { uploadDataset } from '@/lib/api'
import { AnalysisPlan, loadUploadedData } from '@/lib/rApi'

const rows = [
  { bp: 120, sex: 1 }, { bp: 130, sex: 2 }, { bp: 125, sex: 1 }, { bp: 140, sex: 2 },
]
const upload = {
  rows: 4, columns: ['bp', 'sex'], numeric_cols: ['bp', 'sex'], full_data: rows,
  missing: { bp: 0, sex: 0 },
  variable_labels: { bp: 'Systolic BP' },
  value_labels: { sex: { '1': 'Male', '2': 'Female' } },
}
const fetchMock = vi.fn()
const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => data })

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('accepts SPSS and Stata files and shows their labels after upload', async () => {
  fetchMock.mockResolvedValueOnce(reply(upload))
  const onUpload = vi.fn()
  const { container } = render(<FileUpload onUpload={onUpload} />)
  const input = container.querySelector('input')!
  expect(input.getAttribute('accept')).toBe('.csv,.xlsx,.xls,.sav,.zsav,.dta')
  fireEvent.change(input, { target: { files: [new File(['x'], 'trial.sav')] } })
  await screen.findByText('File parsed successfully')
  expect(onUpload).toHaveBeenCalledWith(upload, 'trial.sav')
  expect(screen.getByText('bp — Systolic BP')).toBeTruthy()
  expect(screen.getByText(/Value labels were found for 1 column/).textContent).toContain('stored codes')
})

it('rejects malformed label metadata instead of displaying it', async () => {
  fetchMock.mockResolvedValueOnce(reply({ ...upload, value_labels: { sex: { '1': 5 } } }))
  await expect(uploadDataset(new File(['x'], 'trial.dta'))).rejects.toThrow('complete dataset')
  localStorage.setItem('omnistat_data', JSON.stringify({ ...upload, variable_labels: ['bad'] }))
  expect(() => loadUploadedData()).toThrow('invalid')
})

it('keeps older uploads without labels working', () => {
  const { variable_labels: _v, value_labels: _l, ...plain } = upload
  localStorage.setItem('omnistat_data', JSON.stringify(plain))
  expect(loadUploadedData()).toMatchObject({ variableLabels: {}, valueLabels: {} })
})

it('shows variable labels in pickers and value labels beside group codes in review', async () => {
  localStorage.setItem('omnistat_data', JSON.stringify(upload))
  const plan: AnalysisPlan = {
    schema_version: '1.0', procedure: 'independent_t_test', engine: 'r', title: 'Welch two-sample t-test',
    variables: { outcome: 'bp', group: 'sex' }, data_sha256: 'a'.repeat(64),
    rows_total: 4, rows_used: 4, rows_dropped_missing: 0, group_counts: { '1': 2, '2': 2 },
    alternative: 'two.sided', confidence_level: 0.95, equal_variances: false,
    missing_data_policy: 'complete_cases', assumptions: [], outputs: [],
  }
  fetchMock.mockResolvedValueOnce(reply(plan))
  fetchMock.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ detail: 'Unavailable' }) })
  render(<RAnalysisPanel test="independent_t_test"
    spec={{ title: plan.title, variables: { outcome: 'Outcome', group: 'Group' } }} intentVariables={['bp', 'sex']} />)
  const options = (await screen.findAllByRole('option')).map((option) => option.textContent)
  expect(options).toContain('bp — Systolic BP  (numeric)')
  fireEvent.click(screen.getByRole('button', { name: 'Review Analysis Plan' }))
  expect(await screen.findByText('Groups: 1 (Male): 2, 2 (Female): 2')).toBeTruthy()
})
