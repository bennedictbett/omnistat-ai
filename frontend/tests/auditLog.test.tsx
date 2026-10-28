import { createHash } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import AuditLog, { AuditFailureBanner } from '@/components/audit/AuditLog'
import {
  analysisAuditFields, audit, exportAuditLog, listAuditEvents, recordAudit, sha256Hex, verifyAuditChain,
} from '@/lib/audit'
import type { RRunResult } from '@/lib/rApi'

const mocks = vi.hoisted(() => ({
  configured: true,
  session: { user: { id: 'alice' } } as unknown,
  insert: vi.fn(),
  range: vi.fn(),
  rpc: vi.fn(),
  calls: [] as unknown[][],
}))
vi.mock('@/lib/supabase', () => ({
  getSupabase: () => mocks.configured ? {
    auth: { getSession: async () => ({ data: { session: mocks.session } }) },
    from: (table: string) => {
      const query = {
        insert: (row: unknown) => { mocks.calls.push([table, 'insert', row]); return mocks.insert(row) },
        select: (cols: string) => { mocks.calls.push([table, 'select', cols]); return query },
        order: (col: string, opts: unknown) => { mocks.calls.push([table, 'order', col, opts]); return query },
        range: (from: number, to: number) => { mocks.calls.push([table, 'range', from, to]); return mocks.range(from, to) },
      }
      return query
    },
    rpc: mocks.rpc,
  } : null,
}))

const event = (seq: number, extra = {}) => ({
  event_id: `e${seq}`, seq, created_at: '2026-10-28T12:00:00Z', action: 'run_analysis', procedure: 'shapiro_wilk',
  engine: 'R: R version 4.6.1', spec_hash: null, dataset_hash: 'a'.repeat(64), code_hash: 'b'.repeat(64),
  warnings: [], result_bundle_id: null, details: { ok: true }, prev_hash: '0'.repeat(64), hash: `${seq}`.padStart(64, 'c'),
  ...extra,
})

const result: RRunResult = {
  ok: true, test: 'independent_t_test', title: 'Welch', variables: { outcome: 'bp', group: 'arm' },
  results: { p_value: 0.4, model_warnings: ['x'.repeat(500)] }, error: null, plots: [], timed_out: false, duration_s: 0.1,
  code: 't.test(bp ~ arm)', r_version: 'R version 4.6.1', data_sha256: 'd'.repeat(64),
}

beforeEach(() => {
  mocks.configured = true
  mocks.session = { user: { id: 'alice' } }
  mocks.calls = []
  mocks.insert.mockReset().mockResolvedValue({ error: null })
  mocks.range.mockReset().mockResolvedValue({ data: [], error: null })
  mocks.rpc.mockReset().mockResolvedValue({ data: [{ ok: true, events: 2, first_invalid_seq: null, reason: null }], error: null })
})
afterEach(cleanup)

it('fingerprints code and plans without storing them', async () => {
  const fields = await analysisAuditFields(result)
  expect(fields.code_hash).toBe(createHash('sha256').update('t.test(bp ~ arm)').digest('hex'))
  expect(fields.dataset_hash).toBe('d'.repeat(64))
  expect(fields.spec_hash).toBeNull()
  expect(fields.engine).toBe('R: R version 4.6.1')
  expect(fields.warnings![0].length).toBe(301)
  expect(JSON.stringify(fields)).not.toContain('t.test')
  const plan = { schema_version: '1.0' } as unknown as RRunResult['analysis_plan']
  expect((await analysisAuditFields({ ...result, analysis_plan: plan })).spec_hash)
    .toBe(createHash('sha256').update(JSON.stringify(plan)).digest('hex'))
  expect((await analysisAuditFields({ ...result, data_sha256: 'not-a-hash' })).dataset_hash).toBeNull()
  expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(createHash('sha256').update('abc').digest('hex'))
})

it('records only for signed-in users and sends no chain fields', async () => {
  mocks.configured = false
  expect(await recordAudit({ action: 'export' })).toBe(false)
  mocks.configured = true
  mocks.session = null
  expect(await recordAudit({ action: 'export' })).toBe(false)
  expect(mocks.insert).not.toHaveBeenCalled()
  mocks.session = { user: { id: 'alice' } }
  expect(await recordAudit({ action: 'export', details: { format: 'docx' } })).toBe(true)
  const row = mocks.insert.mock.calls[0][0]
  expect(row).toEqual({
    action: 'export', procedure: null, engine: null, spec_hash: null, dataset_hash: null, code_hash: null,
    warnings: [], result_bundle_id: null, details: { format: 'docx' },
  })
  mocks.insert.mockResolvedValue({ error: { message: 'denied' } })
  await expect(recordAudit({ action: 'export' })).rejects.toThrow('did not accept')
})

it('never interrupts the action and reports recording failures visibly', async () => {
  render(<AuditFailureBanner />)
  expect(() => audit(() => { throw new Error('boom') })).not.toThrow()
  expect((await screen.findByRole('alert')).textContent).toContain('could not be recorded (boom)')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('alert')).toBeNull()
  mocks.insert.mockResolvedValue({ error: { message: 'denied' } })
  act(() => audit(() => ({ action: 'run_analysis' })))
  expect((await screen.findByRole('alert')).textContent).toContain('did not accept')
})

it('lists, verifies and validates audit entries', async () => {
  mocks.range.mockResolvedValue({ data: [event(2), event(1)], error: null })
  expect((await listAuditEvents(1)).map((e) => e.seq)).toEqual([2, 1])
  expect(mocks.calls).toContainEqual(['audit_events', 'order', 'seq', { ascending: false }])
  expect(mocks.calls).toContainEqual(['audit_events', 'range', 50, 99])
  mocks.range.mockResolvedValue({ data: [{ ...event(1), hash: 'bad' }], error: null })
  await expect(listAuditEvents(0)).rejects.toThrow('invalid entries')
  expect(await verifyAuditChain()).toEqual({ ok: true, events: 2, first_invalid_seq: null, reason: null })
  mocks.rpc.mockResolvedValue({ data: null, error: { message: 'x' } })
  await expect(verifyAuditChain()).rejects.toThrow('Could not verify')
})

it('exports every entry with its verification and detects changes during export', async () => {
  mocks.range.mockResolvedValue({ data: [event(1), event(2)], error: null })
  const blob = await exportAuditLog()
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.readAsText(blob)
  })
  const exported = JSON.parse(text)
  expect(exported.verification.ok).toBe(true)
  expect(exported.events.map((e: { seq: number }) => e.seq)).toEqual([1, 2])
  expect(mocks.calls).toContainEqual(['audit_events', 'order', 'seq', { ascending: true }])
  mocks.range.mockResolvedValue({ data: [event(1)], error: null })
  await expect(exportAuditLog()).rejects.toThrow('changed during export')
})

it('shows entries and the integrity result', async () => {
  mocks.range.mockResolvedValue({ data: [event(2, { action: 'export', details: { format: 'docx' } }), event(1, { details: { ok: false } })], error: null })
  render(<AuditLog />)
  expect(await screen.findByText('Exported (docx)')).toBeTruthy()
  expect(screen.getByText('Ran analysis — failed')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Verify integrity' }))
  expect((await screen.findByRole('status')).textContent).toContain('all 2 entries are intact')
  mocks.rpc.mockResolvedValue({ data: [{ ok: false, events: 2, first_invalid_seq: 2, reason: 'The entry contents were changed.' }], error: null })
  fireEvent.click(screen.getByRole('button', { name: 'Verify integrity' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('failed at entry 2: The entry contents were changed.'))
})
