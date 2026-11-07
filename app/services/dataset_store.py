"""Server-side storage for large uploaded datasets.

An upload is parsed once, summarised (audit, statistics, histograms, a preview) and
saved as a Parquet file under an unguessable id. Analyses then send `dataset_id` and
column names instead of every row, so the browser never has to hold or re-send the
whole dataset.

Layout:  <data dir>/<id>/data.parquet   the full dataset, one typed column per field
         <data dir>/<id>/meta.json      summary shown to the user (never the full data)

A dataset expires after DATASET_TTL_HOURS without being used: the modification time of
meta.json is the "last used" clock, refreshed on every read. The store has a total
size cap and refuses new uploads when full; it never evicts datasets that are in use.
Limits are read from the environment on every call so they are easy to tune and test.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd

from app.services.analytics_service import _json_finite, read_dataset_file
from app.services.data_audit import audit_dataset

logger = logging.getLogger("omnistat.dataset_store")

ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{22}$")
PREVIEW_ROWS = 100
MAX_PAGE_ROWS = 1000
TOP_CATEGORIES = 50
ROW_GROUP_ROWS = 100_000
_ABANDONED_AFTER_S = 3600  # leftovers from a crashed upload


class DatasetError(Exception):
    """Base class; `status` is the HTTP status the API should use."""
    status = 422


class DatasetNotFound(DatasetError):
    status = 404


class DatasetTooLarge(DatasetError):
    status = 413


class StoreFull(DatasetError):
    status = 507


class StoreUnavailable(DatasetError):
    status = 503


def _parquet():
    """pyarrow and its parquet module, imported on first use so that a server without
    pyarrow (for example the Render build) still starts; only dataset storage is off."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as e:
        raise StoreUnavailable("Large-dataset storage is not available on this server") from e
    return pa, pq


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default


def max_upload_bytes() -> int:
    return _int_env("DATASET_MAX_UPLOAD_MB", 200) * 1024**2


def max_excel_bytes() -> int:
    # Excel is parsed in pure Python and needs far more memory per row than CSV.
    return min(max_upload_bytes(), _int_env("DATASET_MAX_EXCEL_MB", 50) * 1024**2)


def max_rows() -> int:
    return _int_env("DATASET_MAX_ROWS", 1_000_000)


def max_columns() -> int:
    return _int_env("DATASET_MAX_COLUMNS", 1000)


def max_concurrent_uploads() -> int:
    return max(1, _int_env("DATASET_MAX_CONCURRENT_UPLOADS", 1))


def ttl_seconds() -> float:
    return _int_env("DATASET_TTL_HOURS", 24) * 3600.0


def total_quota_bytes() -> int:
    return _int_env("DATASET_MAX_TOTAL_MB", 5000) * 1024**2


def owner_quota_bytes() -> int:
    return _int_env("DATASET_MAX_PER_CLIENT_MB", 1000) * 1024**2


def data_dir() -> Path:
    path = Path(os.getenv("OMNISTAT_DATA_DIR") or Path(tempfile.gettempdir()) / "omnistat-datasets")
    path.mkdir(parents=True, exist_ok=True)
    return path


def new_id() -> str:
    return secrets.token_urlsafe(16)  # 128 bits, 22 URL-safe characters


def _dir(dataset_id: str) -> Path:
    # The pattern check is what keeps a crafted id from escaping the data directory.
    if not isinstance(dataset_id, str) or not ID_PATTERN.fullmatch(dataset_id):
        raise DatasetNotFound("Dataset not found or expired")
    return data_dir() / dataset_id


def _touch(meta_path: Path) -> None:
    try:
        os.utime(meta_path)
    except OSError:
        pass


def _expires_at(meta_path: Path) -> float:
    return meta_path.stat().st_mtime + ttl_seconds()


def _is_live(folder: Path, now: float) -> bool:
    meta = folder / "meta.json"
    try:
        return meta.stat().st_mtime + ttl_seconds() > now
    except OSError:
        return False


def _folder_bytes(folder: Path) -> int:
    return sum(p.stat().st_size for p in folder.rglob("*") if p.is_file())


def usage(owner: str | None = None) -> tuple[int, int]:
    """(bytes, datasets) currently stored, optionally for one owner only."""
    total = count = 0
    for folder in data_dir().iterdir():
        meta = folder / "meta.json"
        if not folder.is_dir() or not ID_PATTERN.fullmatch(folder.name) or not meta.exists():
            continue
        try:
            record = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if owner is None or record.get("owner") == owner:
            total += int(record.get("bytes", 0))
            count += 1
    return total, count


