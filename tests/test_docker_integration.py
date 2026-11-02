"""Real-container checks. Skipped unless Docker and the worker images are available.

Build the images first:
    docker build -f Dockerfile.rworker -t omnistat-r-worker .
    docker build -f Dockerfile.mathworker -t omnistat-math-worker .
"""
import asyncio
import time

import pytest

from app.services import docker_sandbox, math_runner, r_runner


def _missing(image):
    return docker_sandbox.check_image(image)


needs_r = pytest.mark.skipif(_missing(r_runner.DOCKER_IMAGE) is not None, reason="R worker image unavailable")
needs_math = pytest.mark.skipif(_missing(math_runner.DOCKER_IMAGE) is not None, reason="math worker image unavailable")


@pytest.fixture
def sandboxed(monkeypatch):
    monkeypatch.setattr(r_runner, "DOCKER_SANDBOX", True)
    monkeypatch.setattr(math_runner, "DOCKER_SANDBOX", True)


@needs_r
def test_r_job_runs_in_container(sandboxed):
    r = asyncio.run(r_runner.run_r('emit("x", 1 + 1); plot(1:3)'))
    assert r.ok and r.results["x"] == 2 and len(r.plots) == 1


@needs_r
def test_r_container_has_no_network_and_read_only_root(sandboxed):
    code = (
        'emit("net", tryCatch({readLines(url("http://example.com"), 1); "online"},'
        ' error=function(e) "blocked", warning=function(w) "blocked"));'
        'emit("fs", tryCatch({writeLines("x", "/etc/pwn"); "wrote"},'
        ' error=function(e) "denied", warning=function(w) "denied"))'
    )
    r = asyncio.run(r_runner.run_r(code))
    assert r.ok and r.results == {"net": "blocked", "fs": "denied"}


@needs_r
def test_r_timeout_kills_container(sandboxed):
    started = time.monotonic()
    r = asyncio.run(r_runner.run_r("while(TRUE) {}", timeout=3))
    assert r.timed_out and time.monotonic() - started < 30


@needs_math
def test_math_runs_in_container(sandboxed):
    out = asyncio.run(math_runner.run_math({"operation": "derivative", "expression": "x^2 sin(x)"}))
    assert out["result_text"] == "x^2*cos(x) + 2*x*sin(x)"


@needs_math
def test_math_timeout_is_enforced_in_container(sandboxed, monkeypatch):
    monkeypatch.setattr(math_runner, "TIMEOUT_SECONDS", 3)
    with pytest.raises(math_runner.MathTimeout):
        asyncio.run(math_runner.run_math({"operation": "simplify", "expression": "9^9^9^9"}))
