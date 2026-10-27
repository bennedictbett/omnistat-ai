"""Read-only quality checks on the parsed dataset, before analysis exclusions."""
import numpy as np
import pandas as pd


def audit_dataset(df: pd.DataFrame) -> dict:
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
