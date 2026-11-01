import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import PythonCrossCheck from '@/components/jarvis/PythonCrossCheck'
import type { CrossCheck } from '@/lib/crossCheck'

afterEach(cleanup)

const item = (label: string, r: number, python: number | null, agree: boolean) =>
  ({ label, r, python, agree, rel_tolerance: 1e-6 })

it('reports agreement without raising an alert, with the values listed', () => {
  const cc: CrossCheck = {
    status: 'agree', engine: 'Python 3.13.5, SciPy 1.13.0', note: null,
    checks: [item('t statistic', 0.7436815, 0.7436815, true), item('p-value', 0.00004, 0.00004, true)],
  }
  render(<PythonCrossCheck crossCheck={cc} />)
  expect(screen.getByText('Python cross-check: agrees with R on all 2 values')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(/confirms the arithmetic, not that the method suits your data/)).toBeTruthy()
  expect(screen.getAllByText('0.7436815', { selector: 'td' })).toHaveLength(2)
  expect(screen.getByText('Python 3.13.5, SciPy 1.13.0')).toBeTruthy()
})

it('raises an alert for disagreements and lists the differing values first', () => {
  const cc: CrossCheck = {
    status: 'disagree', engine: 'Python', note: null,
    checks: [item('t statistic', -0.89, -0.89, true), item('Mean difference', -3.95, -3.4, false)],
  }
  const { container } = render(<PythonCrossCheck crossCheck={cc} />)
  expect(screen.getByRole('alert').textContent).toBe('Python cross-check: 1 of 2 values differ from R')
  expect(screen.getByText(/R remains the reported result/)).toBeTruthy()
  const rows = Array.from(container.querySelectorAll('tbody tr')).map((tr) => tr.textContent)
  expect(rows[0]).toContain('Mean difference')
  expect(rows[0]).toContain('Differ')
  expect(rows[1]).toContain('t statistic')
  expect(container.querySelector('details')?.hasAttribute('open')).toBe(true)
})

it('explains why no comparison was made and never implies agreement', () => {
  const cc: CrossCheck = {
    status: 'unavailable', engine: 'Python', checks: [],
    note: 'Python and R counted a different number of observations, so the results cannot be compared.',
  }
  render(<PythonCrossCheck crossCheck={cc} />)
  expect(screen.getByText('Python cross-check: not available')).toBeTruthy()
  expect(screen.getByText(/counted a different number of observations/)).toBeTruthy()
  expect(screen.queryByText(/agrees/)).toBeNull()
})

it('shows a value Python could not compute and tiny numbers in exponent form', () => {
  const cc: CrossCheck = {
    status: 'disagree', engine: 'Python', note: null,
    checks: [item('Overall p-value', 3.5664592731687e-48, null, false)],
  }
  render(<PythonCrossCheck crossCheck={cc} />)
  expect(screen.getByText('3.5665e-48')).toBeTruthy()
  expect(screen.getByText('not computed')).toBeTruthy()
})
