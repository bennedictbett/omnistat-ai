import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.services import math_runner, r_runner


@pytest.mark.parametrize("runner", [math_runner, r_runner])
@pytest.mark.parametrize("platform", ["darwin", "linux"])
def test_worker_limits_preserve_supported_controls(monkeypatch, runner, platform):
    calls = []
    resource = SimpleNamespace(
        RLIMIT_CPU="cpu",
        RLIMIT_AS="address_space",
        RLIMIT_FSIZE="file_size",
        setrlimit=lambda kind, limits: calls.append((kind, limits)),
    )
    monkeypatch.setattr(runner, "resource", resource)
    monkeypatch.setattr(runner, "sys", SimpleNamespace(platform=platform))
    if runner is math_runner:
        monkeypatch.setattr(math_runner.os, "setsid", lambda: None)
        apply_limits = math_runner._limits
        file_limit = 1024**2
    else:
        apply_limits = r_runner._apply_limits
        file_limit = r_runner.MAX_FILE_BYTES

    apply_limits()

    expected = [("cpu", (runner.CPU_SECONDS, runner.CPU_SECONDS))]
    if platform != "darwin":
        expected.append(("address_space", (runner.MEMORY_BYTES, runner.MEMORY_BYTES)))
    expected.append(("file_size", (file_limit, file_limit)))
    assert calls == expected


@pytest.mark.parametrize("runner", [math_runner, r_runner])
def test_unexpected_limit_errors_are_not_suppressed(monkeypatch, runner):
    def fail(*args):
        raise ValueError("invalid limit")

    monkeypatch.setattr(runner, "resource", SimpleNamespace(RLIMIT_CPU="cpu", setrlimit=fail))
    if runner is math_runner:
        monkeypatch.setattr(math_runner.os, "setsid", lambda: None)
        apply_limits = math_runner._limits
    else:
        apply_limits = r_runner._apply_limits

    with pytest.raises(ValueError, match="invalid limit"):
        apply_limits()


@pytest.mark.parametrize("configured", ["Rscript", "/custom/bin/Rscript"])
def test_r_executable_is_resolved_before_restricting_path(monkeypatch, configured):
    seen = {}
    resolved = "/custom/bin/Rscript"

    def which(name):
        assert name == configured
        return resolved

    async def spawn(*args, **kwargs):
        seen["args"] = args
        seen["env"] = kwargs["env"]
        Path(kwargs["cwd"], "result.json").write_text('{"results":{"value":2},"error":null}')

        async def communicate():
            return b"", b""

        return SimpleNamespace(returncode=0, communicate=communicate)

    monkeypatch.setattr(r_runner, "POSIX", True)
    monkeypatch.setattr(r_runner, "RSCRIPT", configured)
    monkeypatch.setattr(r_runner.shutil, "which", which)
    monkeypatch.setattr(r_runner.asyncio, "create_subprocess_exec", spawn)

    result = asyncio.run(r_runner._run_r_unlocked('emit("value", 2)'))

    assert result.ok and result.results == {"value": 2}
    assert seen["args"] == (resolved, "--vanilla", "wrapper.R")
    assert seen["env"]["PATH"] == "/usr/local/bin:/usr/bin:/bin"
