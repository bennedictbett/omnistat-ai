"""Store a large dataset once on the server, then refer to it by id.

Public like /api/analytics/upload (the browser cannot hold an API key), so it is
rate-limited per client address and bounded by upload-size, row and storage limits
(see app/services/dataset_store.py). Anyone holding a dataset id can read or delete
that dataset; ids are 128-bit random values and expire after inactivity.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, Response, UploadFile

from app.security.rate_limit import rate_limit_dataset_read, rate_limit_dataset_upload
from app.services import dataset_store as store

router = APIRouter()

ALLOWED_SUFFIXES = {".csv", ".xlsx", ".xls", ".sav", ".zsav", ".dta"}
QUEUE_WAIT_SECONDS = 10.0
CHUNK_BYTES = 1024 * 1024
NO_STORE = {"Cache-Control": "no-store"}

_ingest_slots: asyncio.Semaphore | None = None


def _slots() -> asyncio.Semaphore:
    # Parsing a large file is memory-hungry, so only a few run at once (default 1).
    global _ingest_slots
    if _ingest_slots is None:
        _ingest_slots = asyncio.Semaphore(store.max_concurrent_uploads())
    return _ingest_slots


def _owner(request: Request) -> str:
    host = request.client.host if request.client else "unknown"
    return hashlib.sha256(host.encode()).hexdigest()[:12]


def _http(error: store.DatasetError) -> HTTPException:
    return HTTPException(status_code=error.status, detail=str(error))


@router.post("", dependencies=[Depends(rate_limit_dataset_upload)])
async def upload_dataset(request: Request, response: Response, file: UploadFile = File(...)):
    name = os.path.basename(file.filename or "")
    suffix = Path(name).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=422, detail="Upload a CSV, Excel, SPSS (.sav/.zsav) or Stata (.dta) file.")
    limit = store.max_excel_bytes() if suffix in {".xlsx", ".xls"} else store.max_upload_bytes()

    staging = store.data_dir() / f".tmp-up-{secrets.token_hex(8)}"
    staging.mkdir()
    source = staging / f"upload{suffix}"
    try:
        written = 0
        with open(source, "wb") as out:
            while chunk := await file.read(CHUNK_BYTES):
                written += len(chunk)
                if written > limit:
                    raise HTTPException(status_code=413, detail=f"File too large; the limit is {limit // 1024**2} MB.")
                out.write(chunk)
        if written == 0:
            raise HTTPException(status_code=422, detail="The uploaded file is empty")

        try:
            await asyncio.wait_for(_slots().acquire(), timeout=QUEUE_WAIT_SECONDS)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=503, detail="The server is processing other uploads, try again shortly",
                                headers={"Retry-After": "15"}) from None
        try:
            summary = await asyncio.to_thread(store.ingest, source, name, _owner(request))
        finally:
            _slots().release()
    except store.DatasetError as e:
        raise _http(e) from e
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    response.headers.update(NO_STORE)
    return summary


@router.get("/{dataset_id}", dependencies=[Depends(rate_limit_dataset_read)])
def dataset_summary(dataset_id: str, response: Response):
    try:
        summary = store.get_meta(dataset_id)
    except store.DatasetError as e:
        raise _http(e) from e
    response.headers.update(NO_STORE)
    return summary


@router.get("/{dataset_id}/rows", dependencies=[Depends(rate_limit_dataset_read)])
def dataset_rows(
    dataset_id: str,
    response: Response,
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=store.MAX_PAGE_ROWS),
):
    try:
        page = store.read_rows(dataset_id, offset, limit)
    except store.DatasetError as e:
        raise _http(e) from e
    response.headers.update(NO_STORE)
    return page


@router.delete("/{dataset_id}", dependencies=[Depends(rate_limit_dataset_read)])
def delete_dataset(dataset_id: str, response: Response):
    try:
        existed = store.delete(dataset_id)
    except store.DatasetError as e:
        raise _http(e) from e
    if not existed:
        raise HTTPException(status_code=404, detail="Dataset not found or expired")
    response.headers.update(NO_STORE)
    return {"deleted": True}
