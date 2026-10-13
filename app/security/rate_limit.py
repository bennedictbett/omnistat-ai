"""Simple in-memory sliding-window rate limiting.

Limits are read from env on every call (so they are easy to tune and to test):
  R_RATE_LIMIT_PER_MIN   per client (default 10)
  R_GLOBAL_RATE_PER_MIN  across all clients (default 60)
  MATH_RATE_LIMIT_PER_MIN / MATH_GLOBAL_RATE_PER_MIN  the same for the equations endpoint (30 / 200)

In-memory means each server process counts separately. That is fine for one
instance; if you scale to several, move the counters to Redis.
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque

from fastapi import Depends, HTTPException, Request

from app.security.auth import require_api_key

_WINDOW_S = 60.0
_lock = threading.Lock()
_hits: dict[str, deque] = defaultdict(deque)


def reset() -> None:
    with _lock:
        _hits.clear()


def _retry_after(key: str, limit: int, now: float) -> float | None:
    """Record a hit for `key` unless it is over `limit`. Return seconds to wait if blocked."""
    q = _hits[key]
    while q and now - q[0] >= _WINDOW_S:
        q.popleft()
    if len(q) >= limit:
        return max(1.0, _WINDOW_S - (now - q[0]))
    q.append(now)
    return None


def client_id(request: Request) -> str:
    # X-Client-IP is set by our own Next.js proxy. It is only trusted because this
    # dependency runs after require_api_key, so only holders of the secret key reach it.
    return request.headers.get("x-client-ip") or (request.client.host if request.client else "unknown")


def _enforce(request: Request, tag: str, per_client: int, global_limit: int) -> None:
    """Sliding-window check. `tag` keeps one endpoint's counters apart from another's."""
    now = time.monotonic()
    ckey = f"{tag}c:{client_id(request)}"
    with _lock:
        wait = _retry_after(ckey, per_client, now)
        if wait is None:
            wait = _retry_after(f"{tag}global", global_limit, now)
            if wait is not None:
                # the client slot was consumed above; give it back so a global block isn't charged to them
                _hits[ckey].pop()
        # drop empty buckets so memory doesn't grow with unique IPs
        for k in [k for k, q in _hits.items() if not q]:
            del _hits[k]
    if wait is not None:
        raise HTTPException(
            status_code=429,
            detail="Too many requests, please slow down",
            headers={"Retry-After": str(int(wait))},
        )


async def rate_limit_r(request: Request, key_id: str = Depends(require_api_key)) -> None:
    _enforce(
        request, "",
        int(os.getenv("R_RATE_LIMIT_PER_MIN", "10")),
        int(os.getenv("R_GLOBAL_RATE_PER_MIN", "60")),
    )


async def rate_limit_math(request: Request, key_id: str = Depends(require_api_key)) -> None:
    """Separate counters from R, so using one does not use up the other's allowance."""
    _enforce(
        request, "math:",
        int(os.getenv("MATH_RATE_LIMIT_PER_MIN", "30")),
        int(os.getenv("MATH_GLOBAL_RATE_PER_MIN", "200")),
    )