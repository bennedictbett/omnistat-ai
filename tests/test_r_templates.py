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


def _regression_df(n=200, seed=11):
    rng = np.random.default_rng(seed)
    dose = rng.normal(0, 1, n)
    age = rng.normal(0, 1, n)
    y = 3 + 2 * dose - 1.5 * age + rng.normal(0, 0.5, n)
    return pd.DataFrame({"response": y, "dose": dose, "age": age, "arm": rng.choice(["a", "b"], n)})


def _logistic_df(n=500, seed=21, labels=(0, 1)):
    rng = np.random.default_rng(seed)
    x = rng.normal(0, 1, n)
    z = rng.normal(0, 1, n)
    prob = 1 / (1 + np.exp(-(-0.5 + 1.0 * x)))
    y = rng.binomial(1, prob)
    return pd.DataFrame({"outcome": np.where(y == 1, labels[1], labels[0]), "x": x, "z": z})


def _coef(out, term):
    return next(r for r in out["results"]["coefficients"] if r["term"] == term)


def test_regression_templates_have_optional_predictors():
    cat = supported_tests()
    for name in ("linear_regression", "logistic_regression"):
        assert "predictor_1" in cat[name]["variables"]
        assert "predictor_1" not in cat[name]["optional"]
        assert "predictor_2" in cat[name]["optional"]


def test_regression_requires_outcome_and_rejects_unknown_roles():
    df = _regression_df()
    with pytest.raises(TemplateError):
        _run("linear_regression", {"predictor_1": "dose"}, df)
    with pytest.raises(TemplateError):
        _run("linear_regression", {"outcome": "response", "predictor_1": "dose", "predictor_9": "age"}, df)


@needs_r
def test_linear_regression_recovers_coefficients():
    out = _run("linear_regression", {"outcome": "response", "predictor_1": "dose", "predictor_2": "age"}, _regression_df())
    assert out["ok"], out["error"]
    res = out["results"]
    assert _coef(out, "dose")["estimate"] == pytest.approx(2.0, abs=0.15)
    assert _coef(out, "age")["estimate"] == pytest.approx(-1.5, abs=0.15)
    assert _coef(out, "(Intercept)")["estimate"] == pytest.approx(3.0, abs=0.15)
    assert res["r_squared"] > 0.9
    assert res["p_value"] < 1e-6
    assert res["n_used"] == 200
    assert len(res["vif"]) == 2


@needs_r
def test_linear_regression_handles_categorical_predictor_and_missing_values():
    df = _regression_df()
    df.loc[:9, "dose"] = np.nan
    out = _run("linear_regression", {"outcome": "response", "predictor_1": "dose", "predictor_2": "arm"}, df)
    assert out["ok"], out["error"]
    assert out["results"]["n_dropped_missing"] == 10
    terms = [r["term"] for r in out["results"]["coefficients"]]
    assert "armb" in terms


@needs_r
def test_linear_regression_rejects_collinear_predictors():
    df = _regression_df()
    df["dose_copy"] = df["dose"] * 2
    out = _run("linear_regression", {"outcome": "response", "predictor_1": "dose", "predictor_2": "dose_copy"}, df)
    assert out["ok"] is False
    assert "collinear" in str(out["error"])


@needs_r
def test_logistic_regression_recovers_odds_ratio():
    out = _run("logistic_regression", {"outcome": "outcome", "predictor_1": "x", "predictor_2": "z"}, _logistic_df())
    assert out["ok"], out["error"]
    res = out["results"]
    assert 1.8 < _coef(out, "x")["odds_ratio"] < 4.0
    assert _coef(out, "x")["or_lwr"] < _coef(out, "x")["odds_ratio"] < _coef(out, "x")["or_upr"]
    assert res["auc"] > 0.6
    assert res["p_value"] < 0.001
    assert res["event"] == "1"
    assert res["n_events"] + 0 > 5


@needs_r
def test_logistic_regression_uses_text_labels():
    df = _logistic_df(labels=("no", "yes"))
    out = _run("logistic_regression", {"outcome": "outcome", "predictor_1": "x"}, df)
    assert out["ok"], out["error"]
    assert out["results"]["event"] == "yes"
    assert out["results"]["reference"] == "no"


@needs_r
def test_logistic_regression_rejects_three_level_outcome():
    df = _logistic_df()
    df.loc[:20, "outcome"] = 2
    out = _run("logistic_regression", {"outcome": "outcome", "predictor_1": "x"}, df)
    assert out["ok"] is False
    assert "exactly 2" in str(out["error"])


@needs_r
def test_logistic_regression_rejects_too_few_events():
    df = _logistic_df()
    df["outcome"] = 0
    df.loc[:2, "outcome"] = 1
    out = _run("logistic_regression", {"outcome": "outcome", "predictor_1": "x"}, df)
    assert out["ok"] is False
    assert "Too few" in str(out["error"])


@needs_r
def test_linear_regression_matches_numpy_reference():
    from scipy.stats import chi2

    df = _regression_df()
    out = _run("linear_regression", {"outcome": "response", "predictor_1": "dose", "predictor_2": "age"}, df)
    assert out["ok"], out["error"]

    X = np.column_stack([np.ones(len(df)), df["dose"], df["age"]])
    y = df["response"].to_numpy()
    bread = np.linalg.inv(X.T @ X)
    beta = bread @ X.T @ y
    e = y - X @ beta
    h = np.einsum("ij,jk,ik->i", X, bread, X)
    Xw = X * (e / (1 - h))[:, None]
    se_hc3 = np.sqrt(np.diag(bread @ (Xw.T @ Xw) @ bread))

    e2 = e**2
    fitted_e2 = X @ np.linalg.solve(X.T @ X, X.T @ e2)
    r2 = 1 - np.sum((e2 - fitted_e2) ** 2) / np.sum((e2 - e2.mean()) ** 2)
    bp_p = chi2.sf(len(y) * r2, X.shape[1] - 1)

    rows = {r["term"]: r for r in out["results"]["coefficients"]}
    for term, i in [("(Intercept)", 0), ("dose", 1), ("age", 2)]:
        assert rows[term]["estimate"] == pytest.approx(beta[i], rel=1e-6)
        assert rows[term]["se_hc3"] == pytest.approx(se_hc3[i], rel=1e-5)
    assert out["results"]["assumption_breusch_pagan_p"] == pytest.approx(bp_p, rel=1e-4)