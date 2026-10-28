import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import SaveAnalysis from '@/components/history/SaveAnalysis'
import AccountControls from '@/components/accounts/AccountControls'
import AnalysisHistory from '@/components/history/AnalysisHistory'
import { deleteAnalysis, listAnalyses, openAnalysis, saveAnalysis } from '@/lib/history'
import type { RRunResult } from '@/lib/rApi'

const mocks = vi.hoisted(() => ({
  account: { user: { id: 'alice', email: 'alice@example.test' } as { id: string; email: string } | null,
    configured: true, loading: false, error: null },
  getUser: vi.fn(),
  from: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  order: vi.fn(),
  range: vi.fn(),
  single: vi.fn(),
  remove: vi.fn(),
  otp: vi.fn(),
  verify: vi.fn(),
  logout: vi.fn(),
}))
vi.mock('@/components/audit/AuditLog', () => ({ default: () => null, AuditFailureBanner: () => null }))
vi.mock('@/components/accounts/AccountProvider', () => ({ useAccount: () => mocks.account }))
vi.mock('@/lib/supabase', () => ({
  supabaseConfigError: () => null,
  getSupabase: () => ({
    auth: { getUser: mocks.getUser, signInWithOtp: mocks.otp, verifyOtp: mocks.verify, signOut: mocks.logout },
    from: mocks.from,
  }),
}))

const result: RRunResult = {
  ok: true, test: 'shapiro_wilk', title: 'Shapiro-Wilk',
  variables: { variable: 'bp' }, results: { p_value: 0.4 }, error: null,
  plots: [], duration_s: 0.1, timed_out: false,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.account.user = { id: 'alice', email: 'alice@example.test' }
  const query = {
    insert: mocks.insert, select: mocks.select, eq: mocks.eq,
    order: mocks.order, range: mocks.range, single: mocks.single, delete: mocks.remove,
  }
  mocks.from.mockReturnValue(query)
  mocks.select.mockReturnValue(query)
  mocks.eq.mockReturnValue(query)
  mocks.order.mockReturnValue(query)
  mocks.remove.mockReturnValue(query)
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'alice' } }, error: null })
  mocks.insert.mockResolvedValue({ error: null })
  mocks.range.mockResolvedValue({ data: [], error: null })
})
afterEach(cleanup)

it('saves a result under the verified user without attaching dataset rows', async () => {
  await saveAnalysis(result, 'alice')
  expect(mocks.from).toHaveBeenCalledWith('analysis_history')
  expect(mocks.insert).toHaveBeenCalledWith({ user_id: 'alice', title: result.title, result })
})

it('does not save after the user changes or a session expires', async () => {
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'bob' } }, error: null })
  await expect(saveAnalysis(result, 'alice')).rejects.toThrow('account changed')
  expect(mocks.insert).not.toHaveBeenCalled()
})

it('rejects failed results and oversized payloads', async () => {
  await expect(saveAnalysis({ ...result, ok: false }, 'alice')).rejects.toThrow('successful')
  await expect(saveAnalysis({ ...result, plots: ['x'.repeat(4_000_001)] }, 'alice')).rejects.toThrow('too large')
  expect(mocks.insert).not.toHaveBeenCalled()
})

it('surfaces save errors instead of claiming success', async () => {
  mocks.insert.mockResolvedValue({ error: { message: 'Database unavailable' } })
  await expect(saveAnalysis(result, 'alice')).rejects.toThrow('Could not save')
})

it('lists a bounded page with an explicit owner filter', async () => {
  await listAnalyses('alice', 1)
  expect(mocks.select).toHaveBeenCalledWith('id,title,created_at')
  expect(mocks.eq).toHaveBeenCalledWith('user_id', 'alice')
  expect(mocks.range).toHaveBeenCalledWith(20, 39)
})

it('reports failed list requests explicitly', async () => {
  mocks.range.mockResolvedValue({ data: null, error: { message: 'Denied' } })
  await expect(listAnalyses('alice', 0)).rejects.toThrow('Could not load')
})

