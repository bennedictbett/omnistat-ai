import { API_URL } from './config'
import { DataAudit, isDataAudit } from './dataAudit'

export class ApiError extends Error {}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, init)
  } catch {
    throw new ApiError('Could not connect to the analysis server. Check your connection and API configuration.')
  }
  if (!response.ok) {
    throw new ApiError(`The analysis server rejected the request (HTTP ${response.status}). Please check your input or try again.`)
  }
  try {
    return await response.json() as T
  } catch {
    throw new ApiError('The analysis server returned an unreadable response. Please try again.')
  }
}

export interface UploadResult {
  audit?: DataAudit
  rows: number
  columns: string[]
  numeric_cols: string[]
  full_data: Record<string, unknown>[]
  missing: Record<string, number>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function uploadDataset(file: File): Promise<UploadResult> {
  const form = new FormData()
  form.append('file', file)
  const data = await requestJson<unknown>('/api/analytics/upload', { method: 'POST', body: form })
  if (!isUploadResult(data)) {
    throw new ApiError('The server did not return a complete dataset. Upload a non-empty CSV or Excel file again.')
  }
  return data
}

export function isUploadResult(data: unknown): data is UploadResult {
  if (!isRecord(data)) return false
  const columns = data.columns
  return typeof data.rows === 'number' && Number.isInteger(data.rows) && data.rows > 0 &&
    Array.isArray(columns) && columns.length > 0 && columns.every((c) => typeof c === 'string') &&
    Array.isArray(data.numeric_cols) && data.numeric_cols.every((c) => typeof c === 'string') &&
    Array.isArray(data.full_data) && data.full_data.length === data.rows && data.full_data.every(isRecord) &&
    isRecord(data.missing) && Object.values(data.missing).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
    (data.audit === undefined || (isDataAudit(data.audit) && data.audit.rows === data.rows &&
      data.audit.columns.length === columns.length &&
      data.audit.columns.every((column, index) => column.column === columns[index])))
}

export interface JarvisIntent {
  test: string
  variables?: string[]
  assumptions?: string[]
  visualization?: string
}

export interface JarvisResponse {
  success: boolean
  intent?: JarvisIntent
  error?: string
  needs_clarification?: boolean
  groq_failed?: boolean
  options?: { intent: string; confidence: number }[]
}

export async function queryJarvis(query: string): Promise<JarvisResponse> {
  const data = await requestJson<unknown>('/api/agent/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })
  if (!isRecord(data) || typeof data.success !== 'boolean') {
    throw new ApiError('The assistant returned an invalid response. Please try again.')
  }
  if (!data.success) {
    throw new ApiError(typeof data.error === 'string' ? data.error : 'The assistant could not interpret your question.')
  }
  if (data.needs_clarification === true) {
    return { success: true, needs_clarification: true }
  }
  if (data.groq_failed === true) {
    throw new ApiError('The assistant could not prepare a complete analysis plan. Try again, or use the Test Wizard to select an analysis.')
  }
  const intent = data.intent
  if (!isRecord(intent) || typeof intent.test !== 'string' || !intent.test.trim()) {
    throw new ApiError('The assistant did not select an analysis. Rephrase your question or use the Test Wizard.')
  }
  for (const key of ['variables', 'assumptions']) {
    if (intent[key] !== undefined && (!Array.isArray(intent[key]) || !intent[key].every((v) => typeof v === 'string'))) {
      throw new ApiError('The assistant returned an invalid analysis plan. Please try again.')
    }
  }
  return {
    success: true,
    intent: {
      test: intent.test,
      variables: Array.isArray(intent.variables) ? intent.variables : [],
      assumptions: Array.isArray(intent.assumptions) ? intent.assumptions : [],
      visualization: typeof intent.visualization === 'string' ? intent.visualization : undefined,
    },
  }
}