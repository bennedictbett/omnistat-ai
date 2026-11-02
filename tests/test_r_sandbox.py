import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services import r_runner


def _flag_value(argv, flag):
    return argv[argv.index(flag) + 1]


def test_docker_command_isolates_the_worker(tmp_path):
    argv = r_runner._docker_command(tmp_path, "omnistat-r-test")

    assert argv[:3] == [r_runner.DOCKER_BIN, "run", "--rm"]
    assert _flag_value(argv, "--network") == "none"
    assert "--read-only" in argv
    assert _flag_value(argv, "--cap-drop") == "ALL"
    assert _flag_value(argv, "--security-opt") == "no-new-privileges"
    assert _flag_value(argv, "--user") not in ("0", "0:0", "root")
    assert _flag_value(argv, "--memory") == _flag_value(argv, "--memory-swap")
    assert "--pids-limit" in argv and "--cpus" in argv
    assert argv[-4:] == [r_runner.DOCKER_IMAGE, "Rscript", "--vanilla", "wrapper.R"]
    mounts = [argv[i + 1] for i, a in enumerate(argv) if a == "--mount"]
    assert mounts == [f"type=bind,source={tmp_path},target=/work"]
    assert not any(a in ("--privileged", "--network=host") for a in argv)


def _enable_docker(monkeypatch, which=lambda name: name):
    monkeypatch.setattr(r_runner, "DOCKER_SANDBOX", True)
    monkeypatch.setattr(r_runner.shutil, "which", which)


def test_docker_mode_runs_r_only_inside_the_container(monkeypatch):
    seen = {}

    async def spawn(*args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        workdir = Path(args[args.index("--mount") + 1].split("source=")[1].split(",")[0])
        (workdir / "result.json").write_text('{"results":{"value":2},"error":null}')

        async def communicate():
            return b"", b""

        return SimpleNamespace(returncode=0, communicate=communicate)

    _enable_docker(monkeypatch)
    monkeypatch.setattr(r_runner.asyncio, "create_subprocess_exec", spawn)

    result = asyncio.run(r_runner._run_r_unlocked('emit("value", 2)'))

    assert result.ok and result.results == {"value": 2}
    assert seen["args"][1] == "run" and "Rscript" in seen["args"]
    assert "preexec_fn" not in seen["kwargs"]
    assert seen["kwargs"]["cwd"] is None


def test_docker_mode_fails_closed_without_docker(monkeypatch):
    async def spawn(*args, **kwargs):  # pragma: no cover - must not be reached
        raise AssertionError("R must not run on the host")

    _enable_docker(monkeypatch, which=lambda name: None)
    monkeypatch.setattr(r_runner.asyncio, "create_subprocess_exec", spawn)

    result = asyncio.run(r_runner._run_r_unlocked("emit('x', 1)"))

    assert not result.ok and "sandbox unavailable" in result.error


def test_docker_startup_failure_is_reported(monkeypatch):
    async def spawn(*args, **kwargs):
        async def communicate():
            return b"", b"Unable to find image 'omnistat-r-worker:latest' locally\n"

        return SimpleNamespace(returncode=125, communicate=communicate)

    _enable_docker(monkeypatch)
    monkeypatch.setattr(r_runner.asyncio, "create_subprocess_exec", spawn)

    result = asyncio.run(r_runner._run_r_unlocked("emit('x', 1)"))

    assert not result.ok
    assert "sandbox failed to start" in result.error and "Unable to find image" in result.error


def test_docker_timeout_kills_the_container(monkeypatch):
    killed = []

    class Proc:
        pid = 1234
        returncode = -9
        stopped = False

        async def communicate(self):
            if not self.stopped:
                await asyncio.sleep(60)
            return b"", b""

        def kill(self):
            self.stopped = True

    proc = Proc()

    async def spawn(*args, **kwargs):
        async def wait():
            return 0

        if args[1] == "run":
            return proc
        if args[1] == "kill":
            killed.append(args[2])
            proc.stopped = True
        return SimpleNamespace(wait=wait)

    _enable_docker(monkeypatch)
    monkeypatch.setattr(r_runner, "POSIX", False)
    monkeypatch.setattr(r_runner.asyncio, "create_subprocess_exec", spawn)

    result = asyncio.run(r_runner._run_r_unlocked("while(TRUE) {}", timeout=0.2))

    assert result.timed_out and not result.ok
    assert len(killed) == 1 and killed[0].startswith("omnistat-r-")


def test_windows_timeout_kills_process_tree_and_never_hangs(monkeypatch):
    calls = []

    class Proc:
        pid = 4321
        returncode = 1

        async def communicate(self):
            await asyncio.sleep(60)  # pipes held open by an orphaned R.exe

        def kill(self):
            calls.append("kill")

    async def spawn(*args, **kwargs):
        calls.append(args[0])

        async def wait():
            return 0

        return Proc() if args[0] != "taskkill" else SimpleNamespace(wait=wait)

    monkeypatch.setattr(r_runner, "DOCKER_SANDBOX", False)
    monkeypatch.setattr(r_runner, "POSIX", False)
    monkeypatch.setattr(r_runner, "DRAIN_SECONDS", 0.2)
    monkeypatch.setattr(r_runner.shutil, "which", lambda name: name)
    monkeypatch.setattr(r_runner.asyncio, "create_subprocess_exec", spawn)

    result = asyncio.run(asyncio.wait_for(r_runner._run_r_unlocked("while(TRUE) {}", timeout=0.2), 10))

    assert result.timed_out and not result.ok
    assert "taskkill" in calls
