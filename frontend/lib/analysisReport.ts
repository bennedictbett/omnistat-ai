import { asCurveFit, formatNumber, isPKey, prettyKey, RRunResult } from './rApi'

export const MAX_REPORT_TABLE_ROWS = 200
const CURVE_DETAIL_KEYS = new Set(['curve', 'points', 'residuals'])

const escapeHtml = (value: unknown) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function scalar(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'number') return formatNumber(v, isPKey(key))
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  return String(v)
}

function rows(pairs: [string, string][]): string {
  return `<table class="kv">${pairs.map(([k, v]) =>
    `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`
}

function compound(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isRecord)) {
      const records = value as Record<string, unknown>[]
      const cols = Array.from(new Set(records.flatMap(Object.keys)))
      const shown = records.slice(0, MAX_REPORT_TABLE_ROWS)
      const note = records.length > shown.length
        ? `<p class="note">Showing the first ${shown.length} of ${records.length} rows. The complete table is in the reproducibility ZIP.</p>`
        : ''
      return `<table class="grid"><thead><tr>${cols.map((c) => `<th>${escapeHtml(prettyKey(c))}</th>`).join('')}</tr></thead>` +
        `<tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(scalar(c, r[c]))}</td>`).join('')}</tr>`).join('')}</tbody></table>${note}`
    }
    if (value.every((x) => typeof x === 'string')) {
      return `<ul>${value.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    }
    return `<p>${escapeHtml(value.map((x) => scalar(key, x)).join(' to '))}</p>`
  }
  if (isRecord(value)) return rows(Object.entries(value).map(([k, v]) => [k, scalar(key, v)]))
  return ''
}

/** Builds a self-contained, script-free HTML report from a completed analysis. */
export function buildReportHtml(result: RRunResult, generatedAt: Date = new Date()): string {
  if (!result.ok) throw new Error('Only successful analyses can be reported.')
  const r = result.results
  const testName = typeof r.test === 'string' ? r.test : result.title
  const plan = result.analysis_plan
  const curveFit = asCurveFit(result) !== null

  const methods: [string, string][] = [
    ['Procedure', result.title],
    ['Engine', `R${result.r_version ? ` (${result.r_version})` : ' (version not recorded)'}`],
    ...Object.entries(result.variables).map(([role, col]): [string, string] => [`Column: ${prettyKey(role)}`, col]),
    ['Data SHA-256', result.data_sha256 ?? 'Not recorded'],
  ]
  if (plan) {
    methods.push(
      ['Rows selected / used / excluded (missing)', `${plan.rows_total} / ${plan.rows_used} / ${plan.rows_dropped_missing}`],
      ['Missing data', 'Complete cases across selected columns'],
    )
    if (plan.alternative) methods.push(['Alternative hypothesis', 'Two-sided'])
    if (plan.confidence_level !== null) methods.push(['Confidence level', `${plan.confidence_level * 100}%`])
    if (plan.equal_variances !== null) methods.push(['Variances', plan.equal_variances ? 'Equal variances assumed' : 'Unequal variances (Welch)'])
    for (const [group, n] of Object.entries(plan.group_counts)) methods.push([`Group "${group}" n`, String(n)])
  }

  const entries = Object.entries(r).filter(([k]) =>
    k !== 'test' && k !== 'p_value' && !(curveFit && CURVE_DETAIL_KEYS.has(k)))
  const p = typeof r.p_value === 'number' ? r.p_value : null
  const scalarRows: [string, string][] = entries
    .filter(([, v]) => !Array.isArray(v) && !isRecord(v))
    .map(([k, v]) => [prettyKey(k), scalar(k, v)])
  if (p !== null) {
    scalarRows.unshift(['p-value', `${formatNumber(p, true)}${p < 0.001 ? ` (${p.toExponential(2)})` : ''}; ${p < 0.05 ? 'p < 0.05' : 'p ≥ 0.05'} at the 0.05 level`])
  }
  const compoundSections = entries.filter(([, v]) => Array.isArray(v) || isRecord(v))
    .map(([k, v]) => `<h3>${escapeHtml(prettyKey(k))}</h3>${compound(k, v)}`).join('')
  const charts = result.plots.filter((b64) => /^[A-Za-z0-9+/]+={0,2}$/.test(b64))
  const skippedCharts = result.plots.length - charts.length

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${escapeHtml(`OmniStat report: ${result.title}`)}</title>
<style>
body{font:11pt/1.45 Georgia,serif;color:#111;margin:2cm;max-width:18cm}
h1{font-size:18pt;margin:0 0 .2em}h2{font-size:13pt;border-bottom:1px solid #999;margin-top:1.4em}h3{font-size:11pt}
.meta,.note{color:#555;font-size:9pt}.warning{border:1px solid #b45309;padding:.5em;font-size:9pt}
table{border-collapse:collapse;width:100%;margin:.4em 0;font:9pt/1.3 Helvetica,Arial,sans-serif}
th,td{border:1px solid #ccc;padding:3px 5px;text-align:left;vertical-align:top;word-break:break-word}
.kv th{width:38%;background:#f4f4f4;font-weight:normal}.grid th{background:#f4f4f4}
img{max-width:100%;border:1px solid #ccc;break-inside:avoid}tr{break-inside:avoid}
pre{white-space:pre-wrap;word-break:break-word;font:8pt/1.3 Menlo,monospace;background:#f6f6f6;padding:.6em}
@page{margin:1.5cm}@media print{body{margin:0}}
</style></head><body>
<h1>${escapeHtml(testName)}</h1>
<p class="meta">OmniStat AI analysis report · generated ${escapeHtml(generatedAt.toISOString())}</p>
<p class="warning">Automatically generated. Review the methods, assumptions and results with a qualified statistician before use.
This report can contain sensitive information, such as group labels or values in tables and charts. It is a snapshot of the displayed result, not a signed attestation.</p>
<h2>Methods</h2>${rows(methods)}
${plan ? `<h3>Declared assumptions (not all checked automatically)</h3><ul>${plan.assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>` : ''}
<h2>Results</h2>${scalarRows.length ? rows(scalarRows) : ''}${compoundSections}
${curveFit ? '<p class="note">Fitted-curve coordinates, data points and residuals are omitted; they are in the reproducibility ZIP.</p>' : ''}
${charts.length || skippedCharts ? `<h2>Charts</h2>${charts.map((b64, i) =>
    `<img src="data:image/png;base64,${b64}" alt="${escapeHtml(`${result.title} chart ${i + 1}`)}">`).join('')}` : ''}
${skippedCharts ? `<p class="note">${skippedCharts} chart(s) could not be included because the image data was invalid.</p>` : ''}
${result.code ? `<h2>Appendix: R script</h2><pre>${escapeHtml(result.code)}</pre>` : ''}
</body></html>`
}

/** Prints the report from an isolated, script-free frame so only the report is printed. */
export function printReport(html: string): Promise<void> {
  return new Promise((resolve, reject) => {
    document.getElementById('omnistat-report-frame')?.remove()
    const frame = document.createElement('iframe')
    frame.id = 'omnistat-report-frame'
    frame.title = 'Analysis report'
    frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    frame.onload = () => {
      try {
        const win = frame.contentWindow
        if (!win) throw new Error('No print window')
        win.addEventListener('afterprint', () => frame.remove(), { once: true })
        win.focus()
        win.print()
        resolve()
      } catch {
        frame.remove()
        reject(new Error('This browser could not open the print dialog. Try another browser, or use the reproducibility ZIP.'))
      }
    }
    frame.srcdoc = html
    document.body.appendChild(frame)
  })
}
