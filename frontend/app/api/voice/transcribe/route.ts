import { NextRequest, NextResponse } from 'next/server'

// Server-side proxy for voice transcription.
// The browser posts a short recording to /api/voice/transcribe on THIS site; this route adds
// the secret API key and forwards it to the backend. OMNISTAT_API_KEY is a server-only
// env var: never name it NEXT_PUBLIC_*, or Next.js will ship it to the browser.
// The recording is passed straight through and is not stored or logged here.

const BACKEND_URL = process.env.BACKEND_URL || 'https://omnistat-ai.onrender.com'
const API_KEY = process.env.OMNISTAT_API_KEY

// Vercel rejects request bodies over 4.5 MB, so refuse early with a readable message.
const MAX_BYTES = 4 * 1024 * 1024

export const maxDuration = 30

export async function POST(req: NextRequest) {
  if (!API_KEY) {
    return NextResponse.json({ detail: 'Server is not configured' }, { status: 503 })
  }

  const contentType = req.headers.get('content-type') || ''
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return NextResponse.json({ detail: 'Send the recording as a form upload.' }, { status: 415 })
  }
  const declared = Number(req.headers.get('content-length') || 0)
  if (declared > MAX_BYTES + 4096) {
    return NextResponse.json({ detail: 'That recording is too long. Keep it under about a minute.' }, { status: 413 })
  }

  // Vercel sets x-forwarded-for from the real connection, so the backend can rate-limit per user.
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'

  try {
    const body = await req.arrayBuffer()
    if (body.byteLength > MAX_BYTES + 4096) {
      return NextResponse.json({ detail: 'That recording is too long. Keep it under about a minute.' }, { status: 413 })
    }
    const upstream = await fetch(`${BACKEND_URL}/api/voice/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType, // carries the multipart boundary
        'X-API-Key': API_KEY,
        'X-Client-IP': clientIp,
      },
      body,
      signal: AbortSignal.timeout(28_000),
    })

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const retryAfter = upstream.headers.get('retry-after')
    if (retryAfter) headers['Retry-After'] = retryAfter

    return new NextResponse(await upstream.text(), { status: upstream.status, headers })
  } catch {
    return NextResponse.json({ detail: 'Transcription server unavailable, try again shortly' }, { status: 502 })
  }
}