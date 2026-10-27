import { NextRequest, NextResponse } from 'next/server'
import { API_URL } from '@/lib/config'

export const maxDuration = 60

export async function POST(req: NextRequest) {
  const key = process.env.OMNISTAT_API_KEY
  if (!key) return NextResponse.json({ detail: 'Server is not configured' }, { status: 503 })
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  try {
    const upstream = await fetch(`${process.env.BACKEND_URL || API_URL}/api/r/bundle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'X-Client-IP': clientIp },
      body: await req.text(),
      signal: AbortSignal.timeout(55_000),
      cache: 'no-store',
    })
    const headers: Record<string, string> = {
      'Content-Type': upstream.ok ? 'application/zip' : 'application/json',
      'Cache-Control': 'no-store',
    }
    if (upstream.ok) headers['Content-Disposition'] = 'attachment; filename="omnistat-reproducibility.zip"'
    const retryAfter = upstream.headers.get('retry-after')
    if (retryAfter) headers['Retry-After'] = retryAfter
    return new NextResponse(await upstream.arrayBuffer(), { status: upstream.status, headers })
  } catch {
    return NextResponse.json({ detail: 'Could not reach the export service. Your analysis is still available on screen.' }, { status: 502 })
  }
}
