"""Server-side dataset store: upload once, refer by id, expire, and stay within limits."""
import io
import os
import time

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.api.routes import datasets as datasets_route
from app.main import app
from app.security import rate_limit
from app.services import dataset_store as store
from app.services.data_audit import audit_dataset

KEY = "test-key-datasets"
HEADERS = {"X-API-Key": KEY}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNISTAT_DATA_DIR", str(tmp_path / "datasets"))
    monkeypatch.setenv("OMNISTAT_API_KEYS", KEY)
    for name in ("DATASET_UPLOAD_RATE_PER_MIN", "DATASET_UPLOAD_GLOBAL_RATE_PER_MIN",
                 "DATASET_READ_RATE_PER_MIN", "DATASET_READ_GLOBAL_RATE_PER_MIN",
                 "R_RATE_LIMIT_PER_MIN", "R_GLOBAL_RATE_PER_MIN"):
        monkeypatch.setenv(name, "1000")
    monkeypatch.setattr(datasets_route, "_ingest_slots", None)
    rate_limit.reset()
    yield
    rate_limit.reset()


@pytest.fixture
def client():
    return TestClient(app)


def make_frame(n=300):
    rng = np.random.default_rng(1)
    return pd.DataFrame({
        "bp": rng.normal(130, 15, n).round(1),
        "age": rng.integers(18, 90, n),
        "arm": rng.choice(["A", "B"], n),
        "ratio": np.where(np.arange(n) % 50 == 0, np.inf, rng.normal(size=n).round(2)),
        "note": [None if i % 7 == 0 else f"n{i % 40}" for i in range(n)],
    })


def csv_bytes(df):
    return df.to_csv(index=False).encode()


def upload(client, content, name="data.csv", **kwargs):
    return client.post("/api/datasets", files={"file": (name, content, "text/csv")}, **kwargs)


# ---------- upload and summary ----------

def test_upload_returns_summary_not_rows(client):
    df = make_frame()
    r = upload(client, csv_bytes(df))
    assert r.status_code == 200
    body = r.json()
    assert r.headers["cache-control"] == "no-store"
    assert "full_data" not in body
    assert len(body["dataset_id"]) == 22 and body["rows"] == len(df)
    assert body["columns"] == list(df.columns) and len(body["preview"]) == min(len(df), store.PREVIEW_ROWS)
    assert body["expires_at"] > time.time()
    assert set(body["numeric_cols"]) == {"bp", "age", "ratio"} and set(body["categorical_cols"]) == {"arm", "note"}
    assert body["missing"]["note"] == int(df["note"].isna().sum())
    assert body["categorical_distinct"]["note"] == df["note"].nunique()
    counts, edges = body["histogram_data"]["bp"]["counts"], body["histogram_data"]["bp"]["edges"]
    assert sum(counts) == len(df) and len(edges) == len(counts) + 1
    assert body["numeric_stats"]["bp"]["mean"] == pytest.approx(df["bp"].mean(), abs=1e-4)


def test_audit_sees_original_infinite_values_and_stored_data_does_not(client):
    df = make_frame()
    body = upload(client, csv_bytes(df)).json()
    original = pd.read_csv(io.BytesIO(csv_bytes(df)))
    assert body["audit"] == audit_dataset(original)
    ratio = next(c for c in body["audit"]["columns"] if c["column"] == "ratio")
    assert ratio["non_finite_count"] == 6
    stored = store.load_columns(body["dataset_id"], ["ratio"])
    assert np.isfinite(stored["ratio"].dropna()).all() and stored["ratio"].isna().sum() == 6
    assert body["numeric_stats"]["ratio"]["max"] < 10


def test_large_categorical_columns_are_capped(client):
    df = pd.DataFrame({"id": [f"id{i}" for i in range(500)], "x": range(500)})
    body = upload(client, csv_bytes(df)).json()
    assert body["categorical_distinct"]["id"] == 500
    assert len(body["categorical_stats"]["id"]) == store.TOP_CATEGORIES


