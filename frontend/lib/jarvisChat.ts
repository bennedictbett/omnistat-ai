import { API_URL } from './config'
import { requestJson, ApiError } from './api'
import { loadUploadedData, UploadedData } from './rApi'

export type ChatRole = 'user' | 'assistant'

export interface ChatTurn {
  role: ChatRole
  content: string
}

export type JarvisAction =
  | { type: 'run_analysis'; test: string; variables: Record<string, string> }
  | { type: 'descriptive'; columns: string[] }
  | { type: 'choose_test'; options: { test: string; title: string; reason: string }[] }

export interface JarvisChatReply {
  reply: string
  action: JarvisAction | null
  action_problem: string | null
}

export interface DatasetContext {
  rows: number
  columns: { name: string; type: 'numeric' | 'categorical'; distinct: number; label?: string }[]
}

export const SHARE_COLUMNS_KEY = 'omnistat_jarvis_share_columns'
const MAX_DISTINCT_SCAN = 50_000
const MAX_COLUMNS = 300

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringMap = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.entries(v).every(([k, x]) => typeof k === 'string' && typeof x === 'string')

export function shareColumnsEnabled(): boolean {
  return typeof window === 'undefined' || window.localStorage.getItem(SHARE_COLUMNS_KEY) !== 'false'
}

export function setShareColumns(enabled: boolean): void {
  window.localStorage.setItem(SHARE_COLUMNS_KEY, enabled ? 'true' : 'false')
}

/** Column names, types, distinct counts and labels only: no data values leave the browser. */
export function datasetContext(data: UploadedData): DatasetContext {
  const sample = data.rows.slice(0, MAX_DISTINCT_SCAN)
  return {
    rows: data.rows.length,
    columns: data.columns.slice(0, MAX_COLUMNS).map((name) => {
      const distinct = new Set(sample.map((row) => row[name]).filter((v) => v !== null && v !== undefined && v !== '')).size
      const label = data.variableLabels[name]
      return {
        name: name.slice(0, 200),
        type: data.numericCols.includes(name) ? 'numeric' as const : 'categorical' as const,
        distinct,
        ...(label ? { label: label.slice(0, 200) } : {}),
      }
    }),
  }
}

function isAction(v: unknown): v is JarvisAction {
  if (!isRecord(v)) return false
  if (v.type === 'run_analysis') return typeof v.test === 'string' && isStringMap(v.variables)
  if (v.type === 'descriptive') return Array.isArray(v.columns) && v.columns.every((c) => typeof c === 'string')
  if (v.type === 'choose_test') {
    return Array.isArray(v.options) && v.options.length > 0 && v.options.every((o) =>
      isRecord(o) && typeof o.test === 'string' && typeof o.title === 'string' && typeof o.reason === 'string')
  }
  return false
}

export async function chatWithJarvis(history: ChatTurn[], data: UploadedData | null, shareColumns: boolean): Promise<JarvisChatReply> {
  let response: Response
  try {
    response = await fetch(`${API_URL}/api/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: history.map((t) => ({ role: t.role, content: t.content.slice(0, 2000) })),
        ...(data && shareColumns ? { dataset: datasetContext(data) } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new ApiError('Could not reach Jarvis. Check your connection and try again. The first message after a quiet period can take up to a minute.')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ApiError(`Jarvis returned an unreadable response (HTTP ${response.status}). Please try again.`)
  }
  if (!response.ok) {
    const detail = isRecord(body) && typeof body.detail === 'string' ? body.detail : null
    if (response.status === 429) throw new ApiError('You are sending messages too quickly. Wait a moment and try again.')
    throw new ApiError(detail ?? `Jarvis could not answer (HTTP ${response.status}). Please try again.`)
  }
  if (!isRecord(body) || typeof body.reply !== 'string' ||
    !(body.action === null || isAction(body.action)) ||
    !(body.action_problem === null || typeof body.action_problem === 'string')) {
    throw new ApiError('Jarvis returned an invalid response. Please try again.')
  }
  return body as unknown as JarvisChatReply
}

export interface DescriptiveRow {
  column: string
  count: number
  mean: number
  median: number
  std: number
  min: number
  max: number
  q1: number
  q3: number
}

const DESCRIPTIVE_FIELDS = ['count', 'mean', 'median', 'std', 'min', 'max', 'q1', 'q3'] as const

/** Runs the existing descriptive endpoint on all finite values of each column. */
export async function runDescriptives(columns: string[], data?: UploadedData | null): Promise<DescriptiveRow[]> {
  const dataset = data ?? loadUploadedData()
  if (!dataset) throw new ApiError('Upload your data first. No statistics were calculated.')
  const rows: DescriptiveRow[] = []
  for (const column of columns) {
    const values = dataset.rows.map((row) => row[column])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    if (values.length < 2) throw new ApiError(`"${column}" has fewer than two numeric values, so descriptive statistics cannot be calculated.`)
    const result = await requestJson<unknown>('/api/analytics/descriptive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values, column }),
    })
    if (!isRecord(result) || !DESCRIPTIVE_FIELDS.every((f) => typeof result[f] === 'number' && Number.isFinite(result[f]))) {
      throw new ApiError(`The server returned invalid descriptive statistics for "${column}".`)
    }
    rows.push({ column, ...Object.fromEntries(DESCRIPTIVE_FIELDS.map((f) => [f, result[f] as number])) } as DescriptiveRow)
  }
  return rows
}
