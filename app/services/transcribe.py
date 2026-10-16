"""Speech to text for the Jarvis microphone button, using Whisper on Groq.

The browser records a short clip and sends it here; the text goes back into the
question box, where the person reads and edits it before anything is run.

Privacy. Spoken audio can contain anything the person says, so this service
  * keeps the audio in memory only (nothing is written to disk),
  * never logs audio or the transcript (only sizes and timings),
  * asks Groq for nothing else (no storage, no extra processing).
The clip does leave the server for Groq, like the typed questions already do. The
screen tells people not to say patient names. A fully on-device Whisper can replace
`transcribe()` later without changing the endpoint.

Groq is called over plain HTTP (httpx) rather than through the `groq` package, so this
works with whichever SDK version is pinned.
"""
from __future__ import annotations

import logging
import os
import time
import zlib
from dataclasses import dataclass

import httpx

logger = logging.getLogger("omnistat.voice")

MAX_AUDIO_BYTES = int(os.getenv("VOICE_MAX_BYTES", str(4 * 1024 * 1024)))  # Vercel's request limit is 4.5 MB
MIN_AUDIO_BYTES = 1_000  # anything smaller is a click, not speech
UPSTREAM_TIMEOUT_S = float(os.getenv("VOICE_UPSTREAM_TIMEOUT_SECONDS", "25"))
MAX_TEXT_CHARS = 2_000

# Groq retires models now and then, so the name can be changed on the server without a deploy.
DEFAULT_MODEL = "whisper-large-v3-turbo"

# Whisper reads this as "what was said just before", which makes it far more likely to spell
# statistics words correctly (and keeps "Kaplan-Meier" from becoming "caplan mayor"). Keep it a
# plain list of terms: a sentence-like prompt is what Whisper repeats back when it hears silence.
VOCAB_PROMPT = (
    "Kaplan-Meier, Cox regression, log-rank, Shapiro-Wilk, Mann-Whitney U, Kruskal-Wallis, "
    "ANOVA, t-test, Spearman, p-value, confidence interval, odds ratio, hazard ratio, ROC, Bland-Altman."
)

# Whisper makes up text for silence and noise (often repeating the prompt). Its own per-segment
# scores tell us when that happened; these are the usual thresholds from the Whisper paper.
NO_SPEECH_SURE = 0.8      # at or above this, the segment is not speech
NO_SPEECH_LIKELY = 0.6    # at or above this, together with a low confidence, it is not speech
LOW_CONFIDENCE = -1.0     # average log-probability below this is low confidence
MAX_COMPRESSION = 2.4     # text that compresses this well is the same words repeated

# language codes Whisper accepts that we expose; anything else is auto-detected
LANGUAGES = {"en", "sw", "fr", "es", "pt", "ar", "hi", "de"}


class VoiceError(Exception):
    """Something to tell the person, with the HTTP status to use."""

    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.message = message
        self.status = status


@dataclass
class Transcript:
    text: str
    language: str | None
    seconds: float | None  # length of the audio, as reported by Whisper


def sniff_format(data: bytes) -> str | None:
    """Recognise the audio containers browsers produce, by their first bytes (not by the
    file name or the content type, which the sender controls)."""
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "webm"  # also Matroska
    if data[:4] == b"OggS":
        return "ogg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    if data[4:8] == b"ftyp":
        return "mp4"  # m4a / mp4, Safari
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "mp3"
    if data[:4] == b"fLaC":
        return "flac"
    return None


_MIME = {"webm": "audio/webm", "ogg": "audio/ogg", "wav": "audio/wav", "mp4": "audio/mp4", "mp3": "audio/mpeg", "flac": "audio/flac"}


def _base_url() -> str:
    return os.getenv("GROQ_API_BASE", "https://api.groq.com/openai/v1").rstrip("/")


def _clean(text: str) -> str:
    text = " ".join(text.split())
    return text[:MAX_TEXT_CHARS]


def _repetitive(text: str) -> bool:
    """The same few words over and over, which is how Whisper fills silence."""
    raw = text.strip().encode("utf-8")
    if len(raw) < 60:
        return False
    return len(raw) / len(zlib.compress(raw)) > MAX_COMPRESSION


