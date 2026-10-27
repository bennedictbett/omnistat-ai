import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DataQualityAudit from '@/components/data/DataQualityAudit'
import { isDataAudit, DataAudit } from '@/lib/dataAudit'
import { uploadDataset } from '@/lib/api'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const column = {
  column: 'value', missing_count: 2, missing_percent: 40, blank_text_count: 0,
  empty: false, constant: true, numeric_text_count: 0, numeric_looking_text: false, non_finite_count: 0,
}
const audit: DataAudit = { version: '1.0', rows: 5, duplicate_rows: 1, columns: [column] }

it('displays exact missingness and duplicate counts with clear read-only caveats', () => {
  render(<DataQualityAudit audit={audit} />)
  expect(screen.getByText('2 (40%)')).toBeTruthy()
  expect(screen.getByText(/1 duplicate rows beyond the first occurrence/)).toBeTruthy()
  expect(screen.getByText('Constant among populated cells')).toBeTruthy()
  expect(screen.getByText(/no rows are removed/)).toBeTruthy()
})

it('distinguishes empty, numeric-looking text and infinite-value flags', () => {
  render(<DataQualityAudit audit={{ ...audit, columns: [
    { ...column, column: 'empty', empty: true, constant: false },
    { ...column, column: 'codes', constant: false, numeric_looking_text: true, numeric_text_count: 4 },
    { ...column, column: 'infinite', constant: false, non_finite_count: 2 },
  ] }} />)
  expect(screen.getByText('Entirely empty')).toBeTruthy()
  expect(screen.getByText('Numeric-looking text (4 cells)')).toBeTruthy()
  expect(screen.getByText('2 infinite values serialized as null')).toBeTruthy()
})

it('does not imply a clean audit for older datasets or malformed responses', () => {
  const { rerender } = render(<DataQualityAudit audit={undefined} />)
  expect(screen.getByText(/unavailable for this saved upload/)).toBeTruthy()
  rerender(<DataQualityAudit audit={{ ...audit, version: 'bad' }} />)
  expect(screen.getByRole('alert').textContent).toContain('invalid or unsupported')
})

it('rejects invalid counts, percentages and flags', () => {
  expect(isDataAudit(audit)).toBe(true)
  expect(isDataAudit({ ...audit, duplicate_rows: 5 })).toBe(false)
  for (const change of [{ missing_count: -1 }, { missing_percent: 101 }, { empty: 'yes' }]) {
    expect(isDataAudit({ ...audit, columns: [{ ...column, ...change }] })).toBe(false)
  }
})

it('rejects audits whose dataset shape does not match the upload', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({
      rows: 1, columns: ['value'], numeric_cols: ['value'], full_data: [{ value: 1 }],
      missing: { value: 0 }, audit,
    }),
  }))
  await expect(uploadDataset(new File(['value\n1'], 'test.csv'))).rejects.toThrow('complete dataset')
})
