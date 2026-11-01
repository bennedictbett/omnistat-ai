// Python cross-check of an R result, computed by the backend (app/services/python_crosscheck.py).

export interface CrossCheckItem {
  label: string
  r: number
  python: number | null
  agree: boolean
  rel_tolerance: number
}

export type CrossCheckStatus = 'agree' | 'disagree' | 'unavailable'

export interface CrossCheck {
  status: CrossCheckStatus
  /** e.g. "Python 3.13.5, SciPy 1.13.0, statsmodels 0.14.2" */
  engine: string
  /** Why no comparison was made (unavailable only) */
  note: string | null
  checks: CrossCheckItem[]
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isItem(v: unknown): v is CrossCheckItem {
  return isRecord(v) && typeof v.label === 'string' && typeof v.r === 'number' && Number.isFinite(v.r) &&
    (v.python === null || (typeof v.python === 'number' && Number.isFinite(v.python))) &&
    typeof v.agree === 'boolean' && (v.python !== null || !v.agree) &&
    typeof v.rel_tolerance === 'number' && v.rel_tolerance > 0
}

/** Accepts only results whose status is consistent with their checks, so the badge cannot overstate agreement. */
export function isCrossCheck(v: unknown): v is CrossCheck {
  if (!isRecord(v) || typeof v.engine !== 'string' || !(v.note === null || typeof v.note === 'string')) return false
  if (!Array.isArray(v.checks) || !v.checks.every(isItem)) return false
  const checks = v.checks as CrossCheckItem[]
  if (v.status === 'agree') return checks.length > 0 && checks.every((c) => c.agree)
  if (v.status === 'disagree') return checks.some((c) => !c.agree)
  return v.status === 'unavailable' && checks.length === 0
}

export function disagreements(cc: CrossCheck): CrossCheckItem[] {
  return cc.checks.filter((c) => !c.agree)
}

/** One plain sentence for reports and exports. */
export function crossCheckSummary(cc: CrossCheck): string {
  const total = cc.checks.length
  if (cc.status === 'agree') {
    return `Python cross-check (${cc.engine}): all ${total} recomputed values agree with R.`
  }
  if (cc.status === 'disagree') {
    const bad = disagreements(cc)
    return `Python cross-check (${cc.engine}): ${bad.length} of ${total} recomputed values differ from R (${bad.map((c) => c.label).join('; ')}). Review before relying on this result.`
  }
  return `Python cross-check not available${cc.note ? `: ${cc.note}` : '.'}`
}