def purge_expired() -> int:
    """Delete expired datasets and abandoned partial uploads. Returns how many were removed."""
    now = time.time()
    removed = 0
    for folder in data_dir().iterdir():
        if not folder.is_dir():
            continue
        if ID_PATTERN.fullmatch(folder.name):
            expired = not _is_live(folder, now)
        else:
            try:
                expired = folder.name.startswith(".tmp-") and now - folder.stat().st_mtime > _ABANDONED_AFTER_S
            except OSError:
                expired = False
        if expired:
            shutil.rmtree(folder, ignore_errors=True)
            removed += 1
    if removed:
        logger.info("Removed %d expired dataset(s)", removed)
    return removed


def _summarise(df: pd.DataFrame, labels: dict, value_labels: dict, filename: str) -> dict:
    """Everything the UI shows without needing the rows. Mutates `df`: infinite values become missing."""
    audit = audit_dataset(df)  # audited before inf is replaced, so non-finite counts stay visible
    for column in df.select_dtypes(include=["float32", "float64"]).columns:
        if np.isinf(df[column].to_numpy()).any():
            df[column] = df[column].replace([np.inf, -np.inf], np.nan)

    numeric_cols = df.select_dtypes(include=["int64", "float64"]).columns.tolist()
    categorical_cols = df.select_dtypes(include=["object"]).columns.tolist()

    numeric_stats, histogram_data = {}, {}
    for col in numeric_cols:
        values = df[col]
        valid = values.dropna()
        numeric_stats[col] = {
            "mean": round(float(values.mean()), 4),
            "median": round(float(values.median()), 4) if len(valid) else None,
            "std": round(float(values.std()), 4),
            "min": round(float(values.min()), 4),
            "max": round(float(values.max()), 4),
        }
        if len(valid):
            binned, edges = pd.cut(valid, bins=10, retbins=True)
            histogram_data[col] = {
                "counts": binned.value_counts(sort=False).tolist(),
                "edges": [round(float(e), 6) for e in edges],
            }
        else:
            histogram_data[col] = {"counts": [], "edges": []}

    categorical_stats, categorical_distinct = {}, {}
    for col in categorical_cols:
        counts = df[col].value_counts()
        categorical_distinct[col] = int(len(counts))
        categorical_stats[col] = {str(k): int(v) for k, v in counts.head(TOP_CATEGORIES).items()}

    return {
        "filename": filename,
        "audit": audit,
        "variable_labels": labels,
        "value_labels": value_labels,
        "rows": len(df),
        "columns": list(df.columns),
        "dtypes": df.dtypes.astype(str).to_dict(),
        "missing": df.isnull().sum().to_dict(),
        "preview": df.head(PREVIEW_ROWS).to_dict(orient="records"),
        "numeric_cols": numeric_cols,
        "categorical_cols": categorical_cols,
        "numeric_stats": numeric_stats,
        "categorical_stats": categorical_stats,
        "categorical_distinct": categorical_distinct,
        "histogram_data": histogram_data,
        "correlation": df[numeric_cols].corr().round(3).to_dict() if len(numeric_cols) > 1 else {},
    }


def _json_default(value):
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _write_parquet(df: pd.DataFrame, path: Path) -> None:
    pa, _ = _parquet()
    try:
        df.to_parquet(path, index=False, row_group_size=ROW_GROUP_ROWS)
    except (pa.ArrowInvalid, pa.ArrowTypeError):
        # A column mixing types (for example numbers and text in one object column)
        # cannot be stored as is; keep its values as text, and missing values as missing.
        for column in df.columns[(df.dtypes == object).to_numpy()]:
            df[column] = df[column].astype("string")
        df.to_parquet(path, index=False, row_group_size=ROW_GROUP_ROWS)


def _public(dataset_id: str, record: dict, meta_path: Path) -> dict:
    return {**record["summary"], "dataset_id": dataset_id, "expires_at": _expires_at(meta_path)}


