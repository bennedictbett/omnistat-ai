import type { ITableCellBorders, ParagraphChild } from 'docx'
import { apaStatement, apaTables, ApaRun, ApaTable } from './apa'
import { explainResult, explanationText } from './explainResult'
import { formatNumber, isPKey, prettyKey, RRunResult } from './rApi'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const MAX_FIGURE_WIDTH = 600
const ITALIC_HEADERS = new Set(['n', 'M', 'SD', 'Mdn', 'Q1', 'Q3', 'Mdiff', 'padj'])

export function decodePng(b64: string): { data: Uint8Array; width: number; height: number } | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null
  let binary: string
  try {
    binary = atob(b64)
  } catch {
    return null
  }
  const data = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  if (data.length < 24 || !PNG_SIGNATURE.every((byte, i) => data[i] === byte)) return null
  const view = new DataView(data.buffer)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { data, width, height } : null
}

/** Builds an APA-style Word document in the browser; nothing is uploaded. */
export async function buildWordReport(
  result: RRunResult, valueLabels: Record<string, Record<string, string>> = {}, generatedAt: Date = new Date(),
): Promise<Blob> {
  if (!result.ok) throw new Error('Only successful analyses can be exported.')
  const {
    AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
  } = await import('docx')

  const runs = (items: ApaRun[]) => items.map((r) => new TextRun({
    text: r.text, italics: r.italic, superScript: r.superscript, subScript: r.subscript,
  }))
  const para = (children: ParagraphChild[] | string, options: { italic?: boolean } = {}) => new Paragraph({
    children: typeof children === 'string' ? [new TextRun({ text: children, italics: options.italic })] : children,
    spacing: { after: 120 },
  })
  const heading = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } })
  const rule = { style: BorderStyle.SINGLE, size: 8, color: '000000' }
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }

  const apaTable = (table: ApaTable, number: number) => {
    const cellBorders = (top: boolean, bottom: boolean): ITableCellBorders => ({
      top: top ? rule : none, bottom: bottom ? rule : none, left: none, right: none,
    })
    const row = (cells: string[], header: boolean, last: boolean) => new TableRow({
      tableHeader: header,
      children: cells.map((text, i) => new TableCell({
        borders: cellBorders(header, header || last),
        children: [new Paragraph({
          alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.CENTER,
          children: header && ITALIC_HEADERS.has(text)
            ? [new TextRun({ text: text.replace(/(diff|adj)$/, ''), italics: true }),
              ...(/(diff|adj)$/.test(text) ? [new TextRun({ text: text.match(/(diff|adj)$/)![0], subScript: true })] : [])]
            : [new TextRun({ text })],
        })],
      })),
    })
    return [
      new Paragraph({ children: [new TextRun({ text: `Table ${number}`, bold: true })], spacing: { before: 240 } }),
      para(table.title, { italic: true }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
        rows: [row(table.columns, true, false), ...table.rows.map((cells, i) => row(cells, false, i === table.rows.length - 1))],
      }),
      ...(table.note ? [para([new TextRun({ text: 'Note. ', italics: true }), new TextRun(table.note)])] : []),
    ]
  }

  const r = result.results
  const testName = typeof r.test === 'string' ? r.test : result.title
  const plan = result.analysis_plan
  const groupLabels = valueLabels[result.variables.group ?? result.variables.var1 ?? ''] ?? {}
  const body: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = []

  body.push(new Paragraph({ text: `OmniStat Analysis Report: ${result.title}`, heading: HeadingLevel.TITLE }))
  body.push(para(`Generated ${generatedAt.toISOString()} from the displayed result. This automatically generated report can contain sensitive information and is not a signed attestation. Review it with a qualified statistician before use.`, { italic: true }))

  body.push(heading('Results'))
  const statement = apaStatement(result)
  if (statement) body.push(para([new TextRun(`${testName}: `), ...runs(statement), new TextRun('.')]))
  const explanation = explainResult(result, valueLabels)
  if (explanation) {
    explanation.paragraphs.forEach((p) => body.push(para(explanationText(p))))
    explanation.caveats.forEach((c) => body.push(new Paragraph({ text: explanationText(c), bullet: { level: 0 } })))
  }
  const tables = apaTables(result, groupLabels)
  if (!statement) {
    const scalars = Object.entries(r).filter(([k, v]) => k !== 'test' && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'))
    if (scalars.length) {
      tables.unshift({ title: 'Results', columns: ['Statistic', 'Value'], rows: scalars.map(([k, v]) => [
        prettyKey(k), typeof v === 'number' ? formatNumber(v, isPKey(k)) : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)]) })
    }
  }
  tables.forEach((table, i) => body.push(...apaTable(table, i + 1)))

  body.push(heading('Method'))
  const method = [
    `Procedure: ${result.title}.`,
    `Engine: R${result.r_version ? ` (${result.r_version})` : ' (version not recorded)'}.`,
    `Columns: ${Object.entries(result.variables).map(([role, col]) => `${prettyKey(role)} = ${col}`).join('; ')}.`,
    `Data SHA-256: ${result.data_sha256 ?? 'not recorded'}.`,
  ]
  if (plan) {
    method.push(`Rows selected: ${plan.rows_total}; used: ${plan.rows_used}; excluded for missing values: ${plan.rows_dropped_missing} (complete cases across selected columns).`)
  }
  method.forEach((line) => body.push(para(line)))
  if (plan?.assumptions.length) {
    body.push(para('Declared assumptions (not all checked automatically):'))
    plan.assumptions.forEach((a) => body.push(new Paragraph({ text: a, bullet: { level: 0 } })))
  }

  const figures = result.plots.map(decodePng)
  if (figures.length) {
    body.push(heading('Figures'))
    figures.forEach((png, i) => {
      body.push(new Paragraph({ children: [new TextRun({ text: `Figure ${i + 1}`, bold: true })], spacing: { before: 240 } }))
      body.push(para(`${result.title}, chart ${i + 1}`, { italic: true }))
      if (!png) {
        body.push(para('This chart could not be included because its image data was invalid.'))
        return
      }
      const scale = Math.min(1, MAX_FIGURE_WIDTH / png.width)
      body.push(new Paragraph({ children: [new ImageRun({
        type: 'png', data: png.data,
        transformation: { width: Math.round(png.width * scale), height: Math.round(png.height * scale) },
        altText: { name: `Figure ${i + 1}`, description: `${result.title} chart ${i + 1}`, title: `Figure ${i + 1}` },
      })] }))
    })
  }

  if (result.code) {
    body.push(heading('Appendix: R Script'))
    result.code.split('\n').forEach((line) => body.push(new Paragraph({
      children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 18 })],
    })))
  }

  const doc = new Document({
    creator: 'OmniStat AI',
    title: `OmniStat Analysis Report: ${result.title}`,
    styles: { default: { document: { run: { font: 'Times New Roman', size: 24 } } } },
    sections: [{ children: body }],
  })
  return Packer.toBlob(doc)
}

export function downloadWordReport(blob: Blob, title: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `omnistat-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'report'}.docx`
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Let the browser start the download before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
}
