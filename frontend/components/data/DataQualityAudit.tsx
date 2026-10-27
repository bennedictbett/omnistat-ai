import { isDataAudit } from '@/lib/dataAudit'

export default function DataQualityAudit({ audit }: { audit: unknown }) {
  if (audit === undefined) {
    return <section aria-label="Data quality audit" className="rounded-lg border border-gray-700 p-4 text-sm text-gray-400">
      Data quality audit is unavailable for this saved upload. Upload your file again using the updated API.
    </section>
  }
  if (!isDataAudit(audit)) {
    return <p role="alert" className="text-sm text-red-400">The saved data quality audit is invalid or unsupported. Upload your file again.</p>
  }
  return (
    <section aria-label="Data quality audit" className="space-y-3 rounded-xl border border-yellow-500/30 bg-gray-900 p-4">
      <h3 className="font-medium text-white">Data Quality Audit</h3>
      <p className="text-sm text-gray-300">{audit.rows} parsed rows · {audit.duplicate_rows} duplicate rows beyond the first occurrence</p>
      <p className="text-xs text-gray-400">
        Review only: no rows are removed and no text columns are converted. Missing values follow pandas import rules;
        whitespace-only text is counted separately. Numeric-looking text means at least 80% of populated cells are finite numeric text.
        Identifiers and codes may intentionally be text—review before converting.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-gray-300">
          <caption className="sr-only">Quality checks for each uploaded column</caption>
          <thead><tr>
            <th className="p-2">Column</th><th className="p-2">Missing</th>
            <th className="p-2">Blank text</th><th className="p-2">Review flags</th>
          </tr></thead>
          <tbody>{audit.columns.map((column) => {
            const flags = [
              column.empty ? 'Entirely empty' : column.constant ? 'Constant among populated cells' : '',
              column.numeric_looking_text ? `Numeric-looking text (${column.numeric_text_count} cells)` : '',
              column.non_finite_count ? `${column.non_finite_count} infinite values serialized as null` : '',
            ].filter(Boolean)
            return <tr key={column.column} className="border-t border-gray-800">
              <th className="p-2 font-mono font-normal">{column.column}</th>
              <td className="p-2">{column.missing_count} ({column.missing_percent}%)</td>
              <td className="p-2">{column.blank_text_count}</td>
              <td className="p-2">{flags.length ? flags.join(' · ') : 'No additional flags'}</td>
            </tr>
          })}</tbody>
        </table>
      </div>
      <p className="text-xs text-gray-400">Duplicate rows are exact matches across parsed columns, not necessarily duplicate patients. Infinite numeric values are represented as null in the API response; their original counts are reported above. This audit does not certify data quality or statistical assumptions.</p>
    </section>
  )
}
