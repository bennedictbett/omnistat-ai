import { NextRequest, NextResponse } from 'next/server'
import { API_URL } from '@/lib/config'

export async function POST(req: NextRequest) {
  const key = process.env.OMNISTAT_API_KEY
  if (!key) return NextResponse.json({ detail: 'Server is not configured' }, { status: 503 })
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  try {
    const response = await fetch(`${process.env.BACKEND_URL || API_URL}/api/r/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': key, 'X-Client-IP': clientIp },
      body: await req.text(),
      signal: AbortSignal.timeout(25_000),
    })
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const retryAfter = response.headers.get('retry-after')
    if (retryAfter) headers['Retry-After'] = retryAfter
    return new NextResponse(await response.text(), { status: response.status, headers })
  } catch {
    return NextResponse.json({ detail: 'Analysis server unavailable. No plan was prepared.' }, { status: 502 })
  }
}
