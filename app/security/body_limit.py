"""Reject oversized uploads from the Content-Length header before reading the body.

This only stops honest clients early. Chunked uploads carry no length, so the reverse
proxy must also cap request bodies (see deploy/vps/Caddyfile) and the upload handler
counts the bytes it actually receives.
"""
from __future__ import annotations

from typing import Callable

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

_SLACK_BYTES = 1024 * 1024  # multipart framing around the file


class BodyLimitMiddleware:
    def __init__(self, app: ASGIApp, path: str, max_bytes: Callable[[], int]) -> None:
        self.app = app
        self.path = path
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["method"] == "POST" and scope["path"].rstrip("/") == self.path:
            declared = dict(scope["headers"]).get(b"content-length")
            limit = self.max_bytes() + _SLACK_BYTES
            if declared is not None and declared.isdigit() and int(declared) > limit:
                response = JSONResponse(
                    {"detail": f"File too large; the limit is {self.max_bytes() // 1024**2} MB."},
                    status_code=413, headers={"Connection": "close"},
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)
