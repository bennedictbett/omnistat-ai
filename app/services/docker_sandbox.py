"""Shared helpers for running untrusted workers in locked-down Docker containers.

Used by r_runner (R_SANDBOX=docker) and math_runner (MATH_SANDBOX=docker). Containers
get no network, a read-only root, no capabilities and hard resource limits. Callers
must fail closed: if Docker is unavailable, do not fall back to the host.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess

DOCKER_BIN = os.getenv("DOCKER_BIN", "docker")
DOCKER_USER = os.getenv("DOCKER_SANDBOX_USER", "65534:65534")
DOCKER_CPUS = os.getenv("DOCKER_SANDBOX_CPUS", "1")
DOCKER_PIDS = int(os.getenv("DOCKER_SANDBOX_PIDS", "64"))
FAILURE_CODES = (125, 126, 127)  # docker itself failed (e.g. image missing)

logger = logging.getLogger("omnistat.docker_sandbox")


def hardened_run_args(
    name: str,
    image: str,
    *,
    memory_mb: int,
    cpu_seconds: int,
    max_file_bytes: int,
    interactive: bool = False,
    mounts: list[str] | None = None,
    workdir: str | None = None,
    env: dict[str, str] | None = None,
    user: str | None = None,
    cpus: str | None = None,
    pids: int | None = None,
) -> list[str]:
    """`docker run` argv prefix; append the command to run inside the image."""
    memory = f"{memory_mb}m"
    argv = [DOCKER_BIN, "run", "--rm", "--name", name]
    if interactive:
        argv.append("-i")
    argv += [
        "--network", "none",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--user", user or DOCKER_USER,
        "--memory", memory, "--memory-swap", memory,
        "--cpus", cpus or DOCKER_CPUS,
        "--pids-limit", str(pids or DOCKER_PIDS),
        "--ulimit", f"cpu={cpu_seconds}:{cpu_seconds}",
        "--ulimit", f"fsize={max_file_bytes}:{max_file_bytes}",
    ]
    for mount in mounts or []:
        argv += ["--mount", mount]
    if workdir:
        argv += ["--workdir", workdir]
    for key, value in {"TMPDIR": "/tmp", "LANG": "C.UTF-8", **(env or {})}.items():
        argv += ["-e", f"{key}={value}"]
    argv.append(image)
    return argv


async def kill_container(name: str) -> None:
    """Killing the docker client would leave the container running, so kill by name."""
    try:
        killer = await asyncio.create_subprocess_exec(
            DOCKER_BIN, "kill", name,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
        )
        await asyncio.wait_for(killer.wait(), 10)
    except (OSError, asyncio.TimeoutError):
        logger.warning("Could not kill container %s", name)


def check_image(image: str) -> str | None:
    """Return None if Docker works and `image` exists, else a short problem description."""
    if shutil.which(DOCKER_BIN) is None:
        return f"'{DOCKER_BIN}' was not found"
    try:
        done = subprocess.run(
            [DOCKER_BIN, "image", "inspect", image],
            capture_output=True, timeout=15, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"Docker did not respond ({exc.__class__.__name__})"
    if done.returncode != 0:
        detail = done.stderr.decode("utf-8", errors="replace").strip().splitlines()
        return detail[-1] if detail else f"image '{image}' not found"
    return None


def verify_configured() -> dict[str, str | None]:
    """Check every enabled sandbox at startup. Maps worker name -> problem (None = ready).

    Workers without a sandbox enabled are omitted."""
    from app.services import math_runner, r_runner  # lazy: they import this module

    status: dict[str, str | None] = {}
    if r_runner.DOCKER_SANDBOX:
        status["r"] = check_image(r_runner.DOCKER_IMAGE)
    if math_runner.DOCKER_SANDBOX:
        status["math"] = check_image(math_runner.DOCKER_IMAGE)
    for worker, problem in status.items():
        if problem:
            logger.error("%s sandbox is enabled but not usable, jobs will fail: %s", worker, problem)
        else:
            logger.info("%s sandbox ready", worker)
    return status
