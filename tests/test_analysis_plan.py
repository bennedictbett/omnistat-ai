import shutil
from unittest.mock import AsyncMock

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api.routes import r_analysis
from app.main import app
from app.security import rate_limit
from app.services.analysis_plan import prepare_analysis_plan
from app.services.r_templates import TemplateError


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("OMNISTAT_API_KEYS", "plan-test")
    rate_limit.reset()
    yield TestClient(app)
    rate_limit.reset()


@pytest.fixture
def body():
    return {
        "test": "independent_t_test",
        "variables": {"outcome": "bp", "group": "arm"},
        "data": [
            {"bp": 10, "arm": "A"}, {"bp": 12, "arm": "A"},
            {"bp": 16, "arm": "B"}, {"bp": 19, "arm": "B"},
            {"bp": None, "arm": "B"},
        ],
    }


def post(client, endpoint, body):
    return client.post(f"/api/r/{endpoint}", json=body, headers={"X-API-Key": "plan-test"})


def test_plan_requires_auth_and_does_not_execute_r(client, body, monkeypatch):
    runner = AsyncMock()
    monkeypatch.setattr(r_analysis, "run_named_test", runner)
    assert client.post("/api/r/plan", json=body).status_code == 401
    response = post(client, "plan", body)
    assert response.status_code == 200
    plan = response.json()
    assert plan["schema_version"] == "1.0"
    assert plan["rows_total"] == 5 and plan["rows_used"] == 4
    assert plan["rows_dropped_missing"] == 1
    assert plan["group_counts"] == {"A": 2, "B": 2}
    assert plan["confidence_level"] == 0.95 and not plan["equal_variances"]
    assert len(plan["data_sha256"]) == 64
    runner.assert_not_awaited()


@pytest.mark.parametrize("change", ["data", "mapping", "parameters", "assumptions"])
def test_stale_or_modified_plan_cannot_execute(client, body, monkeypatch, change):
    plan = post(client, "plan", body).json()
    runner = AsyncMock()
    monkeypatch.setattr(r_analysis, "run_named_test", runner)
    if change == "data":
        body["data"][0]["bp"] = 11
    elif change == "mapping":
        for row in body["data"]:
            row["other"] = row["bp"]
        body["variables"]["outcome"] = "other"
    elif change == "parameters":
        plan["confidence_level"] = 0.9
    else:
        plan["assumptions"] = []
    response = post(client, "run", {**body, "analysis_plan": plan})
    assert response.status_code == (422 if change == "parameters" else 409)
    runner.assert_not_awaited()


@pytest.mark.parametrize("variables", [
    {"outcome": "bp"}, {"outcome": "missing", "group": "arm"},
    {"outcome": "bp", "group": "bp"}, {"outcome": "bp", "group": "arm", "extra": "bp"},
])
def test_invalid_roles_are_rejected(client, body, variables):
    assert post(client, "plan", {**body, "variables": variables}).status_code == 422


def test_unsupported_procedures_and_invalid_groups_are_rejected(client, body):
    assert post(client, "plan", {**body, "test": "cox_regression"}).status_code == 422
    body["data"][0]["arm"] = "C"
    assert post(client, "plan", body).status_code == 422
    body["data"] = [{"bp": 1, "arm": "A"}, {"bp": 2, "arm": "B"}]
    assert post(client, "plan", body).status_code == 422


@pytest.mark.parametrize("values", [["bad", "text", "more", "words"], [float("inf"), 12, 16, 19]])
def test_non_numeric_or_infinite_outcomes_are_rejected(body, values):
    for row, value in zip(body["data"], values):
        row["bp"] = value
    with pytest.raises(TemplateError):
        prepare_analysis_plan(body["test"], body["variables"], pd.DataFrame(body["data"]))


def test_plan_is_independent_of_variable_mapping_order(client, body):
    first = post(client, "plan", body).json()
    body["variables"] = {"group": "arm", "outcome": "bp"}
    assert post(client, "plan", body).json() == first


@pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")
def test_confirmed_plan_matches_actual_execution_and_fingerprint(client, body):
    plan = post(client, "plan", body).json()
    body["variables"] = {"group": "arm", "outcome": "bp"}
    response = post(client, "run", {**body, "analysis_plan": plan})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"], result["error"]
    assert result["analysis_plan"] == plan
    assert result["data_sha256"] == plan["data_sha256"]
    assert result["results"]["test"] == "Welch two-sample t-test"


def test_legacy_requests_remain_supported(client, body, monkeypatch):
    runner = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(r_analysis, "run_named_test", runner)
    assert post(client, "run", body).json() == {"ok": True}
    runner.assert_awaited_once()


