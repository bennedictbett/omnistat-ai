import datetime as dt
import os
import tempfile

import pandas as pd
import pyreadstat
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.analysis_plan import prepare_analysis_plan

FRAME = pd.DataFrame({
    "sex": [1.0, 2.0, 1.0, 99.0, 2.0, 1.0],
    "bp": [120.5, 130.0, None, 118.0, 141.0, 125.0],
    "site": ["Nairobi", "Kisumu", "Nairobi", "Mombasa", "Kisumu", "Nairobi"],
    "visit": [dt.date(2026, 1, 1), dt.date(2026, 1, 2), None, dt.date(2026, 1, 4),
              dt.date(2026, 1, 5), dt.date(2026, 1, 6)],
})


def upload(path, name):
    with open(path, "rb") as handle:
        return TestClient(app).post("/api/analytics/upload", files={"file": (name, handle.read())})


@pytest.mark.parametrize("name, compress", [("trial.sav", False), ("TRIAL.ZSAV", True)])
def test_spss_keeps_codes_labels_and_treats_user_missing_as_missing(tmp_path, name, compress):
    path = tmp_path / name
    pyreadstat.write_sav(
        FRAME, str(path), compress=compress,
        column_labels={"sex": "Sex of patient", "bp": "Systolic blood pressure (mmHg)"},
        variable_value_labels={"sex": {1: "Male", 2: "Female", 99: "Refused"}},
        missing_ranges={"sex": [99]},
    )
    response = upload(path, name)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["rows"] == len(result["full_data"]) == 6
    assert [row["sex"] for row in result["full_data"]] == [1, 2, 1, None, 2, 1]
    assert result["full_data"][2]["bp"] is None
    assert result["full_data"][0]["visit"] == "2026-01-01"
    assert result["full_data"][2]["visit"] is None
    assert result["variable_labels"] == {
        "sex": "Sex of patient", "bp": "Systolic blood pressure (mmHg)"}
    assert result["value_labels"] == {"sex": {"1": "Male", "2": "Female", "99": "Refused"}}
    assert {"sex", "bp"} <= set(result["numeric_cols"])
    assert result["audit"]["columns"][0]["missing_count"] == 1


def test_stata_labels_and_codes_feed_reviewed_analyses(tmp_path):
    path = tmp_path / "trial.dta"
    frame = FRAME.drop(columns=["visit"]).assign(sex=[1, 2, 1, 2, 2, 1])
    pyreadstat.write_dta(frame, str(path), column_labels={"bp": "Systolic BP"},
                         variable_value_labels={"sex": {1: "Male", 2: "Female"}})
    response = upload(path, "trial.dta")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["variable_labels"] == {"bp": "Systolic BP"}
    assert result["value_labels"] == {"sex": {"1": "Male", "2": "Female"}}
    plan = prepare_analysis_plan("independent_t_test", {"outcome": "bp", "group": "sex"},
                                 pd.DataFrame(result["full_data"]))
    assert plan.group_counts == {"1": 2, "2": 3}


def test_unlabelled_csv_and_excel_report_empty_labels():
    response = TestClient(app).post("/api/analytics/upload", files={"file": ("plain.csv", b"bp\n1\n2\n")})
    assert response.status_code == 200
    assert response.json()["variable_labels"] == {} and response.json()["value_labels"] == {}


@pytest.mark.parametrize("name", ["corrupt.sav", "corrupt.dta"])
def test_corrupt_files_are_rejected_and_temporary_copies_removed(tmp_path, monkeypatch, name):
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    response = TestClient(app).post("/api/analytics/upload", files={"file": (name, b"not a statistical file")})
    assert response.status_code == 422
    assert "SPSS (.sav/.zsav) or Stata (.dta)" in response.json()["detail"]
    assert os.listdir(tmp_path) == []
