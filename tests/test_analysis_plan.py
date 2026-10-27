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
    assert post(client, "plan", {**body, "test": "shapiro_wilk"}).status_code == 422
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
