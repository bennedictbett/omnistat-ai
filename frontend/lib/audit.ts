import { useSyncExternalStore } from 'react'
import type { RRunResult } from './rApi'
import { getSupabase } from './supabase'

export type AuditAction = 'upload_data' | 'run_analysis' | 'save_history' | 'export' | 'ai_suggestion_accepted'

export interface AuditInput {
  action: AuditAction
  procedure?: string | null
  engine?: string | null
  spec_hash?: string | null
  dataset_hash?: string | null
  code_hash?: string | null
  warnings?: string[]
  result_bundle_id?: string | null
  details?: Record<string, unknown>
}

export interface AuditEvent extends Required<Omit<AuditInput, 'details' | 'warnings'>> {
  event_id: string
  seq: number
  created_at: string
  warnings: string[]
  details: Record<string, unknown>
  prev_hash: string
  hash: string
}

export interface ChainVerification {
  ok: boolean
  events: number
  first_invalid_seq: number | null
  reason: string | null
}

const HASH = /^[0-9a-f]{64}$/
export const AUDIT_PAGE_SIZE = 50
const MAX_TEXT = 300
const AUDIT_COLUMNS = 'event_id,seq,created_at,action,procedure,engine,spec_hash,dataset_hash,code_hash,warnings,result_bundle_id,details,prev_hash,hash'

// ---------- Failure notices shown once, app-wide ----------

let failure: string | null = null
const listeners = new Set<() => void>()
function setFailure(message: string | null) {
  failure = message
  listeners.forEach((listener) => listener())
}
export function useAuditFailure(): [string | null, () => void] {
  const message = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    () => failure, () => null,
  )
  return [message, () => setFailure(null)]
}

// ---------- Hashing ----------

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

const clip = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text)

/** Audit fields for an R run; hashes identify the plan, data and code without storing them. */
export async function analysisAuditFields(result: RRunResult): Promise<AuditInput> {
  const warnings = ['warnings', 'model_warnings']
    .flatMap((key) => (Array.isArray(result.results?.[key]) ? result.results[key] as unknown[] : []))
    .filter((w): w is string => typeof w === 'string').slice(0, 20).map(clip)
  return {
    action: 'run_analysis',
    procedure: result.test,
    engine: result.r_version ? clip(`R: ${result.r_version}`) : 'R (version not recorded)',
    spec_hash: result.analysis_plan ? await sha256Hex(JSON.stringify(result.analysis_plan)) : null,
    dataset_hash: result.data_sha256 && HASH.test(result.data_sha256) ? result.data_sha256 : null,
    code_hash: result.code ? await sha256Hex(result.code) : null,
    warnings,
    details: {
      ok: result.ok, timed_out: result.timed_out, variables: result.variables,
      ...(result.error ? { error: clip(result.error) } : {}),
    },
  }
}

// ---------- Recording ----------

/** Records an event for the signed-in user. Returns false when signed out (nothing is recorded). */
export async function recordAudit(event: AuditInput): Promise<boolean> {
  const supabase = getSupabase()
  if (!supabase) return false
  const { data } = await supabase.auth.getSession()
  if (!data.session) return false
  const { error } = await supabase.from('audit_events').insert({
    action: event.action,
    procedure: event.procedure ?? null,
    engine: event.engine ?? null,
    spec_hash: event.spec_hash ?? null,
    dataset_hash: event.dataset_hash ?? null,
    code_hash: event.code_hash ?? null,
    warnings: event.warnings ?? [],
    result_bundle_id: event.result_bundle_id ?? null,
    details: event.details ?? {},
  })
  if (error) throw new Error('The audit log did not accept this entry.')
  return true
}

/** Fire-and-forget recording; runs later so it can never interrupt the user's action, and surfaces failures visibly. */
export function audit(build: () => AuditInput | Promise<AuditInput>): void {
  Promise.resolve().then(build).then(recordAudit).catch((e) => {
    setFailure(`An audit log entry could not be recorded (${e instanceof Error ? e.message : 'unknown error'}). Your work is unaffected; check your connection and sign-in.`)
  })
}

// ---------- Reading and verification ----------

function isAuditEvent(v: unknown): v is AuditEvent {
  if (typeof v !== 'object' || v === null) return false
  const e = v as Record<string, unknown>
  return typeof e.event_id === 'string' && typeof e.seq === 'number' && typeof e.created_at === 'string' &&
    typeof e.action === 'string' && typeof e.hash === 'string' && HASH.test(e.hash) &&
    typeof e.prev_hash === 'string' && HASH.test(e.prev_hash) && Array.isArray(e.warnings) &&
    typeof e.details === 'object' && e.details !== null
}

function signedInClient() {
  const supabase = getSupabase()
  if (!supabase) throw new Error('Cloud features are not configured.')
  return supabase
}

export async function listAuditEvents(page: number): Promise<AuditEvent[]> {
  const { data, error } = await signedInClient().from('audit_events').select(AUDIT_COLUMNS)
    .order('seq', { ascending: false }).range(page * AUDIT_PAGE_SIZE, (page + 1) * AUDIT_PAGE_SIZE - 1)
  if (error) throw new Error('Could not load the audit log. Check your connection and try again.')
  if (!Array.isArray(data) || !data.every(isAuditEvent)) throw new Error('The audit service returned invalid entries.')
  return data
}

export async function verifyAuditChain(): Promise<ChainVerification> {
  const { data, error } = await signedInClient().rpc('verify_audit_chain')
  const row = Array.isArray(data) ? data[0] : null
  if (error || !row || typeof row.ok !== 'boolean' || typeof row.events !== 'number') {
    throw new Error('Could not verify the audit log. Check your connection and try again.')
  }
  return row as ChainVerification
}

/** Exports every entry with the verification result, oldest first. */
export async function exportAuditLog(): Promise<Blob> {
  const verification = await verifyAuditChain()
  const events: AuditEvent[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await signedInClient().from('audit_events').select(AUDIT_COLUMNS)
      .order('seq', { ascending: true }).range(from, from + 999)
    if (error) throw new Error('Could not export the audit log. Check your connection and try again.')
    if (!Array.isArray(data) || !data.every(isAuditEvent)) throw new Error('The audit service returned invalid entries.')
    events.push(...data)
    if (data.length < 1000) break
  }
  if (events.length !== verification.events) {
    throw new Error('The audit log changed during export. Try again.')
  }
  return new Blob([JSON.stringify({
    exported_at: new Date().toISOString(),
    verification,
    note: 'Hashes are SHA-256 over each entry and the previous hash, computed by the database. Keep exported copies: comparing event counts detects removal of the newest entries.',
    events,
  }, null, 2)], { type: 'application/json' })
}
