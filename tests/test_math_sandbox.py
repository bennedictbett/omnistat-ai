import asyncio
from types import SimpleNamespace

import pytest

from app.services import docker_sandbox, math_runner, r_runner


def _enable(monkeypatch, which=lambda name: name):
    monkeypatch.setattr(math_runner, "DOCKER_SANDBOX", True)
    monkeypatch.setattr(math_runner.shutil, "which", which)


def _spawn_returning(returncode, stdout=b"", stderr=b"", seen=None):
    async def spawn(*args, **kwargs):
        if seen is not None:
            seen["args"], seen["kwargs"] = args, kwargs

        async def communicate(data=None):
            if seen is not None:
                seen["stdin"] = data
            return stdout, stderr

        return SimpleNamespace(returncode=returncode, communicate=communicate)

    return spawn


def test_math_container_is_isolated_and_gets_request_on_stdin(monkeypatch):
    seen = {}
    _enable(monkeypatch)
    monkeypatch.setattr(
        math_runner.asyncio, "create_subprocess_exec",
        _spawn_returning(0, b'{"result_text": "2*x"}', seen=seen),
    )

    out = asyncio.run(math_runner.run_math({"operation": "derivative", "expression": "x^2"}))

    argv = list(seen["args"])
    assert out == {"result_text": "2*x"}
    assert argv[argv.index("--network") + 1] == "none"
    assert "--read-only" in argv and "-i" in argv
    assert argv[argv.index("--cap-drop") + 1] == "ALL"
    assert "--mount" not in argv  # nothing from the host is visible
    assert argv[-3:] == ["python", "-I", "/app/math_engine.py"]
    assert b"derivative" in seen["stdin"]
    assert "preexec_fn" not in seen["kwargs"]


def test_math_docker_fails_closed_without_docker(monkeypatch):
    async def spawn(*args, **kwargs):  # pragma: no cover - must not be reached
        raise AssertionError("the engine must not run on the host")

    _enable(monkeypatch, which=lambda name: None)
    monkeypatch.setattr(math_runner.asyncio, "create_subprocess_exec", spawn)

    with pytest.raises(math_runner.MathFailure, match="sandbox is unavailable"):
        asyncio.run(math_runner.run_math({"operation": "derivative", "expression": "x"}))


def test_math_docker_startup_failure_is_a_failure_not_a_timeout(monkeypatch):
    _enable(monkeypatch)
    monkeypatch.setattr(
        math_runner.asyncio, "create_subprocess_exec",
        _spawn_returning(125, stderr=b"Unable to find image"),
    )

    with pytest.raises(math_runner.MathFailure, match="sandbox is unavailable"):
        asyncio.run(math_runner.run_math({"operation": "derivative", "expression": "x"}))


@pytest.mark.parametrize("code", math_runner.CONTAINER_LIMIT_CODES)
def test_math_container_limit_exit_codes_report_limit(monkeypatch, code):
    _enable(monkeypatch)
    monkeypatch.setattr(math_runner.asyncio, "create_subprocess_exec", _spawn_returning(code))

    with pytest.raises(math_runner.MathTimeout):
        asyncio.run(math_runner.run_math({"operation": "derivative", "expression": "x"}))


def test_math_timeout_kills_the_container(monkeypatch):
    killed = []

    class Proc:
        pid = 99
        returncode = None

        async def communicate(self, data=None):
            await asyncio.sleep(60)

        def kill(self):
            self.returncode = -9

        async def wait(self):
            return self.returncode

    proc = Proc()

    async def spawn(*args, **kwargs):
        async def wait():
            return 0

        if args[1] == "run":
            return proc
        if args[1] == "kill":
            killed.append(args[2])
        return SimpleNamespace(wait=wait)

    _enable(monkeypatch)
    monkeypatch.setattr(math_runner, "TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(math_runner, "DOCKER_STARTUP_SECONDS", 0)
    monkeypatch.setattr(math_runner.os, "name", "nt")
    monkeypatch.setattr(math_runner.asyncio, "create_subprocess_exec", spawn)

    with pytest.raises(math_runner.MathTimeout):
        asyncio.run(math_runner.run_math({"operation": "derivative", "expression": "x"}))

    assert len(killed) == 1 and killed[0].startswith("omnistat-math-")


def test_verify_reports_only_enabled_sandboxes(monkeypatch):
    monkeypatch.setattr(r_runner, "DOCKER_SANDBOX", False)
    monkeypatch.setattr(math_runner, "DOCKER_SANDBOX", False)
    assert docker_sandbox.verify_configured() == {}

    monkeypatch.setattr(r_runner, "DOCKER_SANDBOX", True)
    monkeypatch.setattr(math_runner, "DOCKER_SANDBOX", True)
    monkeypatch.setattr(
        docker_sandbox, "check_image",
        lambda image: None if image == r_runner.DOCKER_IMAGE else "No such image",
    )
    assert docker_sandbox.verify_configured() == {"r": None, "math": "No such image"}


def test_check_image_handles_missing_docker(monkeypatch):
    monkeypatch.setattr(docker_sandbox.shutil, "which", lambda name: None)
    assert "not found" in docker_sandbox.check_image("anything")


def test_health_reports_sandbox_without_leaking_details():
    from fastapi.testclient import TestClient

    from app.main import app

    app.state.sandbox = {"r": None, "math": "secret docker detail"}
    try:
        body = TestClient(app).get("/health").json()
    finally:
        del app.state.sandbox
    assert body == {"status": "ok", "sandbox": {"r": "ready", "math": "unavailable"}}
    assert TestClient(app).get("/health").json() == {"status": "ok"}
