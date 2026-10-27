import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '@/app/api/r/bundle/route'

const fetchMock = vi.fn()
const request = () => new NextRequest('http://localhost/api/r/bundle', {
  method: 'POST', body: '{"result":{},"data":[]}',
  headers: { 'x-forwarded-for': '192.0.2.1, 192.0.2.2' },
})

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('OMNISTAT_API_KEY', 'test-only-key')
  vi.stubEnv('BACKEND_URL', 'http://backend.test')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('requires server configuration without sending data upstream', async () => {
  vi.stubEnv('OMNISTAT_API_KEY', '')
  expect((await POST(request())).status).toBe(503)
  expect(fetchMock).not.toHaveBeenCalled()
})

it('forwards binary bytes using server-only credentials and disables caching', async () => {
  const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 0xff])
  fetchMock.mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'application/zip' } }))
  const response = await POST(request())
  expect(response.status).toBe(200)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-disposition')).toContain('omnistat-reproducibility.zip')
  expect(fetchMock).toHaveBeenCalledWith('http://backend.test/api/r/bundle', expect.objectContaining({
    method: 'POST', body: '{"result":{},"data":[]}',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-only-key', 'X-Client-IP': '192.0.2.1' },
  }))
})

it('preserves rate-limit errors and Retry-After', async () => {
  fetchMock.mockResolvedValue(new Response('{"detail":"Rate limit exceeded"}', {
    status: 429, headers: { 'retry-after': '60' },
  }))
  const response = await POST(request())
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(await response.json()).toEqual({ detail: 'Rate limit exceeded' })
})

it('reports an unavailable upstream without claiming a download succeeded', async () => {
  fetchMock.mockRejectedValue(new TypeError('Network down'))
  const response = await POST(request())
  expect(response.status).toBe(502)
  expect((await response.json()).detail).toContain('Could not reach')
})
