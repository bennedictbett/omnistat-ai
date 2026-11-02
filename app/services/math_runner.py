"""Runs math_engine in a separate, resource-limited process.

SymPy can run for a very long time on innocent-looking input (9**9**9**9, a huge
integral), and a thread cannot be killed. A child process can: it has a CPU limit,
a memory limit, a wall-clock timeout and its own process group, and a semaphore caps
how many run at once. By default this is defence in depth, not isolation; set
MATH_SANDBOX=docker (see Dockerfile.mathworker) to run each calculation in a container
with no network, a read-only root, no capabilities and hard resource limits.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import shutil
import sys
import uuid

from app.services import docker_sandbox

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

# MATH_SANDBOX=docker runs each calculation in a network-less, read-only container
# (see Dockerfile.mathworker). There is deliberately no fallback to host execution.
DOCKER_SANDBOX = os.getenv("MATH_SANDBOX", "").strip().lower() == "docker"
DOCKER_IMAGE = os.getenv("MATH_DOCKER_IMAGE", "omnistat-math-worker")
DOCKER_STARTUP_SECONDS = float(os.getenv("MATH_DOCKER_STARTUP_SECONDS", "20"))
CONTAINER_LIMIT_CODES = (137, 152)  # 128 + SIGKILL (OOM / killed), 128 + SIGXCPU

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
    container = None
    try:
        if sys.platform == "darwin":
            logger.warning(
                "macOS does not support the worker address-space limit; "
                "CPU, file-size and wall-clock limits remain enabled. "
                "Use a Linux container for memory-limited execution."
            )
        if DOCKER_SANDBOX:
            if shutil.which(docker_sandbox.DOCKER_BIN) is None:
                raise MathFailure("The maths sandbox is unavailable")
            container = f"omnistat-math-{uuid.uuid4().hex[:12]}"
            command = docker_sandbox.hardened_run_args(
                container, DOCKER_IMAGE,
                memory_mb=MEMORY_BYTES // 1024**2,
                cpu_seconds=CPU_SECONDS,
                max_file_bytes=1024**2,
                interactive=True,
                env={"PYTHONDONTWRITEBYTECODE": "1"},
            ) + ["python", "-I", "/app/math_engine.py"]
            # The docker client needs the caller's environment (DOCKER_HOST, ...).
            env = dict(os.environ)
            spawn_kwargs = {"start_new_session": True} if os.name == "posix" else {}
        else:
            command = [sys.executable, "-I", ENGINE_PATH]
            env = _env()
            spawn_kwargs = {"preexec_fn": _limits if os.name == "posix" else None}
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE if container else asyncio.subprocess.DEVNULL,
            env=env,
            **spawn_kwargs,
        )
        try:
            # Container start-up and the SymPy import are not the user's calculation,
            # so they get their own allowance on top of the wall-clock limit.
            wall = TIMEOUT_SECONDS + (DOCKER_STARTUP_SECONDS if container else 0)
            out, err = await asyncio.wait_for(proc.communicate(json.dumps(request).encode()), timeout=wall)
        except asyncio.TimeoutError:
            raise MathTimeout(
                "This took too long to work out and was stopped. Try a simpler expression."
            ) from None
        if proc.returncode != 0:
            if container and proc.returncode in docker_sandbox.FAILURE_CODES:
                logger.error("Math sandbox failed to start: %s", (err or b"").decode("utf-8", "replace")[-300:])
                raise MathFailure("The maths sandbox is unavailable")
            # killed by a limit (CPU / memory) is the same story for the user as a timeout
            if container and proc.returncode in CONTAINER_LIMIT_CODES:
                raise MathTimeout("This used too much time or memory and was stopped. Try a simpler expression.")
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
            if container:
                await docker_sandbox.kill_container(container)
            try:
                os.killpg(proc.pid, signal.SIGKILL) if os.name == "posix" else proc.kill()
            except (ProcessLookupError, PermissionError):
                pass
            await proc.wait()
        sem.release()