"""Curve-fit templates: recover known parameters from synthetic data."""
import asyncio
import shutil

import numpy as np
import pandas as pd
import pytest

from app.services.r_templates import TemplateError, run_named_test, supported_tests

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


def _paired_df(seed=3, n=30, shift=2.0):
    rng = np.random.default_rng(seed)
    a = rng.normal(50, 5, n)
    return pd.DataFrame({"before": a, "after": a - shift + rng.normal(0, 1, n)})


def _three_groups(seed=5):
    rng = np.random.default_rng(seed)
    rows = [(name, v) for name, mu in [("A", 10), ("B", 14), ("C", 18)] for v in rng.normal(mu, 3, 15)]
    return pd.DataFrame(rows, columns=["group", "score"])


def test_new_tests_are_registered():
    assert {"paired_t_test", "wilcoxon_signed_rank", "kruskal_wallis"} <= set(supported_tests())


@needs_r
def test_paired_t_recovers_mean_difference():
    out = _run("paired_t_test", {"first": "before", "second": "after"}, _paired_df())
    assert out["ok"], out["error"]
    res = out["results"]
    assert res["mean_difference"] == pytest.approx(2.0, abs=0.5)
    assert res["p_value"] < 0.001
    assert res["n_pairs"] == 30
    lo, hi = res["ci_95"]
    assert lo < res["mean_difference"] < hi


@needs_r
def test_wilcoxon_detects_shift():
    out = _run("wilcoxon_signed_rank", {"first": "before", "second": "after"}, _paired_df())
    assert out["ok"], out["error"]
    res = out["results"]
    assert res["p_value"] < 0.001
    assert res["rank_biserial_r"] > 0.8
    assert res["hodges_lehmann_shift"] == pytest.approx(2.0, abs=0.5)


@needs_r
def test_wilcoxon_rejects_identical_columns():
    df = pd.DataFrame({"a": [1.0, 2.0, 3.0, 4.0], "b": [1.0, 2.0, 3.0, 4.0]})
    out = _run("wilcoxon_signed_rank", {"first": "a", "second": "b"}, df)
    assert out["ok"] is False
    assert "non-zero" in str(out["error"])


@needs_r
def test_kruskal_wallis_detects_group_differences():
    out = _run("kruskal_wallis", {"outcome": "score", "group": "group"}, _three_groups())
    assert out["ok"], out["error"]
    res = out["results"]
    assert res["p_value"] < 0.001
    assert res["epsilon_squared"] > 0.3
    assert res["df"] == 2
    assert len(res["post_hoc_pairwise"]) == 3
    assert len(res["groups"]) == 3


@needs_r
def test_kruskal_wallis_rejects_two_groups():
    df = _three_groups()
    df = df[df["group"] != "C"]
    out = _run("kruskal_wallis", {"outcome": "score", "group": "group"}, df)
    assert out["ok"] is False
    assert "3+ groups" in str(out["error"])