def ingest(source: Path, filename: str, owner: str) -> dict:
    """Parse `source`, store it and return the summary. Blocking: call from a worker thread."""
    _parquet()  # fail before parsing a large file if storage cannot work
    purge_expired()
    used, _ = usage()
    if used >= total_quota_bytes():
        raise StoreFull("Dataset storage is full. Try again later or delete a dataset you no longer need.")
    if usage(owner)[0] >= owner_quota_bytes():
        raise StoreFull("You have reached your dataset storage limit. Delete a dataset to upload another.")

    try:
        df, labels, value_labels = read_dataset_file(str(source), filename, max_rows=max_rows())
    except DatasetError:
        raise
    except Exception as e:
        raise DatasetError(
            "Could not parse a non-empty dataset. Check the CSV, Excel, SPSS (.sav/.zsav) or Stata (.dta) file."
        ) from e
    if df.empty:
        raise DatasetError("The uploaded file has no data rows")
    if len(df) > max_rows():
        raise DatasetTooLarge(f"Too many rows; the limit is {max_rows():,}")
    if len(df.columns) > max_columns():
        raise DatasetTooLarge(f"Too many columns; the limit is {max_columns():,}")
    df.columns = df.columns.map(str)
    if not df.columns.is_unique:
        raise DatasetError("Column names must be unique")

    summary = _summarise(df, labels, value_labels, os.path.basename(filename))
    dataset_id = new_id()
    staging = data_dir() / f".tmp-{secrets.token_hex(8)}"
    staging.mkdir()
    try:
        _write_parquet(df, staging / "data.parquet")
        size = (staging / "data.parquet").stat().st_size
        if used + size > total_quota_bytes():
            raise StoreFull("Dataset storage is full. Try again later or delete a dataset you no longer need.")
        record = {
            "id": dataset_id, "owner": owner, "created_at": time.time(), "bytes": size,
            "summary": json.loads(json.dumps(_json_finite(summary), default=_json_default, allow_nan=False)),
        }
        (staging / "meta.json").write_text(json.dumps(record), encoding="utf-8")
        os.replace(staging, data_dir() / dataset_id)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    meta_path = data_dir() / dataset_id / "meta.json"
    return _public(dataset_id, record, meta_path)


def _live_folder(dataset_id: str) -> Path:
    folder = _dir(dataset_id)
    if not _is_live(folder, time.time()):
        if folder.exists():
            shutil.rmtree(folder, ignore_errors=True)
        raise DatasetNotFound("Dataset not found or expired")
    _touch(folder / "meta.json")
    return folder


def get_meta(dataset_id: str) -> dict:
    folder = _live_folder(dataset_id)
    try:
        record = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise DatasetNotFound("Dataset not found or expired") from e
    return _public(dataset_id, record, folder / "meta.json")


def load_columns(dataset_id: str, columns: list[str] | None = None) -> pd.DataFrame:
    """Load the dataset, or only `columns`. Names that are not in the dataset are skipped
    so the caller's usual 'column not found' validation still produces its own message."""
    _, pq = _parquet()
    folder = _live_folder(dataset_id)
    path = folder / "data.parquet"
    if columns is not None:
        present = set(pq.ParquetFile(path).schema_arrow.names)
        columns = [c for c in dict.fromkeys(columns) if c in present]
    return pd.read_parquet(path, columns=columns)


def read_rows(dataset_id: str, offset: int, limit: int) -> dict:
    """A window of rows, for paging through a dataset in the browser."""
    _, pq = _parquet()
    folder = _live_folder(dataset_id)
    limit = max(1, min(int(limit), MAX_PAGE_ROWS))
    offset = max(0, int(offset))
    reader = pq.ParquetFile(folder / "data.parquet")
    total = reader.metadata.num_rows
    pieces, position = [], 0
    for index in range(reader.num_row_groups):
        count = reader.metadata.row_group(index).num_rows
        if position + count > offset and position < offset + limit:
            pieces.append(reader.read_row_group(index).to_pandas().iloc[max(0, offset - position):offset + limit - position])
        position += count
        if position >= offset + limit:
            break
    frame = pd.concat(pieces) if pieces else pd.DataFrame(columns=reader.schema_arrow.names)
    rows = _json_finite(frame.replace([np.inf, -np.inf], np.nan).to_dict(orient="records"))
    return {"dataset_id": dataset_id, "offset": offset, "limit": limit, "total": total, "rows": rows}


def delete(dataset_id: str) -> bool:
    folder = _dir(dataset_id)
    existed = folder.exists()
    shutil.rmtree(folder, ignore_errors=True)
    return existed
