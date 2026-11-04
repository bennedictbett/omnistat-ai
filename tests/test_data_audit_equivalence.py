"""The vectorised audit must give exactly the results of the original per-cell version."""
import numpy as np
import pandas as pd
import pytest

from app.services.data_audit import audit_dataset


def _reference_audit(df: pd.DataFrame) -> dict:
    """The original (slow, per-cell) implementation, kept as the specification."""
    columns = []
    for name in df.columns:
        values = df[name]
        missing = int(values.isna().sum())
        text = values.map(lambda value: isinstance(value, str))
        blank = text & values.map(lambda value: isinstance(value, str) and not value.strip())
        populated = values[values.notna() & ~blank]
        numeric_text = populated[populated.map(lambda value: isinstance(value, str))]
        converted = pd.to_numeric(numeric_text, errors="coerce")
        numeric_text_count = int(np.isfinite(converted.to_numpy(dtype=float)).sum())
        count = len(populated)
        numeric_looking = bool(
            count > 0 and not pd.api.types.is_numeric_dtype(values)
            and numeric_text_count / count >= 0.8
        )
        non_finite = 0
        if pd.api.types.is_numeric_dtype(values):
            non_finite = int(np.isinf(values.dropna().to_numpy(dtype=float)).sum())
        empty = count == 0
        columns.append({
            "column": str(name),
            "missing_count": missing,
            "missing_percent": round(missing / len(df) * 100, 2) if len(df) else 0.0,
            "blank_text_count": int(blank.sum()),
            "empty": empty,
            "constant": bool(not empty and populated.nunique() == 1),
            "numeric_text_count": numeric_text_count,
            "numeric_looking_text": numeric_looking,
            "non_finite_count": non_finite,
        })
    return {
        "version": "1.0",
        "rows": len(df),
        "duplicate_rows": int(df.duplicated(keep="first").sum()),
        "columns": columns,
    }


def _mixed_frame(n: int = 400) -> pd.DataFrame:
    rng = np.random.default_rng(7)
    text = rng.choice(["1", "2.5", "x", " ", "", "3", None, "inf", "1e3"], n).astype(object)
    return pd.DataFrame({
        "ints": rng.integers(0, 5, n),
        "floats": np.where(rng.random(n) < 0.1, np.nan, rng.normal(size=n)),
        "with_inf": np.where(rng.random(n) < 0.05, np.inf, rng.normal(size=n)),
        "flags": rng.random(n) < 0.5,
        "text": text,
        "numeric_text": rng.choice(["10", "20", "30", None, "bad"], n, p=[.3, .3, .3, .05, .05]),
        "mixed_objects": pd.Series(rng.choice([1, "a", 2.5, None, True], n), dtype=object),
        "category": pd.Categorical(rng.choice(["u", "v", "w"], n)),
        "dates": pd.date_range("2026-01-01", periods=n),
        "nullable_int": pd.array(np.where(rng.random(n) < 0.2, None, rng.integers(0, 9, n)), dtype="Int64"),
        "string_dtype": pd.array(rng.choice(["a", " ", None, "7"], n), dtype="string"),
        "constant": "same",
        "all_missing": np.nan,
        "boundary_80pct": (["1"] * 8 + ["x"] * 2) * (n // 10),
        "just_under_80pct": (["1"] * 7 + ["x"] * 3) * (n // 10),
        "high_cardinality": [f"id{i}" for i in range(n)],
        "object_numbers": pd.Series(rng.integers(0, 4, n), dtype=object),
        "object_numbers_nan": pd.Series(np.where(rng.random(n) < 0.3, None, rng.integers(0, 4, n)), dtype=object),
        "repeated_with_blank_and_missing": rng.choice(["  ", "12", "ab", None, "12 "], n),
    })


def test_vectorised_audit_matches_reference_on_awkward_columns():
    df = _mixed_frame()
    original = df.copy(deep=True)
    assert audit_dataset(df) == _reference_audit(df)
    pd.testing.assert_frame_equal(df, original)


@pytest.mark.parametrize("frame", [
    pd.DataFrame({"a": pd.Series([], dtype=float), "b": pd.Series([], dtype=object)}),
    pd.DataFrame({"a": [1.0]}),
    pd.DataFrame({"a": ["  "]}),
], ids=["empty", "single-row", "blank-only"])
def test_vectorised_audit_matches_reference_on_edge_frames(frame):
    assert audit_dataset(frame) == _reference_audit(frame)


def test_vectorised_audit_handles_non_default_index():
    df = pd.DataFrame({"t": ["1", "2", None, " "]}, index=[5, 5, 9, 9])
    assert audit_dataset(df) == _reference_audit(df)
