"""Sandboxed R execution for OmniStat.

- Each run gets a throwaway working dir: user.R, params.json, optional input.csv, out/.
- wrapper.R sources user.R, captures plots and emit()ed results, and always writes
  result.json, so an R error never loses partial output.
- The subprocess has CPU / memory / file-size rlimits, a wall-clock timeout, its own
  process group (killed wholesale on timeout) and a minimal environment.
- A semaphore caps concurrent R processes.

rlimits + a clean env are defence in depth, NOT isolation. Set R_SANDBOX=docker to run
each job in a container with no network, a read-only root, no capabilities and hard
memory / CPU / PID limits (see Dockerfile.rworker), or run the whole app that way.
Never pass user-supplied strings into `code`; pass them via `params`.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shutil
import signal
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path

from app.services import docker_sandbox

try:
    import resource  # POSIX only
except ImportError:  # native Windows: no rlimits / process groups
    resource = None
POSIX = resource is not None

RSCRIPT = os.getenv("RSCRIPT_BIN", "Rscript")
R_LIBS = os.getenv("R_LIBS")  # optional extra library path for pre-installed packages
MAX_CONCURRENT = int(os.getenv("R_MAX_CONCURRENT", "4"))
QUEUE_WAIT_SECONDS = float(os.getenv("R_QUEUE_WAIT_SECONDS", "10"))
CPU_SECONDS = int(os.getenv("R_CPU_SECONDS", "30"))
MEMORY_BYTES = int(os.getenv("R_MEMORY_MB", "2048")) * 1024**2
MAX_FILE_BYTES = 20 * 1024**2
MAX_OUTPUT_CHARS = 20_000
MAX_PLOT_BYTES = 5 * 1024**2
DRAIN_SECONDS = 5.0

# R_SANDBOX=docker runs every R job in a network-less, read-only container.
# There is deliberately no fallback to host execution if Docker is unavailable.
DOCKER_SANDBOX = os.getenv("R_SANDBOX", "").strip().lower() == "docker"
DOCKER_BIN = docker_sandbox.DOCKER_BIN
DOCKER_IMAGE = os.getenv("R_DOCKER_IMAGE", "omnistat-r-worker")
DOCKER_FAILURE_CODES = docker_sandbox.FAILURE_CODES

_sem: asyncio.Semaphore | None = None
logger = logging.getLogger("omnistat.r_runner")


def _semaphore() -> asyncio.Semaphore:
    # created lazily so it binds to the running event loop
    global _sem
    if _sem is None:
        _sem = asyncio.Semaphore(MAX_CONCURRENT)
    return _sem


WRAPPER = r"""
options(warn = 1, repos = NULL)
suppressMessages(library(jsonlite))
.results <- list()
emit <- function(name, value) { .results[[name]] <<- value; invisible(NULL) }
params <- if (file.exists("params.json")) fromJSON("params.json") else list()
if (file.exists("input.csv")) df <- read.csv("input.csv", stringsAsFactors = FALSE, check.names = FALSE)
dir.create("out", showWarnings = FALSE)
png("out/plot_%02d.png", width = 900, height = 600)
.err <- NULL
tryCatch(
  source("user.R", print.eval = TRUE),
  error = function(e) .err <<- conditionMessage(e)
)
invisible(dev.off())
write_json(list(results = .results, error = if (is.null(.err)) NA_character_ else .err), "result.json",
           auto_unbox = TRUE, digits = NA, na = "null", force = TRUE)
