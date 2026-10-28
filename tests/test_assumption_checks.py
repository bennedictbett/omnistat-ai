import json
import shutil
import subprocess
from unittest.mock import AsyncMock

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api.routes import r_analysis
from app.main import app
from app.security import rate_limit
from app.services.analysis_plan import prepare_analysis_plan
from app.services.assumption_checks import check_assumptions
from app.services.r_templates import TemplateError

rng = np.random.default_rng(7)
NORMAL_A = [round(x, 4) for x in rng.normal(10, 1, 20)]
NORMAL_B = [round(x, 4) for x in rng.normal(12, 1, 20)]
SKEWED = [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 4, 5, 8, 13, 21, 40, 90]


def groups(**values):
    return pd.DataFrame([{"bp": x, "arm": g} for g, xs in values.items() for x in xs])


def by_id(report):
    return {c.id: c for c in report.checks}


def test_normal_groups_pass_without_suggestion():
    report = check_assumptions("independent_t_test", {"group": "arm", "outcome": "bp"}, groups(A=NORMAL_A, B=NORMAL_B))
    checks = by_id(report)
    assert checks["normality:A"].status == checks["normality:B"].status == "ok"
    assert checks["equal_variances"].status == "info"
    assert "does not assume equal variances" in checks["equal_variances"].detail
    assert report.suggestion is None
    assert report.variables == {"outcome": "bp", "group": "arm"}
    assert report.data_sha256 == prepare_analysis_plan(
        "independent_t_test", {"outcome": "bp", "group": "arm"}, groups(A=NORMAL_A, B=NORMAL_B)).data_sha256
    assert any("Independence" in note for note in report.notes)


def test_small_skewed_groups_suggest_rank_based_alternative_and_flag_outliers():
    report = check_assumptions("independent_t_test", {"outcome": "bp", "group": "arm"}, groups(A=SKEWED, B=NORMAL_B))
    checks = by_id(report)
    assert checks["normality:A"].status == "warning" and checks["normality:A"].p_value < 0.05
    assert checks["outliers:A"].status == "warning"
    assert report.suggestion.test == "mann_whitney_u"
    assert "distributions rather than means" in report.suggestion.reason


def test_large_skewed_groups_note_robustness_instead_of_switching():
    big = SKEWED * 2
    report = check_assumptions("independent_t_test", {"outcome": "bp", "group": "arm"}, groups(A=big, B=NORMAL_B * 2))
    assert by_id(report)["normality:A"].status == "warning"
    assert report.suggestion is None
    assert any("usually robust" in note for note in report.notes)


def test_anova_uses_residuals_and_warns_on_unequal_variances():
    tight = [10 + 0.01 * i for i in range(10)]
    wide = [10 + 5 * ((-1) ** i) * i for i in range(10)]
    report = check_assumptions("one_way_anova", {"outcome": "bp", "group": "arm"},
                               groups(A=tight, B=[x + 1 for x in tight], C=wide))
    checks = by_id(report)
    assert "normality:residuals" in checks and checks["normality:residuals"].n == 30
    assert checks["equal_variances"].status == "warning"
    assert "interpret them cautiously" in checks["equal_variances"].detail


def test_skewed_anova_suggests_kruskal_wallis():
    report = check_assumptions("one_way_anova", {"outcome": "bp", "group": "arm"},
                               groups(A=SKEWED, B=NORMAL_A, C=NORMAL_B))
    assert report.suggestion.test == "kruskal_wallis"


def test_paired_differences_and_wilcoxon_suggestion():
    df = pd.DataFrame({"before": [x + 5 for x in SKEWED], "after": [5.0] * 20})
    report = check_assumptions("paired_t_test", {"first": "before", "second": "after"}, df)
    assert by_id(report)["normality:differences"].status == "warning"
    assert report.suggestion.test == "wilcoxon_signed_rank"


