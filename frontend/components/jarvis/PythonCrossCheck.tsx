import { CrossCheck, CrossCheckItem, disagreements } from '@/lib/crossCheck'

/** Seven significant figures, so a real difference between the engines is visible. */
function formatCompared(n: number | null): string {
  if (n === null) return 'not computed'
  const abs = Math.abs(n)
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e7)) return n.toExponential(4)
  return String(Number(n.toPrecision(7)))
}

const STYLE = {
  agree: { text: 'text-green-400', box: 'border-green-500/20 bg-green-500/5' },
  disagree: { text: 'text-amber-400', box: 'border-amber-500/30 bg-amber-500/5' },
  unavailable: { text: 'text-gray-400', box: 'border-gray-700 bg-gray-800/40' },
} as const

function headline(cc: CrossCheck): string {
  if (cc.status === 'agree') return `Python cross-check: agrees with R on all ${cc.checks.length} values`
  if (cc.status === 'disagree') {
    return `Python cross-check: ${disagreements(cc).length} of ${cc.checks.length} values differ from R`
  }
  return 'Python cross-check: not available'
}

function Row({ item }: { item: CrossCheckItem }) {
  return (
    <tr className={item.agree ? 'text-gray-300' : 'text-amber-300'}>
      <td className="py-1 pr-3">{item.label}</td>
      <td className="py-1 pr-3 text-right font-mono">{formatCompared(item.r)}</td>
      <td className="py-1 pr-3 text-right font-mono">{formatCompared(item.python)}</td>
      <td className="py-1 text-right">{item.agree ? 'Agree' : 'Differ'}</td>
    </tr>
  )
}

/** Shows whether an independent Python computation reproduces the R numbers. */
export default function PythonCrossCheck({ crossCheck: cc }: { crossCheck: CrossCheck }) {
  const style = STYLE[cc.status]
  const differing = disagreements(cc)
  return (
    <section aria-label="Python cross-check" className={`rounded-lg border p-4 text-xs space-y-2 ${style.box}`}>
      <p className={`text-sm font-medium ${style.text}`} role={cc.status === 'disagree' ? 'alert' : undefined}>
        {headline(cc)}
      </p>
      {cc.status === 'unavailable' && <p className="text-gray-400">{cc.note ?? 'No comparison was made.'}</p>}
      {cc.status === 'disagree' && (
        <p className="text-gray-300">
          R and Python computed different numbers for the rows below. R remains the reported result. Check the data and
          the chosen columns, and treat this result with caution until the difference is explained.
        </p>
      )}
      {cc.status === 'agree' && (
        <p className="text-gray-400">
          Statistics, p-values and intervals were recomputed independently and match R within a tight tolerance. This
          confirms the arithmetic, not that the method suits your data.
        </p>
      )}
      {cc.checks.length > 0 && (
        <details open={cc.status === 'disagree'}>
          <summary className="cursor-pointer text-gray-400">
            {cc.status === 'disagree' ? `All ${cc.checks.length} compared values` : 'Compared values'}
          </summary>
          <table className="mt-2 w-full">
            <thead>
              <tr className="text-gray-500">
                <th className="pr-3 text-left font-normal">Value</th>
                <th className="pr-3 text-right font-normal">R</th>
                <th className="pr-3 text-right font-normal">Python</th>
                <th className="text-right font-normal">Result</th>
              </tr>
            </thead>
            <tbody>
              {[...differing, ...cc.checks.filter((c) => c.agree)].map((item) => (
                <Row key={item.label} item={item} />
              ))}
            </tbody>
          </table>
        </details>
      )}
      <p className="text-[11px] text-gray-500">{cc.engine}</p>
    </section>
  )
}
