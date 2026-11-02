import { describe, expect, it } from 'vitest'
import { crossCheckSummary, CrossCheck, isCrossCheck } from '@/lib/crossCheck'
import { buildReportHtml } from '@/lib/analysisReport'
import { isRRunResult, RRunResult } from '@/lib/rApi'
import fixtures from './fixtures/rResults.json'

const base = fixtures as unknown as Record<string, RRunResult>
const item = (label: string, r: number, python: number | null, agree: boolean) =>
  ({ label, r, python, agree, rel_tolerance: 1e-6 })
const ENGINE = 'Python 3.13.5, SciPy 1.13.0'

const agreeing: CrossCheck = {
  status: 'agree', engine: ENGINE, note: null,
  checks: [item('t statistic', -0.89, -0.89, true), item('p-value', 0.382, 0.382, true)],
}
const differing: CrossCheck = {
  status: 'disagree', engine: ENGINE, note: null,
  checks: [item('t statistic', -0.89, -0.89, true), item('Mean difference', -3.95, -3.4, false)],
}
const unavailable: CrossCheck = {
  status: 'unavailable', engine: ENGINE, note: 'Python and R counted a different number of observations.', checks: [],
}

describe('isCrossCheck', () => {
  it('accepts consistent results', () => {
    for (const cc of [agreeing, differing, unavailable]) expect(isCrossCheck(cc)).toBe(true)
  })

  it('rejects a status that overstates agreement', () => {
    expect(isCrossCheck({ ...agreeing, checks: differing.checks })).toBe(false)
    expect(isCrossCheck({ ...agreeing, checks: [] })).toBe(false)
    expect(isCrossCheck({ ...differing, checks: agreeing.checks })).toBe(false)
    expect(isCrossCheck({ ...unavailable, checks: agreeing.checks })).toBe(false)
  })

  it('rejects malformed shapes and values', () => {
    expect(isCrossCheck(null)).toBe(false)
    expect(isCrossCheck({ ...agreeing, status: 'fine' })).toBe(false)
    expect(isCrossCheck({ ...agreeing, engine: 3 })).toBe(false)
    expect(isCrossCheck({ ...agreeing, checks: [item('x', Number.NaN, 1, true)] })).toBe(false)
    expect(isCrossCheck({ ...agreeing, checks: [item('x', 1, null, true)] })).toBe(false)
    expect(isCrossCheck({ ...agreeing, checks: [{ label: 'x', r: 1, python: 1, agree: true }] })).toBe(false)
  })
})

describe('crossCheckSummary', () => {
  it('states agreement, differences by name, and unavailability', () => {
    expect(crossCheckSummary(agreeing)).toBe(`Python cross-check (${ENGINE}): all 2 recomputed values agree with R.`)
    expect(crossCheckSummary(differing)).toBe(
      `Python cross-check (${ENGINE}): 1 of 2 recomputed values differ from R (Mean difference). Review before relying on this result.`)
    expect(crossCheckSummary(unavailable)).toBe(
      'Python cross-check not available: Python and R counted a different number of observations.')
    expect(crossCheckSummary({ ...unavailable, note: null })).toBe('Python cross-check not available.')
  })
})

describe('run results and reports', () => {
  const run = (cc?: CrossCheck): RRunResult => ({ ...base.independent_t_test, cross_check: cc })

  it('validates the cross-check inside a run result', () => {
    const body = JSON.parse(JSON.stringify(run(agreeing)))
    expect(isRRunResult(body)).toBe(true)
    expect(isRRunResult({ ...body, cross_check: { ...agreeing, checks: [] } })).toBe(false)
    expect(isRRunResult(JSON.parse(JSON.stringify(run())))).toBe(true)
  })

  it('puts the cross-check in the printable report only when present', () => {
    const doc = (r: RRunResult) => new DOMParser().parseFromString(buildReportHtml(r), 'text/html').body.textContent ?? ''
    expect(doc(run(differing))).toContain('1 of 2 recomputed values differ from R (Mean difference)')
    expect(doc(run())).not.toContain('Python cross-check')
  })
})
