"""Runs math_engine in a separate, resource-limited process.

SymPy can run for a very long time on innocent-looking input (9**9**9**9, a huge
integral), and a thread cannot be killed. A child process can: it has a CPU limit,
a memory limit, a wall-clock timeout and its own process group, and a semaphore caps
how many run at once. Like the R runner this is defence in depth, not isolation:
run the app in a container with no outbound network and a non-root user.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys

try:
    import resource  # POSIX only
except ImportError:  # native Windows: no rlimits / process groups
    resource = None

TIMEOUT_SECONDS = float(os.getenv("MATH_TIMEOUT_SECONDS", "10"))
CPU_SECONDS = int(os.getenv("MATH_CPU_SECONDS", "10"))
MEMORY_BYTES = int(os.getenv("MATH_MEMORY_MB", "1024")) * 1024**2
MAX_CONCURRENT = int(os.getenv("MATH_MAX_CONCURRENT", "4"))
QUEUE_WAIT_SECONDS = float(os.getenv("MATH_QUEUE_WAIT_SECONDS", "5"))
MAX_STDOUT = 200_000
ENGINE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "math_engine.py")

_sem: asyncio.Semaphore | None = None
logger = logging.getLogger("omnistat.math_runner")


class MathBusy(Exception):
    """Too many calculations are running at once."""


class MathTimeout(Exception):
    """The calculation took too long and was stopped."""


class MathFailure(Exception):
    """The worker crashed or returned nonsense (not the user's fault)."""


def _semaphore() -> asyncio.Semaphore:
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(MAX_CONCURRENT)
    return _sem


def _limits() -> None:
    os.setsid()  # own process group, so the whole tree can be killed
    if resource is not None:
        resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
        if sys.platform != "darwin":
            resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_FSIZE, (1024**2, 1024**2))


def _env() -> dict[str, str]:
    keep = ("PATH", "SYSTEMROOT", "LANG", "LC_ALL")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


async def run_math(request: dict) -> dict:
    sem = _semaphore()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=QUEUE_WAIT_SECONDS)
    except asyncio.TimeoutError:
        raise MathBusy("The maths engine is busy, try again in a few seconds") from None
    proc = None
    try:
        if sys.platform == "darwin":
            logger.warning(
                "macOS does not support the worker address-space limit; "
                "CPU, file-size and wall-clock limits remain enabled. "
                "Use a Linux container for memory-limited execution."
            )
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-I", ENGINE_PATH,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=_env(),
            preexec_fn=_limits if os.name == "posix" else None,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(json.dumps(request).encode()), timeout=TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            raise MathTimeout(
                "This took too long to work out and was stopped. Try a simpler expression."
            ) from None
        if proc.returncode != 0:
            # killed by a limit (CPU / memory) is the same story for the user as a timeout
            if proc.returncode in (-signal.SIGKILL, -signal.SIGXCPU) or (proc.returncode or 0) < 0:
                raise MathTimeout("This used too much time or memory and was stopped. Try a simpler expression.")
            raise MathFailure("The maths engine failed")
        if len(out) > MAX_STDOUT:
            raise MathFailure("The maths engine returned too much")
        try:
            result = json.loads(out)
        except ValueError:
            raise MathFailure("The maths engine returned an unreadable answer") from None
        if not isinstance(result, dict):
            raise MathFailure("The maths engine returned an unreadable answer")
        return result
    finally:
        if proc is not None and proc.returncode is None:
            try:
                os.killpg(proc.pid, signal.SIGKILL) if os.name == "posix" else proc.kill()
            except (ProcessLookupError, PermissionError):
                pass
            await proc.wait()
        sem.release()