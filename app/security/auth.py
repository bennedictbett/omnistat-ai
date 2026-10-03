"""API-key authentication for endpoints that execute code.

Keys come from the OMNISTAT_API_KEYS env var (comma-separated, so a key can be
rotated without downtime: add the new one, deploy the frontend, remove the old one).

Fails CLOSED: if no key is configured, protected endpoints return 503 instead
of silently allowing everyone.
"""
from __future__ import annotations

import hashlib
import hmac
import os

from fastapi import Header, HTTPException


def _configured_keys() -> list[str]:
    raw = os.getenv("OMNISTAT_API_KEYS", "")
    return [k.strip() for k in raw.split(",") if k.strip()]


async def require_api_key(x_api_key: str | None = Header(default=None)) -> str:
    """FastAPI dependency. Returns a short non-reversible id of the matched key (safe to log)."""
    keys = _configured_keys()
    if not keys:
        raise HTTPException(status_code=503, detail="API authentication is not configured")
    if x_api_key:
        supplied = x_api_key.encode()
        matched = None
        for k in keys:  # compare against every key so timing doesn't reveal which matched
            if hmac.compare_digest(supplied, k.encode()):
                matched = k
        if matched is not None:
            return hashlib.sha256(matched.encode()).hexdigest()[:8]
    raise HTTPException(
        status_code=401,
        detail="Invalid or missing API key",
        headers={"WWW-Authenticate": "ApiKey"},
    )