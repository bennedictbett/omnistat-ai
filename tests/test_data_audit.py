import io

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.data_audit import audit_dataset


def test_audit_flags_counts_without_modifying_input():
    df = pd.DataFrame({
        "empty": [None] * 5,
        "constant": ["same", "same", None, "same", "same"],
        "numeric_text": ["1", "2", "3", "4", "bad"],
        "mixed": ["1", "2", "no", "yes", "other"],
        "blanks": [" ", "", None, "\t", " "],
        "values": [1.0, np.inf, -np.inf, np.nan, 3.0],
    })
    original = df.copy(deep=True)
    audit = audit_dataset(df)
    columns = {column["column"]: column for column in audit["columns"]}
    assert audit["version"] == "1.0"
    assert columns["empty"]["empty"] and not columns["empty"]["constant"]
    assert columns["empty"]["missing_percent"] == 100
    assert columns["constant"]["constant"] and columns["constant"]["missing_count"] == 1
    assert columns["numeric_text"]["numeric_looking_text"]
    assert columns["numeric_text"]["numeric_text_count"] == 4
    assert not columns["mixed"]["numeric_looking_text"]
    assert columns["blanks"]["blank_text_count"] == 4 and columns["blanks"]["empty"]
    assert columns["values"]["non_finite_count"] == 2
    assert columns["values"]["missing_count"] == 1
    pd.testing.assert_frame_equal(df, original)


def test_duplicate_count_excludes_first_occurrences_and_handles_missing_values():
    df = pd.DataFrame({"value": [1, 1, None, None, 2], "group": ["A"] * 5})
    assert audit_dataset(df)["duplicate_rows"] == 2


def test_numeric_text_threshold_uses_populated_cells_and_never_numeric_dtype():
    df = pd.DataFrame({
        "text": ["1", "2", None, " ", "3"],
        "numeric": [1, 2, 3, 4, 5],
        "dates": pd.date_range("2026-01-01", periods=5),
    })
    columns = {c["column"]: c for c in audit_dataset(df)["columns"]}
    assert columns["text"]["numeric_looking_text"] and columns["text"]["numeric_text_count"] == 3
    assert not columns["numeric"]["numeric_looking_text"]
    assert not columns["dates"]["numeric_looking_text"]


@pytest.mark.parametrize("extension", ["csv", "xlsx"])
def test_upload_returns_serializable_audit_and_preserves_rows(extension):
    df = pd.DataFrame({
        "value": [1.0, 1.0, None, 3.0],
        "empty": [None] * 4,
        "constant": ["A"] * 4,
        "text": ["1", "1", "3", "bad"],
    })
    stream = io.BytesIO()
    if extension == "csv":
        stream.write(df.to_csv(index=False).encode())
    else:
        df.to_excel(stream, index=False)
    response = TestClient(app).post("/api/analytics/upload",
        files={"file": (f"quality.{extension}", stream.getvalue())})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["rows"] == len(result["full_data"]) == 4
    assert result["audit"]["duplicate_rows"] == 1
    assert result["audit"]["columns"][0]["missing_count"] == 1
    assert result["numeric_stats"]["empty"]["mean"] is None
    assert result["histogram_data"]["empty"]["counts"] == []
    assert result["correlation"]["empty"]["empty"] is None
    assert result["full_data"][2]["value"] is None
    assert result["full_data"][3]["text"] == "bad"


def test_upload_reports_infinities_before_serializing_them_as_null():
    response = TestClient(app).post("/api/analytics/upload",
        files={"file": ("infinite.csv", b"value\n1\ninf\n-inf\n3\n")})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["audit"]["columns"][0]["non_finite_count"] == 2
    assert result["numeric_stats"]["value"]["mean"] == 2.0
    assert result["full_data"][1]["value"] is None
    assert result["full_data"][2]["value"] is None


@pytest.mark.parametrize("content", [b"", b"value,group\n"])
def test_empty_uploads_have_explicit_validation_error(content):
    response = TestClient(app).post("/api/analytics/upload", files={"file": ("empty.csv", content)})
    assert response.status_code == 422
    assert "non-empty dataset" in response.json()["detail"]
