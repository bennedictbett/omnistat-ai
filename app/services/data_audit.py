"""Read-only quality checks on the parsed dataset, before analysis exclusions."""
import numpy as np
import pandas as pd


def _text_flags(cells: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Per value: is it text, and is it blank (empty or whitespace-only) text."""
    is_text = np.fromiter((isinstance(v, str) for v in cells), dtype=bool, count=len(cells))
    blank = np.zeros(len(cells), dtype=bool)
    if is_text.any():
        blank[is_text] = pd.Series(cells[is_text]).str.strip().eq("").to_numpy()
    return is_text, blank


def _finite_numeric_text(text_cells: np.ndarray) -> np.ndarray:
    """Per text value: does it parse to a finite number."""
    if not len(text_cells):
        return np.zeros(0, dtype=bool)
    converted = pd.to_numeric(pd.Series(text_cells), errors="coerce")
    return np.isfinite(converted.to_numpy(dtype=float))


def _text_column_stats(values: pd.Series, missing_mask: np.ndarray) -> tuple[int, int, int, int]:
    """(blank_text_count, numeric_text_count, populated_count, populated_distinct) of a non-numeric column."""
    if pd.api.types.is_object_dtype(values) or isinstance(values.dtype, pd.StringDtype):
        # Text columns usually repeat a few values: judge each distinct value once, then
        # weight by how often it occurs. Missing values get code -1 and are not counted.
        codes, uniques = pd.factorize(values)
        counts = np.bincount(codes[codes >= 0], minlength=len(uniques))
        cells = np.asarray(uniques, dtype=object)
        is_text, blank = _text_flags(cells)
        populated = ~blank
        numeric_text = np.zeros(len(cells), dtype=bool)
        eligible = populated & is_text
        numeric_text[eligible] = _finite_numeric_text(cells[eligible])
        return (int(counts[blank].sum()), int(counts[numeric_text].sum()),
                int(counts[populated].sum()), int(populated.sum()))

    # Dates, categories and other types: judge every cell.
    cells = values.to_numpy(dtype=object)
    is_text, blank = _text_flags(cells)
    populated_mask = ~missing_mask & ~blank
    numeric_text = np.zeros(len(cells), dtype=bool)
    eligible = populated_mask & is_text
    numeric_text[eligible] = _finite_numeric_text(cells[eligible])
    return (int(blank.sum()), int(numeric_text.sum()),
            int(populated_mask.sum()), int(values[populated_mask].nunique()))


def audit_dataset(df: pd.DataFrame) -> dict:
    columns = []
    for name in df.columns:
        values = df[name]
        missing_mask = values.isna().to_numpy()
        missing = int(missing_mask.sum())
        numeric = pd.api.types.is_numeric_dtype(values)
        non_finite = 0
        if numeric:
            # Numeric columns cannot contain text, so skip the per-cell text checks.
            blank_count, numeric_text_count = 0, 0
            count = len(values) - missing
            distinct = int(values.nunique())
            non_finite = int(np.isinf(values.dropna().to_numpy(dtype=float)).sum())
        else:
            blank_count, numeric_text_count, count, distinct = _text_column_stats(values, missing_mask)
        numeric_looking = bool(count > 0 and not numeric and numeric_text_count / count >= 0.8)
        empty = count == 0
        columns.append({
            "column": str(name),
            "missing_count": missing,
            "missing_percent": round(missing / len(df) * 100, 2) if len(df) else 0.0,
            "blank_text_count": blank_count,
            "empty": empty,
            "constant": bool(not empty and distinct == 1),
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
