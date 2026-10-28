import { AlertTriangle, CheckCircle2, Info, MinusCircle } from 'lucide-react'
import { AssumptionCheck, AssumptionReport } from '@/lib/rApi'

const STATUS = {
  ok: { icon: CheckCircle2, label: 'No concern', className: 'text-green-400' },
  warning: { icon: AlertTriangle, label: 'Review', className: 'text-yellow-400' },
  info: { icon: Info, label: 'Information', className: 'text-blue-400' },
  not_assessed: { icon: MinusCircle, label: 'Not assessed', className: 'text-gray-500' },
} satisfies Record<AssumptionCheck['status'], unknown>

export default function AssumptionChecks({ report, error }: { report: AssumptionReport | null; error: string | null }) {
  if (error) {
    return (
      <div role="alert" className="rounded border border-yellow-500/30 p-3 text-yellow-400">
        Assumption checks are unavailable: {error} You can still run the analysis; review its built-in diagnostics.
      </div>
    )
  }
  if (!report) return null
  return (
    <section aria-label="Assumption checks" className="space-y-2">
      <h4 className="font-medium text-white">Assumption checks</h4>
      {report.checks.length > 0 && (
        <ul className="space-y-1">
          {report.checks.map((check) => {
            const { icon: Icon, label, className } = STATUS[check.status]
            return (
              <li key={check.id} className="flex items-start gap-2">
                <Icon size={14} className={`mt-1 shrink-0 ${className}`} aria-hidden />
                <span>
                  <span className="text-white">{check.label}</span>{' '}
                  <span className={`text-xs ${className}`}>({label})</span>
                  <span className="block text-xs text-gray-400">{check.detail}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {report.suggestion && (
        <div role="note" className="rounded border border-yellow-500/30 bg-yellow-500/5 p-3">
          <p className="font-medium text-yellow-400">Consider: {report.suggestion.title}</p>
          <p className="text-xs text-gray-300">{report.suggestion.reason}</p>
          {report.suggestion.test && (
            <p className="text-xs text-gray-400">
              To use it, choose it in the Test Wizard or ask Jarvis. You can also continue with this plan.
            </p>
          )}
        </div>
      )}
      <ul className="list-disc pl-5 text-xs text-gray-500">
        {report.notes.map((note) => <li key={note}>{note}</li>)}
      </ul>
    </section>
  )
}
