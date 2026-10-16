// Small, framework-free helpers for the microphone button (kept apart so they can be tested).

/** Longest recording. A minute is plenty for a question, and keeps the upload small (~250 KB). */
export const MAX_SECONDS = 60
/** Recordings shorter than this are a mis-click, not speech. */
export const MIN_SECONDS = 0.6
/** Opus at 32 kbit/s is clear for speech and about 4 KB per second. */
export const AUDIO_BITS_PER_SECOND = 32_000

const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']

/** The first recording format this browser can make that the server accepts. */
export function pickMimeType(isTypeSupported: (t: string) => boolean): string | undefined {
  return PREFERRED_TYPES.find((t) => {
    try {
      return isTypeSupported(t)
    } catch {
      return false
    }
  })
}

/** File extension for the upload, from the recorder's real type (Safari makes mp4, Firefox ogg). */
export function extensionFor(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mp4') || m.includes('aac')) return 'mp4'
  if (m.includes('wav')) return 'wav'
  return 'webm'
}

/** 7 -> "0:07", 65 -> "1:05" */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** What to tell the person when the browser refuses the microphone. */
export function explainMicError(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was blocked. Allow the microphone for this site in your browser (the padlock next to the address), then try again.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone was found. Plug one in or check that it is not disabled, then try again.'
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone could not be started. Another app may be using it. Close that app and try again.'
    default:
      return 'Could not start the microphone. Try again.'
  }
}

/** Add dictated words to what is already typed, with one space between and no stray spaces. */
export function joinText(existing: string, dictated: string): string {
  const add = dictated.trim()
  if (!add) return existing
  const base = existing.trimEnd()
  return base ? `${base} ${add}` : add
}

/** Does this browser allow recording at all? (False on plain http except localhost, and in old browsers.) */
export function voiceSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  )
}