'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AUDIO_BITS_PER_SECOND,
  MAX_SECONDS,
  MIN_SECONDS,
  explainMicError,
  extensionFor,
  pickMimeType,
  voiceSupported,
} from '@/lib/voiceInput'

export type VoiceState = 'idle' | 'recording' | 'transcribing'

/**
 * Record from the microphone and turn it into text through /api/voice/transcribe.
 * Nothing is sent until the person stops recording, and the text is handed back to the
 * caller to show and edit; it is never run automatically.
 */
export function useVoiceInput(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [supported, setSupported] = useState(false)

  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAt = useRef(0)
  const discard = useRef(false) // set when the person cancels: throw the clip away
  const abort = useRef<AbortController | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  // Decided after mount so the server render and the first client render match.
  useEffect(() => {
    setSupported(voiceSupported())
  }, [])

  const stopTimer = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
  }

  const releaseMic = () => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }

  const send = useCallback(async (blob: Blob) => {
    const ctrl = new AbortController()
    abort.current = ctrl
    setState('transcribing')
    try {
      const form = new FormData()
      form.append('audio', blob, `clip.${extensionFor(blob.type)}`)
      const res = await fetch('/api/voice/transcribe', { method: 'POST', body: form, signal: ctrl.signal })
      const data = await res.json().catch(() => ({}))
      if (ctrl.signal.aborted) return
      if (!res.ok) {
        setError(
          typeof data.detail === 'string'
            ? data.detail
            : res.status === 429
              ? 'Too many recordings in a minute. Wait a moment and try again.'
              : 'Transcription failed. Try again.'
        )
      } else if (typeof data.text === 'string' && data.text.trim()) {
        onTextRef.current(data.text)
      } else {
        setError('No speech was heard. Speak closer to the microphone and try again.')
      }
    } catch (e) {
      if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return
      setError('Could not reach the transcription service. Check your connection and try again.')
    } finally {
      if (abort.current === ctrl) abort.current = null
      if (!ctrl.signal.aborted) setState('idle')
    }
  }, [])

  const start = useCallback(async () => {
    setError(null)
    if (!voiceSupported()) {
      setError('Voice input needs a recent browser and a secure (https) page.')
      return
    }
    let media: MediaStream
    try {
      // The browser's own noise suppression and echo cancellation help in a busy ward or lab.
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (e) {
      setError(explainMicError(e))
      return
    }
    stream.current = media
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t))
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(media, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
    } catch {
      releaseMic()
      setError('This browser cannot record audio in a format we can read. Try Chrome, Edge or Firefox.')
      return
    }
    chunks.current = []
    discard.current = false
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.current.push(ev.data)
    }
    rec.onerror = () => {
      stopTimer()
      releaseMic()
      recorder.current = null
      setState('idle')
      setError('The recording stopped unexpectedly. Try again.')
    }
    rec.onstop = () => {
      stopTimer()
      releaseMic()
      recorder.current = null
      const length = (Date.now() - startedAt.current) / 1000
      const type = rec.mimeType || mimeType || 'audio/webm'
      const parts = chunks.current
      chunks.current = []
      if (discard.current) {
        setState('idle')
        return
      }
      if (length < MIN_SECONDS || parts.length === 0) {
        setState('idle')
        setError('That was too short. Click the microphone, speak, then click it again to stop.')
        return
      }
      void send(new Blob(parts, { type }))
    }
    recorder.current = rec
    startedAt.current = Date.now()
    setSeconds(0)
    setState('recording')
    rec.start(1000)
    timer.current = setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000
      setSeconds(s)
      if (s >= MAX_SECONDS && rec.state === 'recording') rec.stop() // a minute is the limit
    }, 250)
  }, [send])

  /** Stop recording and transcribe what was said. */
  const stop = useCallback(() => {
    if (recorder.current?.state === 'recording') recorder.current.stop()
  }, [])

  /** Throw the recording (or the wait for a transcript) away. */
  const cancel = useCallback(() => {
    discard.current = true
    abort.current?.abort()
    abort.current = null
    if (recorder.current && recorder.current.state !== 'inactive') {
      recorder.current.stop()
    } else {
      stopTimer()
      releaseMic()
    }
    setError(null)
    setState('idle')
  }, [])

  const toggle = useCallback(() => {
    if (state === 'recording') stop()
    else if (state === 'idle') void start()
  }, [state, start, stop])

  // Leaving the screen must never leave the microphone open or a request running.
  useEffect(
    () => () => {
      discard.current = true
      abort.current?.abort()
      stopTimer()
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
      releaseMic()
    },
    []
  )

  return { state, seconds, error, supported, toggle, cancel, clearError: () => setError(null) }
}