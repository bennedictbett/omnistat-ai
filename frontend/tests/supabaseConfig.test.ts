import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules() })
afterEach(() => { vi.unstubAllEnvs() })

async function load(url: string, key = 'sb_publishable_test') {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', url)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', key)
  return import('@/lib/supabase')
}

it.each([
  'https://abcd.supabase.co/rest/v1/',
  'https://abcd.supabase.co/rest/v1',
  'http://abcd.supabase.co',
  'https://abcd.supabase.co?x=1',
  'abcd.supabase.co',
])('rejects the misconfigured URL %s with an explicit message', async (url) => {
  const { getSupabase, supabaseConfigError } = await load(url)
  expect(supabaseConfigError()).toContain('without /rest/v1')
  expect(getSupabase()).toBeNull()
})

it.each(['https://abcd.supabase.co', 'https://abcd.supabase.co/'])('accepts the project URL %s', async (url) => {
  const { getSupabase, supabaseConfigError } = await load(url)
  expect(supabaseConfigError()).toBeNull()
  expect(getSupabase()).not.toBeNull()
})

it('treats missing settings as not configured rather than misconfigured', async () => {
  const { getSupabase, supabaseConfigError } = await load('', '')
  expect(supabaseConfigError()).toBeNull()
  expect(getSupabase()).toBeNull()
})
