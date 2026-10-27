import asyncio
import base64
import hashlib
import io
import json
import shutil
import subprocess
import zipfile
from unittest.mock import AsyncMock

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security import rate_limit
from app.services import r_templates
from app.services.analysis_plan import prepare_analysis_plan
from app.services.reproducibility_bundle import BundleError, BundleResult, build_bundle


@pytest.fixture
def snapshot():
    rows = [{"blood pressure": value, "unused": "private"} for value in [1.0, 2.5, 3.0, 5.0, None]]
    variables = {"variable": "blood pressure"}
    df = pd.DataFrame(rows)
    csv = r_templates.prepare_test_data("shapiro_wilk", variables, df)
    digest = hashlib.sha256(csv).hexdigest()
    version = "R fixture version"
    result = BundleResult(
        ok=True, test="shapiro_wilk", title="Normality", variables=variables,
        results={"W": 0.9, "p_value": 0.4}, error=None, timed_out=False, duration_s=0.1,
        plots=[base64.b64encode(b"\x89PNG\r\n\x1a\nfixture").decode()],
        code=r_templates._script_for(r_templates.TEMPLATES["shapiro_wilk"], variables, digest, version),
        data_sha256=digest, r_version=version,
        analysis_plan=prepare_analysis_plan("shapiro_wilk", variables, df),
    )
    return result, rows, csv


def test_archive_has_exact_data_code_plan_plots_and_verified_manifest(snapshot, monkeypatch):
    result, rows, csv = snapshot
    runner = AsyncMock()
    monkeypatch.setattr(r_templates, "run_r", runner)
    archive = build_bundle(result, rows)
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        assert set(zipped.namelist()) == {
            "data.csv", "analysis.R", "results.json", "analysis-plan.json",
            "plots/plot-01.png", "manifest.json", "README.txt",
        }
        assert zipped.read("data.csv") == csv
        assert b"unused" not in csv and b"private" not in csv
        assert zipped.read("analysis.R").decode() == result.code
        assert json.loads(zipped.read("analysis-plan.json")) == result.analysis_plan.model_dump()
        manifest = json.loads(zipped.read("manifest.json"))
        assert manifest["data_sha256"] == hashlib.sha256(csv).hexdigest()
        assert manifest["rows_exported"] == 5
        for name, metadata in manifest["files"].items():
            content = zipped.read(name)
            assert metadata == {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
    runner.assert_not_awaited()


@pytest.mark.parametrize("change", ["data", "script", "failure", "timeout", "plan", "plot", "non_png", "version"])
def test_mismatched_or_invalid_snapshots_cannot_export(snapshot, change):
    result, rows, _ = snapshot
    if change == "data":
        rows[0]["blood pressure"] = 99
    elif change == "script":
        result.code += "\nprint('changed')"
    elif change == "failure":
        result.ok = False
    elif change == "timeout":
        result.timed_out = True
    elif change == "plan":
        result.analysis_plan.outputs = []
    elif change == "plot":
        result.plots = ["not a PNG"]
    elif change == "non_png":
        result.plots = [base64.b64encode(b"not an image").decode()]
    else:
        result.r_version = None
    with pytest.raises(BundleError):
        build_bundle(result, rows)


def test_legacy_result_without_reviewed_plan_is_exportable(snapshot):
    result, rows, _ = snapshot
    result.analysis_plan = None
    result = BundleResult.model_validate({**result.model_dump(), "duration_s": 0})
    with zipfile.ZipFile(io.BytesIO(build_bundle(result, rows))) as zipped:
        assert "analysis-plan.json" not in zipped.namelist()
        assert json.loads(zipped.read("results.json"))["analysis_plan"] is None


def test_size_limit_and_non_json_results_are_explicit(snapshot, monkeypatch):
    from app.services import reproducibility_bundle
    result, rows, _ = snapshot
    monkeypatch.setattr(reproducibility_bundle, "MAX_BUNDLE_BYTES", 10)
    with pytest.raises(BundleError, match="20 MB"):
        build_bundle(result, rows)
    result.results["bad"] = float("nan")
    with pytest.raises(BundleError, match="JSON"):
        build_bundle(result, rows)


def test_bundle_endpoint_requires_auth_has_no_store_and_rate_limits(snapshot, monkeypatch):
    result, rows, _ = snapshot
    monkeypatch.setenv("OMNISTAT_API_KEYS", "export-test")
    monkeypatch.setenv("R_RATE_LIMIT_PER_MIN", "1")
    rate_limit.reset()
    try:
        client = TestClient(app)
        body = {"result": result.model_dump(), "data": rows}
        assert client.post("/api/r/bundle", json=body).status_code == 401
        response = client.post("/api/r/bundle", json=body, headers={"X-API-Key": "export-test"})
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert response.headers["cache-control"] == "no-store"
        assert zipfile.is_zipfile(io.BytesIO(response.content))
        assert client.post("/api/r/bundle", json=body, headers={"X-API-Key": "export-test"}).status_code == 429
    finally:
        rate_limit.reset()


@pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")
def test_real_bundle_reproduces_numeric_result_with_non_syntactic_column_name(tmp_path):
    rows = [{"blood pressure": value} for value in [1.0, 2.5, 3.0, 5.0, 8.0]]
    result = asyncio.run(r_templates.run_named_test(
        "shapiro_wilk", {"variable": "blood pressure"}, pd.DataFrame(rows)))
    assert result["ok"], result["error"]
    archive = build_bundle(BundleResult.model_validate(result), rows)
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        zipped.extractall(tmp_path)
    completed = subprocess.run(["Rscript", "analysis.R"], cwd=tmp_path, capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    import re
    match = re.search(r"== p_value ==\s*\[1\]\s*([0-9.eE+-]+)", completed.stdout)
    assert match, completed.stdout
    assert float(match.group(1)) == pytest.approx(result["results"]["p_value"], rel=1e-5)
    assert (tmp_path / "Rplots.pdf").exists()