def test_summary_and_rows_can_be_read_again(client):
    df = make_frame(250)
    dataset_id = upload(client, csv_bytes(df)).json()["dataset_id"]
    again = client.get(f"/api/datasets/{dataset_id}")
    assert again.status_code == 200 and again.json()["rows"] == 250
    page = client.get(f"/api/datasets/{dataset_id}/rows", params={"offset": 240, "limit": 50}).json()
    assert page["total"] == 250 and len(page["rows"]) == 10 and page["rows"][0]["age"] == int(df["age"].iloc[240])
    assert client.get(f"/api/datasets/{dataset_id}/rows", params={"offset": 999}).json()["rows"] == []


def test_row_paging_spans_row_groups(client, monkeypatch):
    monkeypatch.setattr(store, "ROW_GROUP_ROWS", 40)
    df = make_frame(130)
    dataset_id = upload(client, csv_bytes(df)).json()["dataset_id"]
    page = client.get(f"/api/datasets/{dataset_id}/rows", params={"offset": 35, "limit": 50}).json()
    assert [row["age"] for row in page["rows"]] == df["age"].iloc[35:85].tolist()


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 1001}, {"offset": -1}])
def test_row_paging_rejects_bad_windows(client, params):
    dataset_id = upload(client, csv_bytes(make_frame(20))).json()["dataset_id"]
    assert client.get(f"/api/datasets/{dataset_id}/rows", params=params).status_code == 422


def test_xlsx_and_mixed_type_columns_are_stored(client, tmp_path):
    df = pd.DataFrame({"mixed": [1, "a", 2.5, None, True] * 4, "v": range(20)})
    buffer = io.BytesIO()
    df.to_excel(buffer, index=False)
    r = upload(client, buffer.getvalue(), name="book.xlsx")
    assert r.status_code == 200, r.text
    stored = store.load_columns(r.json()["dataset_id"])
    assert len(stored) == 20 and stored["mixed"].dropna().map(type).eq(str).all()


# ---------- validation and limits ----------

def test_rejects_unknown_extension_empty_and_unparseable_files(client):
    assert upload(client, b"a,b\n1,2\n", name="notes.txt").status_code == 422
    assert upload(client, b"").status_code == 422
    assert upload(client, b"just text without table structure").status_code == 422
    assert upload(client, b"a,b\n", name="empty.csv").status_code == 422
    assert upload(client, b"\x00\x01garbage", name="broken.xlsx").status_code == 422


def test_row_and_column_limits(client, monkeypatch):
    monkeypatch.setenv("DATASET_MAX_ROWS", "5")
    r = upload(client, csv_bytes(make_frame(20)))
    assert r.status_code == 413 and "rows" in r.json()["detail"]
    monkeypatch.setenv("DATASET_MAX_ROWS", "1000")
    monkeypatch.setenv("DATASET_MAX_COLUMNS", "2")
    assert upload(client, csv_bytes(make_frame(20))).status_code == 413
    assert os.listdir(store.data_dir()) == []  # nothing is left behind after a rejection


def test_upload_size_limit_by_header_and_by_counting(client, monkeypatch):
    monkeypatch.setenv("DATASET_MAX_UPLOAD_MB", "1")
    too_big = b"a\n" + b"1\n" * 1_300_000          # about 2.6 MB: refused from Content-Length alone
    assert upload(client, too_big).status_code == 413
    slightly_big = b"a\n" + b"1\n" * 600_000        # about 1.2 MB: inside the framing slack, counted by the handler
    r = upload(client, slightly_big)
    assert r.status_code == 413 and "1 MB" in r.json()["detail"]


def test_storage_quotas_refuse_new_uploads_without_evicting(client, monkeypatch):
    first = upload(client, csv_bytes(make_frame(30))).json()["dataset_id"]
    monkeypatch.setenv("DATASET_MAX_TOTAL_MB", "0")
    assert upload(client, csv_bytes(make_frame(30))).status_code == 507
    monkeypatch.setenv("DATASET_MAX_TOTAL_MB", "5000")
    monkeypatch.setenv("DATASET_MAX_PER_CLIENT_MB", "0")
    assert upload(client, csv_bytes(make_frame(30))).status_code == 507
    assert client.get(f"/api/datasets/{first}").status_code == 200


