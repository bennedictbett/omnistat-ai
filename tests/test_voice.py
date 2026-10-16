"""Voice transcription endpoint: audio checks, the request sent to Groq, errors, auth, limits.
Groq itself is replaced by an in-process fake, so no network or key is needed."""
import json
import shutil
import subprocess

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security import rate_limit
from app.services import transcribe as tr

KEY = "test-key-123"


def _make(fmt_args: list[str]) -> bytes:
    """A real 1.5 s tone, encoded by ffmpeg, so the format checks see genuine container headers."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", *fmt_args, "-"],
        capture_output=True, check=True,
    )
    return out.stdout


needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture(scope="module")
def webm() -> bytes:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    return _make(["-c:a", "libopus", "-b:a", "32k", "-f", "webm"])


@pytest.fixture(scope="module")
def wav() -> bytes:
    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    return _make(["-ar", "16000", "-f", "wav"])


class FakeGroq:
    """Stands in for api.groq.com and keeps what it was sent."""

    def __init__(self, reply=None, status=200):
        self.reply = reply if reply is not None else {"text": "  Run a   Kaplan-Meier\nanalysis ", "language": "english", "duration": 1.5}
        self.status = status
        self.requests: list[httpx.Request] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if isinstance(self.reply, Exception):
            raise self.reply
        return httpx.Response(self.status, json=self.reply) if isinstance(self.reply, dict) else httpx.Response(self.status, text=self.reply)


@pytest.fixture(autouse=True)
def env(monkeypatch):
    rate_limit.reset()
    monkeypatch.setenv("OMNISTAT_API_KEYS", KEY)
    monkeypatch.setenv("GROQ_API_KEY", "gsk_fake")
    monkeypatch.setenv("VOICE_RATE_LIMIT_PER_MIN", "1000")
    monkeypatch.setenv("VOICE_GLOBAL_RATE_PER_MIN", "1000")
    monkeypatch.delenv("GROQ_WHISPER_MODEL", raising=False)
    yield
    rate_limit.reset()


@pytest.fixture
def groq(monkeypatch) -> FakeGroq:
    fake = FakeGroq()
    real = httpx.AsyncClient
    monkeypatch.setattr(tr.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(fake.handler), **kw))
    return fake


@pytest.fixture
def client():
    return TestClient(app)


def post(client, audio: bytes, *, key=KEY, ip=None, language=None, name="clip.webm", ctype="audio/webm"):
    headers = {"X-API-Key": key} if key else {}
    if ip:
        headers["X-Client-IP"] = ip
    data = {"language": language} if language is not None else None
    return client.post("/api/voice/transcribe", files={"audio": (name, audio, ctype)}, data=data, headers=headers)


def sent_fields(req: httpx.Request) -> dict[str, bytes]:
    """The multipart fields Groq received, name -> value."""
    ctype = req.headers["content-type"]
    boundary = ctype.split("boundary=")[1].encode()
    out = {}
    for part in req.content.split(b"--" + boundary):
        if b'name="' not in part:
            continue
        head, _, body = part.partition(b"\r\n\r\n")
        name = head.split(b'name="')[1].split(b'"')[0].decode()
        out[name] = body.removesuffix(b"\r\n")  # exactly the multipart delimiter, nothing of the data
    return out


# ---------- audio recognition ----------

@needs_ffmpeg
def test_sniff_recognises_real_containers(webm, wav):
    assert tr.sniff_format(webm) == "webm"
    assert tr.sniff_format(wav) == "wav"
    assert tr.sniff_format(_make(["-c:a", "libvorbis", "-f", "ogg"])) == "ogg"
    assert tr.sniff_format(_make(["-c:a", "libmp3lame", "-f", "mp3"])) == "mp3"
    assert tr.sniff_format(_make(["-c:a", "flac", "-f", "flac"])) == "flac"


def test_sniff_rejects_other_files():
    assert tr.sniff_format(b"%PDF-1.7 " + b"x" * 2000) is None
    assert tr.sniff_format(b"MZ\x90\x00" + b"x" * 2000) is None
    assert tr.sniff_format(b"<html>" + b"x" * 2000) is None
    assert tr.sniff_format(b"") is None


# ---------- the happy path ----------

def test_transcribes_and_tidies_the_text(client, groq, webm):
    r = post(client, webm)
    assert r.status_code == 200, r.text
    assert r.json() == {"text": "Run a Kaplan-Meier analysis", "language": "english", "seconds": 1.5}


def test_request_to_groq_is_what_we_expect(client, groq, webm, monkeypatch):
    post(client, webm, language="en")
    (req,) = groq.requests
    assert str(req.url) == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert req.headers["authorization"] == "Bearer gsk_fake"
    f = sent_fields(req)
    assert f["model"] == b"whisper-large-v3-turbo"
    assert f["language"] == b"en" and f["response_format"] == b"verbose_json" and f["temperature"] == b"0"
    assert b"Kaplan-Meier" in f["prompt"]
    assert f["file"].endswith(webm)  # the audio goes through untouched
    assert b'filename="clip.webm"' in req.content and b"audio/webm" in req.content


def test_model_can_be_changed_on_the_server(client, groq, webm, monkeypatch):
    monkeypatch.setenv("GROQ_WHISPER_MODEL", "whisper-large-v3")
    post(client, webm)
    assert sent_fields(groq.requests[0])["model"] == b"whisper-large-v3"


def test_language_is_only_sent_when_it_is_a_known_code(client, groq, webm):
    post(client, webm)                          # none: detect
    post(client, webm, language="")             # empty: detect
    post(client, webm, language="zz; DROP")     # unknown: ignored, not forwarded
    post(client, webm, language="sw")
    langs = [sent_fields(r).get("language") for r in groq.requests]
    assert langs == [None, None, None, b"sw"]


@needs_ffmpeg
def test_wav_is_labelled_by_its_real_type_not_the_claimed_one(client, groq, wav):
    post(client, wav, name="whatever.exe", ctype="application/octet-stream")
    req = groq.requests[0]
    assert b'filename="clip.wav"' in req.content and b"audio/wav" in req.content


def test_empty_speech_comes_back_as_empty_text(client, groq, webm):
    groq.reply = {"text": "   ", "language": "english", "duration": 1.5}
    r = post(client, webm)
    assert r.status_code == 200 and r.json()["text"] == ""


# ---------- Whisper inventing text for silence ----------

def _seg(text, no_speech=0.0, logprob=-0.2, ratio=1.2):
    return {"text": text, "no_speech_prob": no_speech, "avg_logprob": logprob, "compression_ratio": ratio}


def test_echo_of_the_hint_on_silence_is_dropped(client, groq, webm):
    # what really happened: nobody spoke, and Whisper repeated the vocabulary hint
    echo = "Clinical statistics in the background. Clinical statistics in the background. Clinical statistics, Bland-Altman, standard deviation, p-value, confidence, and p-value, confidence, and p-value."
    groq.reply = {"text": echo, "language": "english", "duration": 4.0, "segments": [_seg(echo, no_speech=0.93, logprob=-0.4, ratio=3.1)]}
    r = post(client, webm)
    assert r.status_code == 200 and r.json()["text"] == ""


def test_repeated_text_is_dropped_even_without_segment_scores(client, groq, webm):
    groq.reply = {"text": "p-value, confidence, and p-value, confidence, and p-value, confidence, and p-value, confidence, and p-value.", "language": "english"}
    assert post(client, webm).json()["text"] == ""


def test_real_speech_with_a_silent_tail_keeps_only_the_speech(client, groq, webm):
    groq.reply = {
        "text": "Run a t-test Thank you.", "language": "english", "duration": 5,
        "segments": [_seg(" Run a t-test", no_speech=0.02), _seg(" Thank you.", no_speech=0.85, logprob=-0.9)],
    }
    assert post(client, webm).json()["text"] == "Run a t-test"


def test_unsure_but_audible_speech_is_kept(client, groq, webm):
    # low confidence alone is not a reason to throw the words away
    groq.reply = {"text": "Compare the two groups", "segments": [_seg("Compare the two groups", no_speech=0.1, logprob=-1.4)]}
    assert post(client, webm).json()["text"] == "Compare the two groups"


def test_likely_silence_with_low_confidence_is_dropped(client, groq, webm):
    groq.reply = {"text": "Thanks for watching", "segments": [_seg("Thanks for watching", no_speech=0.7, logprob=-1.3)]}
    assert post(client, webm).json()["text"] == ""


def test_hint_is_a_plain_list_of_terms():
    # a sentence-like prompt ("Clinical statistics dictation: ...") is what got echoed back
    assert "dictation" not in tr.VOCAB_PROMPT.lower()
    assert "Kaplan-Meier" in tr.VOCAB_PROMPT


def test_very_long_text_is_cut(client, groq, webm):
    groq.reply = {"text": "word " * 2000}
    assert len(post(client, webm).json()["text"]) <= tr.MAX_TEXT_CHARS


# ---------- refusing bad uploads ----------

def test_rejects_non_audio_without_calling_groq(client, groq):
    r = post(client, b"%PDF-1.7 " + b"x" * 5000, name="a.webm")
    assert r.status_code == 415 and "audio" in r.json()["detail"]
    assert groq.requests == []


def test_rejects_tiny_clip(client, groq):
    r = post(client, b"\x1a\x45\xdf\xa3" + b"0" * 100)
    assert r.status_code == 422 and "too short" in r.json()["detail"]
    assert groq.requests == []


def test_rejects_oversize_without_calling_groq(client, groq, monkeypatch):
    monkeypatch.setattr(tr, "MAX_AUDIO_BYTES", 5_000)
    import app.api.routes.voice as route
    monkeypatch.setattr(route, "MAX_AUDIO_BYTES", 5_000)
    r = post(client, b"\x1a\x45\xdf\xa3" + b"0" * 9_000)
    assert r.status_code == 413 and "too long" in r.json()["detail"]
    assert groq.requests == []


def test_missing_file_is_a_422(client, groq):
    r = client.post("/api/voice/transcribe", headers={"X-API-Key": KEY})
    assert r.status_code == 422


# ---------- upstream problems become plain messages ----------

@pytest.mark.parametrize("status,expected_status,words", [
    (401, 503, "not set up"),
    (429, 503, "busy"),
    (413, 413, "too long"),
    (500, 502, "failed"),
    (400, 502, "failed"),
])
def test_groq_errors(client, groq, webm, status, expected_status, words):
    groq.status = status
    groq.reply = {"error": {"message": "secret internal detail"}}
    r = post(client, webm)
    assert r.status_code == expected_status and words in r.json()["detail"]
    assert "secret" not in r.text and "gsk_" not in r.text


def test_timeout_and_network_errors(client, groq, webm):
    groq.reply = httpx.ReadTimeout("slow")
    assert post(client, webm).status_code == 504
    groq.reply = httpx.ConnectError("down")
    r = post(client, webm)
    assert r.status_code == 502 and "Could not reach" in r.json()["detail"]


@pytest.mark.parametrize("reply", ["<html>oops</html>", {"nope": 1}, {"text": 5}, {"text": None}])
def test_unreadable_replies(client, groq, webm, reply):
    groq.reply = reply
    r = post(client, webm)
    assert r.status_code == 502 and "failed" in r.json()["detail"]


def test_no_groq_key(client, groq, webm, monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY")
    r = post(client, webm)
    assert r.status_code == 503 and "not set up" in r.json()["detail"]
    assert groq.requests == []


# ---------- privacy: nothing spoken or recorded reaches the logs ----------

def test_logs_hold_no_text_or_audio(client, groq, webm, caplog):
    import logging
    caplog.set_level(logging.DEBUG)
    groq.reply = {"text": "patient John Mwangi has diabetes", "language": "english", "duration": 2}
    post(client, webm)
    groq.status = 500
    post(client, webm)
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "Mwangi" not in logged and "diabetes" not in logged and "gsk_fake" not in logged
    assert "transcribed" in logged  # sizes and timing are logged


# ---------- auth and limits ----------

def test_needs_the_api_key(client, groq, webm):
    assert post(client, webm, key=None).status_code == 401
    assert post(client, webm, key="wrong").status_code == 401
    assert groq.requests == []


def test_fails_closed_when_no_keys_configured(client, groq, webm, monkeypatch):
    monkeypatch.delenv("OMNISTAT_API_KEYS")
    assert post(client, webm).status_code == 503
    assert groq.requests == []


def test_per_client_limit_and_separate_from_other_endpoints(client, groq, webm, monkeypatch):
    monkeypatch.setenv("VOICE_RATE_LIMIT_PER_MIN", "2")
    ip = {"ip": "9.9.9.9"}
    assert post(client, webm, **ip).status_code == 200
    assert post(client, webm, **ip).status_code == 200
    blocked = post(client, webm, **ip)
    assert blocked.status_code == 429 and "Retry-After" in blocked.headers
    assert post(client, webm, ip="8.8.8.8").status_code == 200  # someone else is fine
    # the maths allowance is a different counter
    ok = client.post("/api/math/run", json={"operation": "derivative", "expression": "x^2"},
                     headers={"X-API-Key": KEY, "X-Client-IP": "9.9.9.9"})
    assert ok.status_code == 200
    assert len(groq.requests) == 3  # the blocked one never reached Groq


def test_blocked_requests_do_not_reach_groq_or_read_the_upload(client, groq, webm, monkeypatch):
    monkeypatch.setenv("VOICE_GLOBAL_RATE_PER_MIN", "1")
    assert post(client, webm).status_code == 200
    assert post(client, webm, ip="2.2.2.2").status_code == 429
    assert len(groq.requests) == 1