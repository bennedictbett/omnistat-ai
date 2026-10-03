import asyncio

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security import rate_limit
from app.services import r_runner

KEY = "test-key-123"
# unknown test name: passes auth + rate limiting, then 422s before R ever runs
BODY = {"test": "nope", "variables": {}, "data": [{"a": 1}]}


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    rate_limit.reset()
    monkeypatch.setenv("OMNISTAT_API_KEYS", KEY)
    monkeypatch.setenv("R_RATE_LIMIT_PER_MIN", "3")
    monkeypatch.setenv("R_GLOBAL_RATE_PER_MIN", "100")
    yield
    rate_limit.reset()


@pytest.fixture
def client():
    return TestClient(app)


def post(client, key=KEY, ip=None):
    headers = {}
    if key is not None:
        headers["X-API-Key"] = key
    if ip:
        headers["X-Client-IP"] = ip
    return client.post("/api/r/run", json=BODY, headers=headers)


def test_missing_key_is_401(client):
    assert post(client, key=None).status_code == 401


def test_wrong_key_is_401(client):
    assert post(client, key="wrong").status_code == 401


def test_valid_key_passes_auth(client):
    assert post(client).status_code == 422  # got past auth, rejected by validation


def test_fails_closed_when_no_key_configured(client, monkeypatch):
    monkeypatch.delenv("OMNISTAT_API_KEYS")
    assert post(client).status_code == 503


def test_second_key_works_for_rotation(client, monkeypatch):
    monkeypatch.setenv("OMNISTAT_API_KEYS", f"old-key,{KEY}")
    assert post(client).status_code == 422
    assert post(client, key="old-key").status_code == 422


def test_rate_limit_blocks_after_limit_with_retry_after(client):
    assert [post(client, ip="1.1.1.1").status_code for _ in range(3)] == [422, 422, 422]
    r = post(client, ip="1.1.1.1")
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1


def test_rate_limit_is_per_client(client):
    for _ in range(3):
        post(client, ip="1.1.1.1")
    assert post(client, ip="1.1.1.1").status_code == 429
    assert post(client, ip="2.2.2.2").status_code == 422  # a different user is unaffected


def test_global_limit_applies_across_clients(client, monkeypatch):
    monkeypatch.setenv("R_GLOBAL_RATE_PER_MIN", "2")
    assert post(client, ip="a").status_code == 422
    assert post(client, ip="b").status_code == 422
    assert post(client, ip="c").status_code == 429


def test_unauthenticated_requests_do_not_consume_rate_limit(client):
    for _ in range(10):
        post(client, key="wrong", ip="1.1.1.1")
    assert post(client, ip="1.1.1.1").status_code == 422


def test_busy_runner_raises_instead_of_hanging(monkeypatch):
    monkeypatch.setattr(r_runner, "_sem", asyncio.Semaphore(0))  # no free slots
    monkeypatch.setattr(r_runner, "QUEUE_WAIT_SECONDS", 0.2)
    with pytest.raises(r_runner.RunnerBusy):
        asyncio.run(r_runner.run_r("1"))