def test_busy_server_answers_503(client, monkeypatch):
    import asyncio
    monkeypatch.setattr(datasets_route, "QUEUE_WAIT_SECONDS", 0.05)
    monkeypatch.setattr(datasets_route, "_ingest_slots", asyncio.Semaphore(0))
    r = upload(client, csv_bytes(make_frame(10)))
    assert r.status_code == 503 and r.headers["retry-after"]


def test_upload_rate_limit_uses_the_connection_address_not_a_forged_header(client, monkeypatch):
    monkeypatch.setenv("DATASET_UPLOAD_RATE_PER_MIN", "1")
    assert upload(client, csv_bytes(make_frame(10)), headers={"X-Client-IP": "1.1.1.1"}).status_code == 200
    assert upload(client, csv_bytes(make_frame(10)), headers={"X-Client-IP": "2.2.2.2"}).status_code == 429


# ---------- ids, expiry and deletion ----------

@pytest.mark.parametrize("bad", ["short", "../../etc/passwd", "a" * 22 + "/..", "!" * 22, "A" * 23])
def test_malformed_ids_are_not_found(client, bad):
    with pytest.raises(store.DatasetNotFound):
        store.get_meta(bad)
    assert client.get(f"/api/datasets/{bad}").status_code in (404, 405)


def test_unknown_but_well_formed_id_is_not_found(client):
    assert client.get("/api/datasets/" + "A" * 22).status_code == 404
    assert client.delete("/api/datasets/" + "A" * 22).status_code == 404


def test_delete_removes_the_dataset(client):
    dataset_id = upload(client, csv_bytes(make_frame(20))).json()["dataset_id"]
    assert client.delete(f"/api/datasets/{dataset_id}").json() == {"deleted": True}
    assert client.get(f"/api/datasets/{dataset_id}").status_code == 404
    assert not (store.data_dir() / dataset_id).exists()


def _age(dataset_id, seconds):
    meta = store.data_dir() / dataset_id / "meta.json"
    old = time.time() - seconds
    os.utime(meta, (old, old))


def test_idle_datasets_expire_and_use_keeps_them_alive(client, monkeypatch):
    monkeypatch.setenv("DATASET_TTL_HOURS", "24")
    kept = upload(client, csv_bytes(make_frame(20))).json()["dataset_id"]
    expired = upload(client, csv_bytes(make_frame(20))).json()["dataset_id"]
    _age(kept, 23 * 3600)
    _age(expired, 25 * 3600)
    assert client.get(f"/api/datasets/{kept}").status_code == 200     # reading refreshes the clock
    assert store.purge_expired() == 1
    assert client.get(f"/api/datasets/{expired}").status_code == 404
    _age(kept, 3600)
    assert client.get(f"/api/datasets/{kept}").json()["expires_at"] > time.time() + 23 * 3600


def test_expired_dataset_cannot_be_read_even_before_the_sweep(client):
    dataset_id = upload(client, csv_bytes(make_frame(20))).json()["dataset_id"]
    _age(dataset_id, 25 * 3600)
    assert client.get(f"/api/datasets/{dataset_id}/rows").status_code == 404
    assert not (store.data_dir() / dataset_id).exists()


def test_purge_removes_abandoned_partial_uploads(client):
    leftover = store.data_dir() / ".tmp-deadbeef"
    leftover.mkdir()
    (leftover / "data.parquet").write_bytes(b"x")
    old = time.time() - 2 * 3600
    os.utime(leftover, (old, old))
    fresh = store.data_dir() / ".tmp-up-inprogress"
    fresh.mkdir()
    store.purge_expired()
    assert not leftover.exists() and fresh.exists()


# ---------- analyses by dataset id ----------

ROLES = {"outcome": "bp", "group": "arm"}