def test_pearson_points_to_reported_spearman():
    df = pd.DataFrame({"x": SKEWED, "y": NORMAL_A})
    report = check_assumptions("pearson_correlation", {"x": "x", "y": "y"}, df)
    assert report.suggestion.test is None and "Spearman" in report.suggestion.title
    assert any("scatter plot" in note for note in report.notes)


def test_shapiro_procedure_and_limits_are_explicit():
    report = check_assumptions("shapiro_wilk", {"variable": "bp"}, pd.DataFrame({"bp": NORMAL_A}))
    assert report.checks == [] and "itself a normality check" in report.notes[0]
    constant = check_assumptions("independent_t_test", {"outcome": "bp", "group": "arm"},
                                 groups(A=[1, 1, 1], B=[1, 2, 3]))
    checks = by_id(constant)
    assert checks["normality:A"].status == "not_assessed"
    assert checks["outliers:A"].status == "not_assessed"


def test_numeric_group_labels_match_plan_labels():
    df = pd.DataFrame({"bp": NORMAL_A + NORMAL_B, "arm": [1.0] * 20 + [2.0] * 20})
    report = check_assumptions("independent_t_test", {"outcome": "bp", "group": "arm"}, df)
    plan = prepare_analysis_plan("independent_t_test", {"outcome": "bp", "group": "arm"}, df)
    assert {f"normality:{label}" for label in plan.group_counts} <= set(by_id(report))


def test_invalid_selection_is_rejected_like_plan_review():
    with pytest.raises(TemplateError):
        check_assumptions("mann_whitney_u", {"outcome": "bp", "group": "arm"}, groups(A=NORMAL_A, B=NORMAL_B))
    with pytest.raises(TemplateError):
        check_assumptions("independent_t_test", {"outcome": "arm", "group": "bp"}, groups(A=NORMAL_A, B=NORMAL_B))


def test_endpoint_requires_auth_and_never_runs_r(monkeypatch):
    monkeypatch.setenv("OMNISTAT_API_KEYS", "checks-test")
    rate_limit.reset()
    runner = AsyncMock()
    monkeypatch.setattr(r_analysis, "run_named_test", runner)
    client = TestClient(app)
    body = {"test": "independent_t_test", "variables": {"outcome": "bp", "group": "arm"},
            "data": groups(A=SKEWED, B=NORMAL_B).to_dict("records")}
    try:
        assert client.post("/api/r/checks", json=body).status_code == 401
        response = client.post("/api/r/checks", json=body, headers={"X-API-Key": "checks-test"})
        assert response.status_code == 200
        assert response.json()["suggestion"]["test"] == "mann_whitney_u"
        body["test"] = "chi_square"
        assert client.post("/api/r/checks", json=body, headers={"X-API-Key": "checks-test"}).status_code == 422
    finally:
        rate_limit.reset()
    runner.assert_not_awaited()


@pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")
def test_statistics_match_r():
    df = groups(A=SKEWED, B=NORMAL_B)
    report = by_id(check_assumptions("independent_t_test", {"outcome": "bp", "group": "arm"}, df))
    script = f"""
    a <- c({','.join(map(str, SKEWED))}); b <- c({','.join(map(str, NORMAL_B))})
    y <- c(a, b); g <- factor(rep(c("A", "B"), c(length(a), length(b))))
    s <- shapiro.test(a)
    bf <- anova(lm(abs(y - ave(y, g, FUN = median)) ~ g))
    cat(sprintf('{{"w": %.15g, "p": %.15g, "f": %.15g, "fp": %.15g}}', s$statistic, s$p.value, bf$`F value`[1], bf$`Pr(>F)`[1]))
    """
    out = json.loads(subprocess.run(["Rscript", "-e", script], capture_output=True, text=True, check=True).stdout)
    assert report["normality:A"].statistic == pytest.approx(out["w"], rel=1e-4)
    assert report["normality:A"].p_value == pytest.approx(out["p"], rel=1e-3)
    assert report["equal_variances"].statistic == pytest.approx(out["f"], rel=1e-6)
    assert report["equal_variances"].p_value == pytest.approx(out["fp"], rel=1e-6)