it('reopens and validates stored results', async () => {
  mocks.single.mockResolvedValue({ data: { result }, error: null })
  expect(await openAnalysis('alice', 'record')).toEqual(result)
  expect(mocks.eq).toHaveBeenCalledWith('id', 'record')
  mocks.single.mockResolvedValue({ data: { result: {} }, error: null })
  await expect(openAnalysis('alice', 'record')).rejects.toThrow('invalid')
})

it('filters deletion by owner and reports a missing record', async () => {
  mocks.select.mockResolvedValue({ data: [], error: null })
  await expect(deleteAnalysis('alice', 'record')).rejects.toThrow('Could not delete')
  expect(mocks.eq).toHaveBeenCalledWith('user_id', 'alice')
  expect(mocks.eq).toHaveBeenCalledWith('id', 'record')
})

it('requires explicit consent before cloud saving', async () => {
  render(<SaveAnalysis result={result} />)
  const button = screen.getByRole('button', { name: 'Save to History' })
  expect(button.hasAttribute('disabled')).toBe(true)
  expect(mocks.insert).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(button)
  await screen.findByText('Saved to your account.')
  expect(mocks.insert).toHaveBeenCalledOnce()
})

it('shows save failures and allows retry without rerunning the analysis', async () => {
  mocks.insert.mockResolvedValueOnce({ error: { message: 'Offline' } })
  render(<SaveAnalysis result={result} />)
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Save to History' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not save')
  fireEvent.click(screen.getByRole('button', { name: 'Save to History' }))
  await screen.findByText('Saved to your account.')
})

it('offers sign-in instead of cloud saving for anonymous users', () => {
  mocks.account.user = null
  render(<SaveAnalysis result={result} />)
  expect(screen.getByText(/Sign in from History/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save to History' })).toBeNull()
})

it('verifies a sign-in code for the exact email requested', async () => {
  mocks.account.user = null
  mocks.otp.mockResolvedValue({ error: null })
  mocks.verify.mockResolvedValue({ error: null })
  render(<AccountControls />)
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'alice@example.test' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send sign-in email' }))
  await screen.findByLabelText('Email code')
  expect(mocks.otp).toHaveBeenCalledWith({
    email: 'alice@example.test', options: { emailRedirectTo: `${window.location.origin}/` },
  })
  expect(screen.getByRole('status').textContent).toContain('Open the sign-in link in this same browser')
  fireEvent.change(screen.getByLabelText('Email code'), { target: { value: '123456' } })
  fireEvent.click(screen.getByRole('button', { name: 'Verify code and sign in' }))
  await waitFor(() => expect(mocks.verify).toHaveBeenCalledWith({
    email: 'alice@example.test', token: '123456', type: 'email',
  }))
})

it('shows account request errors and supports sign-out', async () => {
  mocks.logout.mockResolvedValue({ error: new Error('Sign-out failed') })
  render(<AccountControls />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Sign-out failed')
  expect(mocks.logout).toHaveBeenCalledWith({ scope: 'local' })
})

it('loads and reopens saved history, with confirmation before deletion', async () => {
  const item = { id: 'record', title: result.title, created_at: '2026-10-27T15:00:00Z' }
  mocks.range.mockResolvedValueOnce({ data: [item], error: null })
  mocks.single.mockResolvedValue({ data: { result }, error: null })
  render(<AnalysisHistory />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open result' }))
  await screen.findByText('p-value')
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(mocks.remove).not.toHaveBeenCalled()
  mocks.select.mockResolvedValue({ data: [{ id: 'record' }], error: null })
  fireEvent.click(screen.getByRole('button', { name: 'Confirm deletion' }))
  await waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce())
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close result' })).toBeNull())
})

it('explains expired sign-in links and removes the error from the address bar', async () => {
  const { takeSignInLinkError } = await vi.importActual<typeof import('@/components/accounts/AccountProvider')>(
    '@/components/accounts/AccountProvider')
  window.history.replaceState(null, '', '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
  expect(takeSignInLinkError()).toBe('The sign-in link could not be used (Email link is invalid or has expired). Request a new sign-in email.')
  expect(window.location.hash).toBe('')
  expect(takeSignInLinkError()).toBeNull()
})