def plan(client, **source):
    return client.post("/api/r/plan", headers=HEADERS,
                       json={"test": "independent_t_test", "variables": ROLES, **source})


def test_plan_by_dataset_id_matches_inline_rows(client):
    df = make_frame(120)
    dataset_id = upload(client, csv_bytes(df)).json()["dataset_id"]
    inline = plan(client, data=df[["bp", "arm"]].to_dict(orient="records"))
    stored = plan(client, dataset_id=dataset_id)
    assert inline.status_code == stored.status_code == 200
    assert stored.json() == inline.json()


def test_checks_by_dataset_id_match_inline_rows(client):
    df = make_frame(120)
    dataset_id = upload(client, csv_bytes(df)).json()["dataset_id"]
    body = {"test": "independent_t_test", "variables": ROLES}
    inline = client.post("/api/r/checks", headers=HEADERS,
                         json={**body, "data": df[["bp", "arm"]].to_dict(orient="records")})
    stored = client.post("/api/r/checks", headers=HEADERS, json={**body, "dataset_id": dataset_id})
    assert inline.status_code == stored.status_code == 200 and stored.json() == inline.json()


def test_r_routes_need_exactly_one_data_source(client):
    assert plan(client).status_code == 422
    assert plan(client, data=[{"bp": 1, "arm": "A"}], dataset_id="A" * 22).status_code == 422


def test_r_routes_still_need_the_api_key_and_a_live_dataset(client):
    dataset_id = upload(client, csv_bytes(make_frame(40))).json()["dataset_id"]
    body = {"test": "independent_t_test", "variables": ROLES, "dataset_id": dataset_id}
    assert client.post("/api/r/plan", json=body).status_code == 401
    assert plan(client, dataset_id="A" * 22).status_code == 404
    _age(dataset_id, 25 * 3600)
    assert plan(client, dataset_id=dataset_id).status_code == 404


def test_unknown_columns_get_the_usual_validation_message(client):
    dataset_id = upload(client, csv_bytes(make_frame(40))).json()["dataset_id"]
    r = client.post("/api/r/plan", headers=HEADERS,
                    json={"test": "independent_t_test", "variables": {"outcome": "nope", "group": "arm"},
                          "dataset_id": dataset_id})
    assert r.status_code == 422 and "nope" in r.json()["detail"]


def test_only_the_needed_columns_are_loaded(client, monkeypatch):
    dataset_id = upload(client, csv_bytes(make_frame(40))).json()["dataset_id"]
    seen = {}
    real = store.pd.read_parquet

    def spy(path, columns=None, **kw):
        seen["columns"] = columns
        return real(path, columns=columns, **kw)

    monkeypatch.setattr(store.pd, "read_parquet", spy)
    assert plan(client, dataset_id=dataset_id).status_code == 200
    assert seen["columns"] == ["bp", "arm"]


# ---------- servers without pyarrow (for example the Render build) ----------

def test_missing_pyarrow_turns_storage_off_without_breaking_the_api(client, monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "pyarrow", None)
    monkeypatch.setitem(sys.modules, "pyarrow.parquet", None)
    r = upload(client, csv_bytes(make_frame(20)))
    assert r.status_code == 503 and "not available" in r.json()["detail"]
    assert plan(client, dataset_id="A" * 22).status_code == 503
    assert client.get("/health").status_code == 200
    assert plan(client, data=[{"bp": 1.0, "arm": "A"}, {"bp": 2.0, "arm": "A"},
                              {"bp": 3.0, "arm": "B"}, {"bp": 4.0, "arm": "B"}]).status_code == 200


def test_app_starts_when_pyarrow_cannot_be_imported():
    import subprocess
    import sys
    code = ("import sys; sys.modules['pyarrow'] = None; sys.modules['pyarrow.parquet'] = None; "
            "import app.main; print('started')")
    done = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=400,
                          env={**os.environ, "HF_HUB_OFFLINE": "1"})
    assert done.returncode == 0 and "started" in done.stdout, done.stderr[-800:]