def _num(value) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _is_speech(segment: dict) -> bool:
    """False for a segment Whisper itself says is silence, noise or a loop."""
    no_speech = _num(segment.get("no_speech_prob"))
    logprob = _num(segment.get("avg_logprob"))
    ratio = _num(segment.get("compression_ratio"))
    if no_speech is not None and no_speech >= NO_SPEECH_SURE:
        return False
    if no_speech is not None and no_speech >= NO_SPEECH_LIKELY and logprob is not None and logprob < LOW_CONFIDENCE:
        return False
    if ratio is not None and ratio > MAX_COMPRESSION:
        return False
    return True


def _speech_text(body: dict, text: str) -> str:
    """The words that were really spoken. Uses Whisper's segments when it sent them, and
    otherwise the plain text; either way a pure repetition is treated as no speech."""
    segments = body.get("segments")
    if isinstance(segments, list) and segments and all(isinstance(s, dict) for s in segments):
        kept = [str(s.get("text") or "") for s in segments if _is_speech(s)]
        text = " ".join(kept)
    return "" if _repetitive(text) else text


async def transcribe(audio: bytes, language: str | None = None, *, client: httpx.AsyncClient | None = None) -> Transcript:
    if len(audio) < MIN_AUDIO_BYTES:
        raise VoiceError("That recording was too short. Hold the microphone button a little longer and speak.", 422)
    if len(audio) > MAX_AUDIO_BYTES:
        raise VoiceError("That recording is too long. Keep it under about a minute.", 413)
    fmt = sniff_format(audio)
    if fmt is None:
        raise VoiceError("That is not an audio recording this server can read.", 415)

    key = os.getenv("GROQ_API_KEY")
    if not key:
        logger.error("GROQ_API_KEY is not set; voice input is unavailable")
        raise VoiceError("Voice input is not set up on the server.", 503)

    data = {
        "model": os.getenv("GROQ_WHISPER_MODEL", DEFAULT_MODEL),
        "response_format": "verbose_json",
        "temperature": "0",
        "prompt": VOCAB_PROMPT,
    }
    if language and language in LANGUAGES:
        data["language"] = language
    files = {"file": (f"clip.{fmt}", audio, _MIME[fmt])}

    started = time.monotonic()
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_S)
    try:
        resp = await http.post(
            f"{_base_url()}/audio/transcriptions",
            headers={"Authorization": f"Bearer {key}"},
            data=data,
            files=files,
        )
    except httpx.TimeoutException:
        raise VoiceError("Transcription took too long. Try a shorter recording.", 504) from None
    except httpx.HTTPError:
        raise VoiceError("Could not reach the transcription service. Try again.", 502) from None
    finally:
        if owns_client:
            await http.aclose()

    elapsed = time.monotonic() - started
    if resp.status_code == 401:
        logger.error("Groq rejected the API key (401) for transcription")
        raise VoiceError("Voice input is not set up correctly on the server.", 503)
    if resp.status_code == 429:
        raise VoiceError("The transcription service is busy. Try again in a moment.", 503)
    if resp.status_code == 413:
        raise VoiceError("That recording is too long. Keep it under about a minute.", 413)
    if resp.status_code >= 400:
        # log the status only: the body can echo request details
        logger.warning("Groq transcription failed: HTTP %s after %.1fs (%d bytes of audio)", resp.status_code, elapsed, len(audio))
        raise VoiceError("Transcription failed. Try again.", 502)

    try:
        body = resp.json()
        text = body["text"]
        if not isinstance(text, str):
            raise TypeError
    except (ValueError, KeyError, TypeError):
        logger.warning("Groq transcription returned an unreadable reply")
        raise VoiceError("Transcription failed. Try again.", 502) from None

    seconds = body.get("duration")
    lang = body.get("language")
    spoken = _clean(_speech_text(body, text))
    logger.info("transcribed %d bytes (%s) in %.1fs%s", len(audio), fmt, elapsed, "" if spoken else " (no speech)")  # no text, no audio
    return Transcript(
        text=spoken,
        language=lang if isinstance(lang, str) else None,
        seconds=float(seconds) if isinstance(seconds, (int, float)) else None,
    )