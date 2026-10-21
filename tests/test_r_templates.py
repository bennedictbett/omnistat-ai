"""Curve-fit templates: recover known parameters from synthetic data."""
import asyncio
import shutil

import numpy as np
import pandas as pd
import pytest

from app.services.r_templates import TemplateError, run_named_test

needs_r = pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")


def _run(test, variables, df):
    return asyncio.run(run_named_test(test, variables, df))


def _params(out):
    return {row["parameter"]: row for row in out["results"]["parameters"]}


def _dose_response(n=12, seed=1):
    rng = np.random.default_rng(seed)
    conc = np.logspace(-9, -3, n)
    resp = 5 + 95 / (1 + (1e-6 / conc)) + rng.normal(0, 2, n)
    return pd.DataFrame({"conc": conc, "resp": resp})


@needs_r
def test_4pl_recovers_ec50_and_hill():
    out = _run("dose_response_4pl", {"x": "conc", "y": "resp"}, _dose_response())
    assert out["ok"], out["error"]
    res = out["results"]
    assert res["ec50"] == pytest.approx(1e-6, rel=0.15)
    assert res["hill_slope"] == pytest.approx(1.0, abs=0.2)
    lo, hi = res["ec50_ci_95"]
    assert lo < res["ec50"] < hi
    assert res["r_squared"] > 0.99


@needs_r
def test_4pl_returns_curve_points_and_parameters():
    out = _run("dose_response_4pl", {"x": "conc", "y": "resp"}, _dose_response())
    res = out["results"]
    assert len(res["curve"]) == 100
    assert len(res["points"]) == 12
    assert len(res["residuals"]) == 12
    assert set(_params(out)) == {"left_asymptote", "right_asymptote", "log10_ec50", "scale"}
    assert all(r["lwr"] <= r["fit"] <= r["upr"] for r in res["curve"])


@needs_r
def test_4pl_drops_zero_concentration_controls():
    df = pd.concat([pd.DataFrame({"conc": [0.0], "resp": [4.0]}), _dose_response()], ignore_index=True)
    out = _run("dose_response_4pl", {"x": "conc", "y": "resp"}, df)
    assert out["ok"], out["error"]
    assert out["results"]["excluded_zero_concentration_points"] == 1
    assert out["results"]["n"] == 12


@needs_r
def test_4pl_rejects_too_few_points():
    out = _run("dose_response_4pl", {"x": "conc", "y": "resp"}, _dose_response().head(5))
    assert out["ok"] is False
    assert "at least 6" in str(out["error"])


@needs_r
def test_michaelis_menten_recovers_vmax_and_km():
    rng = np.random.default_rng(1)
    s = np.array([0.5, 1, 2, 4, 8, 16, 32, 64], dtype=float)
    df = pd.DataFrame({"s": s, "v": 50 * s / (4 + s) + rng.normal(0, 1, s.size)})
    out = _run("michaelis_menten", {"x": "s", "y": "v"}, df)
    assert out["ok"], out["error"]
    p = _params(out)
    assert p["Vmax"]["estimate"] == pytest.approx(50, rel=0.1)
    assert p["Km"]["estimate"] == pytest.approx(4, rel=0.25)
    assert out["results"]["r_squared"] > 0.99


def test_curve_fit_rejects_unknown_column():
    df = pd.DataFrame({"conc": [1.0, 2.0], "resp": [1.0, 2.0]})
    with pytest.raises(TemplateError):
        _run("dose_response_4pl", {"x": "nope", "y": "resp"}, df)