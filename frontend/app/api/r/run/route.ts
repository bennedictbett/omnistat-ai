import { NextRequest, NextResponse } from 'next/server'

// Server-side proxy for the R endpoint.
// The browser calls /api/r/run on THIS site; this route adds the secret API key and
// forwards to the backend. OMNISTAT_API_KEY is a server-only env var: never name it
// NEXT_PUBLIC_*, or Next.js will ship it to the browser.

const BACKEND_URL = process.env.BACKEND_URL || 'https://omnistat-ai.onrender.com'
const API_KEY = process.env.OMNISTAT_API_KEY

// Render's free tier can take a while to wake up; allow the function to wait for it.
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ detail: 'Server is not configured' }, { status: 503 })
  }

  // Vercel sets x-forwarded-for from the real connection, so the backend can rate-limit per user.
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/r/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-Client-IP': clientIp,
      },
      body: await req.text(),
      signal: AbortSignal.timeout(55_000),
    })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const retryAfter = upstream.headers.get('retry-after')
    if (retryAfter) headers['Retry-After'] = retryAfter

    return new NextResponse(await upstream.text(), { status: upstream.status, headers })
  } catch {
    return NextResponse.json({ detail: 'Analysis server unavailable, try again shortly' }, { status: 502 })
  }
}