"""Sandboxed R execution for OmniStat.

- Each run gets a throwaway working dir: user.R, params.json, optional input.csv, out/.
- wrapper.R sources user.R, captures plots and emit()ed results, and always writes
  result.json, so an R error never loses partial output.
- The subprocess has CPU / memory / file-size rlimits, a wall-clock timeout, its own
  process group (killed wholesale on timeout) and a minimal environment.
- A semaphore caps concurrent R processes.

rlimits + a clean env are defence in depth, NOT isolation. Run the app in a container
with no outbound network, a non-root user and a read-only filesystem (except /tmp).
Never pass user-supplied strings into `code`; pass them via `params`.
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import signal
import tempfile
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

try:
    import resource  # POSIX only
except ImportError:  # native Windows: no rlimits / process groups
    resource = None
POSIX = resource is not None

RSCRIPT = os.getenv("RSCRIPT_BIN", "Rscript")
R_LIBS = os.getenv("R_LIBS")  # optional extra library path for pre-installed packages
MAX_CONCURRENT = int(os.getenv("R_MAX_CONCURRENT", "4"))
CPU_SECONDS = int(os.getenv("R_CPU_SECONDS", "30"))
MEMORY_BYTES = int(os.getenv("R_MEMORY_MB", "2048")) * 1024**2
MAX_FILE_BYTES = 20 * 1024**2
MAX_OUTPUT_CHARS = 20_000
MAX_PLOT_BYTES = 5 * 1024**2

_sem: asyncio.Semaphore | None = None


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
    resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES))
    # RLIMIT_NPROC is per-user, so set process limits at the container level.


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
    and emit("name", value) returns structured results."""
    async with _semaphore():
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

            if POSIX:
                env = {
                    "PATH": "/usr/local/bin:/usr/bin:/bin",
                    "HOME": str(workdir),
                    "TMPDIR": str(workdir),
                    "LANG": "C.UTF-8",
                }
                spawn_kwargs = {"start_new_session": True, "preexec_fn": _apply_limits}
            else:
                # Windows dev only: no sandboxing here, use Docker/WSL for anything real.
                env = {**os.environ, "TMPDIR": str(workdir)}
                spawn_kwargs = {}
            if R_LIBS:
                env["R_LIBS"] = R_LIBS

            proc = await asyncio.create_subprocess_exec(
                RSCRIPT, "--vanilla", "wrapper.R",
                cwd=workdir,
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
                if POSIX:
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
                out, err = await proc.communicate()

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