def test_plan_endpoint_uses_r_rate_limit(client, body, monkeypatch):
    monkeypatch.setenv("R_RATE_LIMIT_PER_MIN", "1")
    assert post(client, "plan", body).status_code == 200
    response = post(client, "plan", body)
    assert response.status_code == 429
    assert int(response.headers["retry-after"]) >= 1


@pytest.mark.parametrize("labels", [("NA", "B"), ("01", "1")])
def test_ambiguous_csv_group_labels_require_explicit_recoding(client, body, labels):
    for row in body["data"]:
        row["arm"] = labels[0] if row["arm"] == "A" else labels[1]
    assert post(client, "plan", body).status_code == 422


CASES = [
    ("paired_t_test", {"first": "a", "second": "b"},
     [{"a": 1, "b": 2}, {"a": 3, "b": 5}, {"a": 6, "b": 7}, {"a": 8, "b": 12}]),
    ("pearson_correlation", {"x": "a", "y": "b"},
     [{"a": 1, "b": 2}, {"a": 3, "b": 5}, {"a": 6, "b": 7}, {"a": 8, "b": 12}]),
    ("shapiro_wilk", {"variable": "a"}, [{"a": 1}, {"a": 3}, {"a": 6}, {"a": 8}]),
    ("one_way_anova", {"outcome": "a", "group": "g"},
     [{"a": 1, "g": "A"}, {"a": 3, "g": "A"}, {"a": 5, "g": "B"},
      {"a": 8, "g": "B"}, {"a": 4, "g": "C"}, {"a": 9, "g": "C"}]),
]


@pytest.mark.parametrize("test,variables,rows", CASES)
def test_extended_plans_count_complete_cases_and_canonicalize_roles(client, test, variables, rows):
    body = {"test": test, "variables": variables, "data": rows + [{}]}
    response = post(client, "plan", body)
    assert response.status_code == 200, response.text
    plan = response.json()
    assert plan["procedure"] == test
    assert plan["rows_used"] == len(rows) and plan["rows_dropped_missing"] == 1
    assert plan["equal_variances"] == (True if test == "one_way_anova" else None)
    assert plan["alternative"] == (None if test in ("shapiro_wilk", "one_way_anova") else "two.sided")
    assert plan["confidence_level"] == (None if test == "shapiro_wilk" else 0.95)
    body["variables"] = dict(reversed(list(variables.items())))
    assert post(client, "plan", body).json() == plan


@pytest.mark.parametrize("test,variables,rows", CASES)
def test_extended_plan_changes_are_rejected_without_execution(client, monkeypatch, test, variables, rows):
    body = {"test": test, "variables": variables, "data": rows}
    plan = post(client, "plan", body).json()
    runner = AsyncMock()
    monkeypatch.setattr(r_analysis, "run_named_test", runner)
    plan["outputs"] = []
    assert post(client, "run", {**body, "analysis_plan": plan}).status_code == 409
    runner.assert_not_awaited()


@pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")
@pytest.mark.parametrize("test,variables,rows", CASES)
def test_extended_plan_executes_matching_r_template(client, test, variables, rows):
    body = {"test": test, "variables": variables, "data": rows}
    plan = post(client, "plan", body).json()
    response = post(client, "run", {**body, "analysis_plan": plan})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["ok"], result["error"]
    assert result["analysis_plan"] == plan
    assert result["data_sha256"] == plan["data_sha256"]


@pytest.mark.parametrize("test,variables,rows", [
    ("paired_t_test", {"first": "a", "second": "b"}, [{"a": 1, "b": 2}] * 4),
    ("pearson_correlation", {"x": "a", "y": "b"}, [{"a": 1, "b": n} for n in range(4)]),
    ("pearson_correlation", {"x": "a", "y": "b"}, [{"a": n, "b": n} for n in range(3)]),
    ("shapiro_wilk", {"variable": "a"}, [{"a": 1}] * 4),
    ("shapiro_wilk", {"variable": "a"}, [{"a": n} for n in range(5001)]),
    ("shapiro_wilk", {"variable": "a"}, [{"a": "x"}, {"a": "y"}, {"a": "z"}]),
    ("one_way_anova", {"outcome": "a", "group": "g"},
     [{"a": 1, "g": "A"}, {"a": 2, "g": "B"}, {"a": 3, "g": "C"}]),
])
def test_extended_plan_rejects_invalid_data(client, test, variables, rows):
    assert post(client, "plan", {"test": test, "variables": variables, "data": rows}).status_code == 422
