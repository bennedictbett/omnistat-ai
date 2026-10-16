from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.security.rate_limit import rate_limit_voice
from app.services.transcribe import MAX_AUDIO_BYTES, VoiceError, transcribe

router = APIRouter()


# rate_limit_voice depends on require_api_key, so auth runs first, then the limiter.
@router.post("/transcribe", dependencies=[Depends(rate_limit_voice)])
async def transcribe_audio(
    audio: UploadFile = File(..., description="A short recording from the browser (webm, ogg, wav, mp4 or mp3)"),
    language: str | None = Form(None, description="Optional language code, e.g. 'en'. Empty means detect."),
):
    # read one byte past the limit so an oversized upload is noticed without loading all of it
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    try:
        result = await transcribe(data, language)
    except VoiceError as e:
        raise HTTPException(status_code=e.status, detail=e.message)
    return {"text": result.text, "language": result.language, "seconds": result.seconds}