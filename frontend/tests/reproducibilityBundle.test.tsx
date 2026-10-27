import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ReproducibilityBundle from '@/components/reports/ReproducibilityBundle'
import { downloadBundle, fetchBundle } from '@/lib/reproducibilityBundle'
import type { RRunResult } from '@/lib/rApi'

const fetchMock = vi.fn()
const result: RRunResult = {
  ok: true, test: 'shapiro_wilk', title: 'Shapiro-Wilk', variables: { variable: 'bp' },
  results: { p_value: 0.4 }, error: null, timed_out: false, duration_s: 0.1, plots: [],
  code: 'R code', r_version: 'R version', data_sha256: 'a'.repeat(64),
}
const rows = [{ bp: 1, secret: 'not sent' }, { bp: 3, secret: 'not sent' }]

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('requires explicit consent and reports an export error without losing results', async () => {
  fetchMock.mockResolvedValue({
    ok: false, status: 422, json: async () => ({ detail: 'Selected data changed' }),
  })
  render(<ReproducibilityBundle result={result} rows={rows} />)
  expect(screen.getByRole('button', { name: 'Download ZIP' }).hasAttribute('disabled')).toBe(true)
  expect(fetchMock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'Download ZIP' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Selected data changed')
  expect(screen.getByRole('button', { name: 'Download ZIP' }).hasAttribute('disabled')).toBe(false)
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('/api/r/bundle')
  expect(JSON.parse(init.body).data).toEqual([{ bp: 1 }, { bp: 3 }])
})

it('does not offer export for failed analyses', () => {
  render(<ReproducibilityBundle result={{ ...result, ok: false }} rows={rows} />)
  expect(screen.queryByRole('button')).toBeNull()
})

it('rejects missing provenance and oversized online requests before fetching', async () => {
  await expect(fetchBundle({ ...result, code: undefined }, rows)).rejects.toThrow('metadata')
  await expect(fetchBundle(result, [{ bp: 'x'.repeat(4_000_001) }])).rejects.toThrow('4 MB')
  expect(fetchMock).not.toHaveBeenCalled()
})

it('validates archive type and signature and returns a valid ZIP blob', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, headers: new Headers({ 'content-type': 'text/html' }) })
  await expect(fetchBundle(result, rows)).rejects.toThrow('ZIP archive')
  const invalid = { slice: () => ({ arrayBuffer: async () => new Uint8Array([0, 1, 2, 3]).buffer }) }
  fetchMock.mockResolvedValueOnce({
    ok: true, headers: new Headers({ 'content-type': 'application/zip' }), blob: async () => invalid,
  })
  await expect(fetchBundle(result, rows)).rejects.toThrow('invalid ZIP')
  const valid = { slice: () => ({ arrayBuffer: async () => new Uint8Array([0x50, 0x4b, 3, 4]).buffer }) }
  fetchMock.mockResolvedValueOnce({
    ok: true, headers: new Headers({ 'content-type': 'application/zip' }), blob: async () => valid,
  })
  expect(await fetchBundle(result, rows)).toBe(valid)
})

it('reports connection failures explicitly', async () => {
  fetchMock.mockRejectedValue(new TypeError('Network down'))
  await expect(fetchBundle(result, rows)).rejects.toThrow('Could not download')
})

it('downloads locally with a fixed filename and releases the temporary object URL', () => {
  vi.useFakeTimers()
  const createObjectURL = vi.fn(() => 'blob:export')
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    expect(this.download).toBe('omnistat-reproducibility.zip')
    expect(this.getAttribute('href')).toBe('blob:export')
    expect(this.isConnected).toBe(true)
  })
  try {
    const blob = new Blob(['zip'])
    downloadBundle(blob)
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(click).toHaveBeenCalledOnce()
    expect(document.querySelector('a[download]')).toBeNull()
    vi.runAllTimers()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:export')
  } finally {
    click.mockRestore()
    vi.useRealTimers()
  }
})