"""


class RunnerBusy(Exception):
    """All R slots stayed busy for QUEUE_WAIT_SECONDS; caller should return 503."""


@dataclass
class RResult:
    ok: bool
    stdout: str = ""
    stderr: str = ""
    results: dict = field(default_factory=dict)
    error: str | None = None
    plots: list[str] = field(default_factory=list)  # base64 PNGs
    timed_out: bool = False
    duration_s: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


def _apply_limits() -> None:
    """Runs in the child just before exec."""
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
    if sys.platform != "darwin":
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES))
    # RLIMIT_NPROC is per-user, so set process limits at the container level.


def _docker_command(workdir: Path, name: str) -> list[str]:
    """Hardened `docker run` for one R job; only the working directory is writable."""
    return docker_sandbox.hardened_run_args(
        name, DOCKER_IMAGE,
        memory_mb=MEMORY_BYTES // 1024**2,
        cpu_seconds=CPU_SECONDS,
        max_file_bytes=MAX_FILE_BYTES,
        mounts=[f"type=bind,source={workdir},target=/work"],
        workdir="/work",
        env={"HOME": "/work"},
    ) + ["Rscript", "--vanilla", "wrapper.R"]


async def _kill(proc, container: str | None) -> None:
    """Stop the whole run, not just the direct child."""
    if container:
        await docker_sandbox.kill_container(container)
    if POSIX:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        return
    # Windows: Rscript.exe spawns R.exe, which keeps the pipes open if only the
    # parent is killed, so communicate() would block forever.
    try:
        killer = await asyncio.create_subprocess_exec(
            "taskkill", "/PID", str(proc.pid), "/T", "/F",
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(killer.wait(), 10)
    except (OSError, asyncio.TimeoutError):
        pass
    try:
        proc.kill()
    except ProcessLookupError:
        pass


async def _drain(proc) -> tuple[bytes, bytes]:
    """Collect output after a kill without ever waiting indefinitely."""
    try:
        return await asyncio.wait_for(proc.communicate(), DRAIN_SECONDS)
    except asyncio.TimeoutError:
        logger.warning("R output pipes did not close after kill")
        return b"", b""


def _trim(b: bytes) -> str:
    s = b.decode("utf-8", errors="replace")
    return s if len(s) <= MAX_OUTPUT_CHARS else s[:MAX_OUTPUT_CHARS] + "\n...[truncated]"


async def run_r(
    code: str,
    data_csv: bytes | None = None,
    params: dict | None = None,
    timeout: float = 30.0,
) -> RResult:
    """Run R code. `df` holds data_csv, `params` holds the params dict,
    and emit("name", value) returns structured results.

    Waits at most QUEUE_WAIT_SECONDS for a free slot, then raises RunnerBusy."""
    sem = _semaphore()
    try:
        await asyncio.wait_for(sem.acquire(), timeout=QUEUE_WAIT_SECONDS)
    except asyncio.TimeoutError:
        raise RunnerBusy("R workers are busy, try again shortly") from None
    try:
        return await _run_r_unlocked(code, data_csv, params, timeout)
    finally:
        sem.release()


async def _run_r_unlocked(
    code: str,
    data_csv: bytes | None = None,
    params: dict | None = None,
    timeout: float = 30.0,
) -> RResult:
    """Run R code. `df` holds data_csv, `params` holds the params dict,
    and emit("name", value) returns structured results."""
    workdir = Path(tempfile.mkdtemp(prefix="rrun_"))
    start = time.monotonic()
    try:
        (workdir / "user.R").write_text(code, encoding="utf-8")
        (workdir / "wrapper.R").write_text(WRAPPER, encoding="utf-8")
        (workdir / "out").mkdir()
        if params is not None:
            (workdir / "params.json").write_text(json.dumps(params), encoding="utf-8")
        if data_csv is not None:
            (workdir / "input.csv").write_bytes(data_csv)

        container = None
        if DOCKER_SANDBOX:
            # The container user is unrelated to the app user, so the throwaway
            # mount must be writable by anyone (it is deleted after the run).
            for path in (workdir, workdir / "out"):
                path.chmod(0o777)
            container = f"omnistat-r-{uuid.uuid4().hex[:12]}"
            command = _docker_command(workdir, container)
            if shutil.which(command[0]) is None:
                return RResult(
                    ok=False,
                    error=f"R sandbox unavailable: '{DOCKER_BIN}' was not found. "
                          "Install Docker or unset R_SANDBOX.",
                )
            # The docker client needs the caller's environment (DOCKER_HOST, ...);
            # R itself only ever sees the container's fixed environment.
            env = dict(os.environ)
            spawn_kwargs = {"start_new_session": True} if POSIX else {}
            cwd = None
        else:
            if POSIX:
                env = {
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "HOME": str(workdir),
                    "TMPDIR": str(workdir),
                    "LANG": "C.UTF-8",
                }
                spawn_kwargs = {"start_new_session": True, "preexec_fn": _apply_limits}
            else:
                # Windows dev only: no sandboxing here, set R_SANDBOX=docker for isolation.
                env = {**os.environ, "TMPDIR": str(workdir)}
                spawn_kwargs = {}
            if R_LIBS:
                env["R_LIBS"] = R_LIBS

            if sys.platform == "darwin":
                logger.warning(
                    "macOS does not support the worker address-space limit; "
                    "CPU, file-size and wall-clock limits remain enabled. "
                    "Use a Linux container for memory-limited execution."
                )
            # Resolve against the parent's PATH before giving R a restricted environment.
            command = [shutil.which(RSCRIPT) or RSCRIPT, "--vanilla", "wrapper.R"]
            cwd = workdir
        proc = await asyncio.create_subprocess_exec(
            *command,
            cwd=cwd,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **spawn_kwargs,
        )

        timed_out = False
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            timed_out = True
            await _kill(proc, container)
            out, err = await _drain(proc)

        results: dict = {}
        r_error: str | None = None
        rj = workdir / "result.json"
        if rj.exists():
            try:
                payload = json.loads(rj.read_text(encoding="utf-8"))
                results = payload.get("results") or {}
                r_error = payload.get("error") or None  # null / {} / "" -> no error
            except json.JSONDecodeError:
                r_error = "Could not parse R results"

        plots = []
        for p in sorted((workdir / "out").glob("*.png")):
            if p.stat().st_size <= MAX_PLOT_BYTES:
                plots.append(base64.b64encode(p.read_bytes()).decode())

        if timed_out:
            r_error = f"Timed out after {timeout:.0f}s"
        elif container and proc.returncode in DOCKER_FAILURE_CODES and not rj.exists():
            detail = _trim(err).strip().splitlines()
            r_error = "R sandbox failed to start: " + (detail[-1] if detail else f"docker exit {proc.returncode}")
        elif proc.returncode != 0 and not r_error:
            r_error = f"R exited with code {proc.returncode} (possible memory/CPU limit)"

        return RResult(
            ok=r_error is None,
            stdout=_trim(out),
            stderr=_trim(err),
            results=results,
            error=r_error,
            plots=plots,
            timed_out=timed_out,
            duration_s=round(time.monotonic() - start, 3),
        )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)