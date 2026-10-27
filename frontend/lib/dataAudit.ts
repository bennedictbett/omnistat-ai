export interface ColumnAudit {
  column: string
  missing_count: number
  missing_percent: number
  blank_text_count: number
  empty: boolean
  constant: boolean
  numeric_text_count: number
  numeric_looking_text: boolean
  non_finite_count: number
}

export interface DataAudit {
  version: '1.0'
  rows: number
  duplicate_rows: number
  columns: ColumnAudit[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isDataAudit(value: unknown): value is DataAudit {
  if (!isRecord(value)) return false
  const rows = value.rows
  return value.version === '1.0' &&
    typeof rows === 'number' && Number.isInteger(rows) && rows > 0 &&
    typeof value.duplicate_rows === 'number' && Number.isInteger(value.duplicate_rows) &&
    value.duplicate_rows >= 0 && value.duplicate_rows < rows &&
    Array.isArray(value.columns) && value.columns.every((column) =>
      isRecord(column) && typeof column.column === 'string' &&
      ['missing_count', 'blank_text_count', 'numeric_text_count', 'non_finite_count'].every((key) =>
        typeof column[key] === 'number' && Number.isInteger(column[key]) && column[key] >= 0 && column[key] <= rows) &&
      typeof column.missing_percent === 'number' && Number.isFinite(column.missing_percent) &&
      column.missing_percent >= 0 && column.missing_percent <= 100 &&
      ['empty', 'constant', 'numeric_looking_text'].every((key) => typeof column[key] === 'boolean'))
}
