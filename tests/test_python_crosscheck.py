"""Python cross-check of R results."""
import asyncio
import copy
import shutil

import pytest

from app.services.python_crosscheck import cross_check
from app.services.r_templates import TemplateError, prepare_test_data, run_named_test
from test_r_golden import GOLDENS, _cases

needs_r = pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")

T_TEST_GROUPS = [{"group": "A", "n": 8}, {"group": "B", "n": 8}]


def _t_test_inputs():
    variables, data = _cases()["independent_t_test"]
    results = {**GOLDENS["cases"]["independent_t_test"]["expected"], "groups": copy.deepcopy(T_TEST_GROUPS)}
    return variables, prepare_test_data("independent_t_test", variables, data), results


def test_agrees_with_the_r_golden_values_without_running_r():
    variables, csv, results = _t_test_inputs()
    out = cross_check("independent_t_test", variables, csv, results)
    assert out["status"] == "agree"
    assert {c["label"] for c in out["checks"]} >= {"t statistic", "p-value", "Mean difference", "Cohen's d"}
    assert all(c["agree"] and c["python"] is not None for c in out["checks"])
    assert "SciPy" in out["engine"]


def test_flags_a_value_that_differs_from_python():
    variables, csv, results = _t_test_inputs()
    results["mean_difference"] += 0.5
    out = cross_check("independent_t_test", variables, csv, results)
    assert out["status"] == "disagree"
    assert [c["label"] for c in out["checks"] if not c["agree"]] == ["Mean difference"]


def test_values_missing_from_the_r_results_are_skipped_not_failed():
    variables, csv, results = _t_test_inputs()
    del results["cohens_d"]
    out = cross_check("independent_t_test", variables, csv, results)
    assert out["status"] == "agree"
    assert "Cohen's d" not in {c["label"] for c in out["checks"]}


def test_unavailable_when_python_sees_different_rows_than_r():
    variables, csv, results = _t_test_inputs()
    results["groups"][0]["n"] = 9
    out = cross_check("independent_t_test", variables, csv, results)
    assert out["status"] == "unavailable"
    assert out["checks"] == []
    assert "different number" in out["note"]


@pytest.mark.parametrize("results", [{}, {"groups": "nope"}, {"groups": [{"group": "Z", "n": 1}]}])
def test_malformed_r_results_never_raise(results):
    variables, csv, _ = _t_test_inputs()
    assert cross_check("independent_t_test", variables, csv, results)["status"] == "unavailable"


def test_unknown_test_is_unavailable():
    out = cross_check("nope", {}, b"a\n1\n", {})
    assert out["status"] == "unavailable"
    assert "No Python cross-check" in out["note"]


def test_garbage_csv_never_raises():
    assert cross_check("independent_t_test", {"outcome": "y", "group": "g"}, b"\x00\xff", {})["status"] == "unavailable"


@needs_r
@pytest.mark.parametrize("test", sorted(GOLDENS["cases"]))
def test_python_agrees_with_r_for_every_procedure(test):
    variables, data = _cases()[test]
    out = asyncio.run(run_named_test(test, variables, data))
    assert out["ok"], out["error"]
    cc = out["cross_check"]
    disagreements = [c for c in cc["checks"] if not c["agree"]]
    assert cc["status"] == "agree", (cc["note"], disagreements)
    assert cc["checks"]


@needs_r
def test_failed_r_runs_have_no_cross_check():
    variables, data = _cases()["independent_t_test"]
    out = asyncio.run(run_named_test("independent_t_test", {**variables, "group": "outcome"}, data))
    assert not out["ok"]
    assert "cross_check" not in out


@needs_r
def test_cross_check_is_json_safe():
    import json

    variables, data = _cases()["logistic_regression"]
    out = asyncio.run(run_named_test("logistic_regression", variables, data))
    json.dumps(out["cross_check"], allow_nan=False)


def test_prepare_errors_still_surface_before_any_cross_check():
    variables, data = _cases()["independent_t_test"]
    with pytest.raises(TemplateError):
        asyncio.run(run_named_test("independent_t_test", {"outcome": "outcome"}, data))
