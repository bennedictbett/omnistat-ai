import asyncio
import shutil

import numpy as np
import pandas as pd
import pytest

from app.services.r_runner import run_r
from app.services.r_templates import TEMPLATES, TemplateError, run_named_test

pytestmark = pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def two_groups():
    rng = np.random.default_rng(0)
    return pd.DataFrame({
        "bp": np.r_[rng.normal(140, 10, 40), rng.normal(130, 10, 40)],
        "arm": ["control"] * 40 + ["treated"] * 40,
    })


def test_basic_run_returns_results_and_plot():
    r = run(run_r('emit("x", 1 + 1); plot(1:3)'))
    assert r.ok and r.results["x"] == 2 and len(r.plots) == 1


def test_r_error_is_reported_not_raised():
    r = run(run_r('emit("before", 1); stop("boom")'))
    assert not r.ok and "boom" in r.error and r.results["before"] == 1


def test_timeout_kills_runaway_code():
    r = run(run_r("while(TRUE) {}", timeout=2))
    assert r.timed_out and not r.ok and r.duration_s < 10


def test_params_and_data_available():
    r = run(run_r('emit("m", mean(df[[params$col]]))', data_csv=b"a\n1\n2\n3\n", params={"col": "a"}))
    assert r.ok and r.results["m"] == 2


def test_na_becomes_null():
    r = run(run_r('emit("v", NA_real_)'))
    assert r.ok and r.results["v"] is None


def test_independent_t_test_matches_scipy(two_groups):
    from scipy import stats
    out = run(run_named_test("independent_t_test", {"outcome": "bp", "group": "arm"}, two_groups))
    assert out["ok"], out["error"]
    a = two_groups[two_groups.arm == "control"].bp
    b = two_groups[two_groups.arm == "treated"].bp
    ref = stats.ttest_ind(a, b, equal_var=False)
    assert out["results"]["p_value"] == pytest.approx(ref.pvalue, rel=1e-6)
    assert out["results"]["statistic_t"] == pytest.approx(ref.statistic, rel=1e-6)
    assert out["plots"]


def test_mann_whitney_matches_scipy(two_groups):
    from scipy import stats
    out = run(run_named_test("mann_whitney_u", {"outcome": "bp", "group": "arm"}, two_groups))
    assert out["ok"], out["error"]
    a = two_groups[two_groups.arm == "control"].bp
    b = two_groups[two_groups.arm == "treated"].bp
    ref = stats.mannwhitneyu(a, b, method="exact")
    assert out["results"]["p_value"] == pytest.approx(ref.pvalue, rel=1e-6)


def test_anova_matches_scipy():
    from scipy import stats
    rng = np.random.default_rng(1)
    df = pd.DataFrame({"y": np.r_[rng.normal(0, 1, 30), rng.normal(0.5, 1, 30), rng.normal(1, 1, 30)],
                       "g": ["a"] * 30 + ["b"] * 30 + ["c"] * 30})
    out = run(run_named_test("one_way_anova", {"outcome": "y", "group": "g"}, df))
    assert out["ok"], out["error"]
    ref = stats.f_oneway(*[df[df.g == k].y for k in "abc"])
    assert out["results"]["F"] == pytest.approx(ref.statistic, rel=1e-6)
    assert out["results"]["p_value"] == pytest.approx(ref.pvalue, rel=1e-6)
    assert len(out["results"]["post_hoc_tukey"]) == 3


def test_chi_square_and_pearson_and_shapiro(two_groups):
    from scipy import stats
    df = two_groups.assign(high=(two_groups.bp > 135).map({True: "yes", False: "no"}))
    out = run(run_named_test("chi_square", {"var1": "arm", "var2": "high"}, df))
    assert out["ok"], out["error"]
    ref = stats.chi2_contingency(pd.crosstab(df.arm, df.high))  # Yates for 2x2
    assert out["results"]["p_value"] == pytest.approx(ref[1], rel=1e-6)

    rng = np.random.default_rng(2)
    c = pd.DataFrame({"x": rng.normal(size=50)}); c["y"] = c.x * 2 + rng.normal(size=50)
    out = run(run_named_test("pearson_correlation", {"x": "x", "y": "y"}, c))
    assert out["results"]["r"] == pytest.approx(stats.pearsonr(c.x, c.y)[0], rel=1e-6)

    out = run(run_named_test("shapiro_wilk", {"variable": "x"}, c))
    assert out["results"]["p_value"] == pytest.approx(stats.shapiro(c.x).pvalue, rel=1e-4)


def test_validation_errors(two_groups):
    with pytest.raises(TemplateError):
        run(run_named_test("nope", {}, two_groups))
    with pytest.raises(TemplateError):
        run(run_named_test("independent_t_test", {"outcome": "bp"}, two_groups))
    with pytest.raises(TemplateError):
        run(run_named_test("independent_t_test", {"outcome": "bp", "group": "missing"}, two_groups))


def test_column_names_cannot_inject_code(two_groups):
    evil = two_groups.rename(columns={"bp": 'x"); system("touch /tmp/pwned"); ("'})
    col = evil.columns[0]
    out = run(run_named_test("independent_t_test", {"outcome": col, "group": "arm"}, evil))
    assert out["ok"], out["error"]  # treated purely as data
    import os
    assert not os.path.exists("/tmp/pwned")


def test_all_templates_have_roles():
    assert all(t.roles for t in TEMPLATES.values())