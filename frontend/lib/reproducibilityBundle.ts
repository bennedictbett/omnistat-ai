import { RApiError, RRunResult, trimRows } from './rApi'

export async function fetchBundle(result: RRunResult, rows: Record<string, unknown>[]): Promise<Blob> {
  if (!result.ok || !result.code || !result.data_sha256 || !result.r_version) {
    throw new RApiError(422, 'This result has no complete reproducibility metadata. Run the analysis again before exporting.')
  }
  const body = JSON.stringify({
    result,
    data: trimRows(rows, Array.from(new Set(Object.values(result.variables)))),
  })
  if (new TextEncoder().encode(body).length > 4_000_000) {
    throw new RApiError(413, 'The export request exceeds the 4 MB online limit. The result remains on screen; use a smaller dataset for this export.')
  }
  let response: Response
  try {
    response = await fetch('/api/r/bundle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(60_000),
    })
  } catch {
    throw new RApiError(0, 'Could not download the bundle. Check your connection and try again; your result remains on screen.')
  }
  if (!response.ok) {
    let detail = `Bundle export failed (HTTP ${response.status}). Please try again.`
    try {
      const error: unknown = await response.json()
      if (typeof error === 'object' && error !== null && 'detail' in error && typeof error.detail === 'string') {
        detail = error.detail
      }
    } catch {
      // Platform error pages may not be JSON; the HTTP error above remains visible.
    }
    throw new RApiError(response.status, detail)
  }
  if (!response.headers.get('content-type')?.includes('application/zip')) {
    throw new RApiError(502, 'The export service did not return a ZIP archive.')
  }
  const blob = await response.blob()
  const signature = new Uint8Array(await blob.slice(0, 4).arrayBuffer())
  if (signature.length !== 4 || signature[0] !== 0x50 || signature[1] !== 0x4b ||
    signature[2] !== 0x03 || signature[3] !== 0x04) {
    throw new RApiError(502, 'The export service returned an invalid ZIP archive.')
  }
  return blob
}

export function downloadBundle(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'omnistat-reproducibility.zip'
  document.body.appendChild(link)
  try {
    link.click()
  } finally {
    link.remove()
    // Let the browser consume the object URL before releasing its backing memory.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
}
