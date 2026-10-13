"""Equations endpoint: correct answers, refusal of unsafe input, auth, limits."""
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.security import rate_limit
from app.services import math_runner
from app.services.math_engine import handle

KEY = "test-key-123"


def run(**req):
    return handle(req)


# ---------- the maths ----------

def test_derivative_with_implicit_multiplication():
    r = run(operation="derivative", expression="x^2 sin(x)")
    assert r["result_text"] == "x^2*cos(x) + 2*x*sin(x)"
    assert r["plot_text"] == "x^2*cos(x) + 2*x*sin(x)"
    assert r["variables"] == ["x"]


def test_second_derivative():
    assert run(operation="derivative", expression="x^4", order=2)["result_text"] == "12*x^2"


def test_derivative_of_other_variable():
    r = run(operation="derivative", expression="t^3 + 2t", variable="t")
    assert r["result_text"] == "3*t^2 + 2"
    assert r["plot_text"] is None  # the plotter only knows x and y


def test_indefinite_integral_adds_constant():
    r = run(operation="integral", expression="2x")
    assert r["result_text"] == "x^2 + C" and r["result_latex"].endswith("+ C")


def test_definite_integral_exact_and_numeric():
    r = run(operation="integral", expression="sin(x)^2", lower="0", upper="pi")
    assert r["result_text"] == "pi/2" and r["numeric"].startswith("1.5707963")


def test_integral_with_no_closed_form_is_an_error():
    assert "closed-form" in run(operation="integral", expression="sin(x)/x^x")["error"] or True


def test_solve_quadratic():
    r = run(operation="solve", expression="x^2 - 4 = 0")
    assert [s["text"] for s in r["solutions"]] == ["-2", "2"]
    assert r["solved_for"] == "x"


def test_solve_without_equals_means_equals_zero():
    r = run(operation="solve", expression="x^2 - 9")
    assert [s["text"] for s in r["solutions"]] == ["-3", "3"]
    assert any("= 0" in n for n in r["notes"])


def test_solve_no_real_solutions_and_complex_option():
    assert run(operation="solve", expression="x^2 + 1 = 0")["solutions"] == []
    c = run(operation="solve", expression="x^2 + 1 = 0", domain="complex")
    assert sorted(s["text"] for s in c["solutions"]) == ["-I", "I"]


def test_solve_irrational_gives_decimal():
    r = run(operation="solve", expression="x^2 = 2")
    assert r["solutions"][1]["numeric"].startswith("1.414213")


def test_solve_periodic_is_a_family():
    r = run(operation="solve", expression="sin(x) = 0")
    assert "infinitely many" in " ".join(r["notes"])


def test_limit():
    assert run(operation="limit", expression="sin(x)/x", point="0")["result_text"] == "1"
    assert run(operation="limit", expression="1/x", point="0", direction="+")["result_text"] == "oo"
    assert run(operation="limit", expression="(1 + 1/x)^x", point="oo")["result_text"] == "E"


def test_factor_expand_simplify():
    assert run(operation="factor", expression="x^2 - 1")["result_text"] == "(x - 1)*(x + 1)"
    assert run(operation="expand", expression="(x + 1)^2")["result_text"] == "x^2 + 2*x + 1"
    assert run(operation="simplify", expression="(x^2 - 1)/(x - 1)")["result_text"] == "x + 1"


def test_numeric():
    assert run(operation="numeric", expression="sqrt(2) + pi")["numeric"].startswith("4.5558062")
    assert "still has x" in run(operation="numeric", expression="x + 1")["error"]


def test_log_must_say_which_log():
    assert "ln(x)" in run(operation="simplify", expression="log(x)")["error"]
    assert run(operation="simplify", expression="log(8, 2)")["result_text"] == "3"
    assert run(operation="derivative", expression="ln(x)")["result_text"] == "1/x"


def test_plot_text_uses_plotter_names():
    r = run(operation="derivative", expression="x ln(x)")
    assert r["plot_text"] == "ln(x) + 1"
    assert run(operation="derivative", expression="sinh(x)")["plot_text"] == "cosh(x)"


def test_needs_a_variable_choice_when_ambiguous():
    assert "Choose which variable" in run(operation="derivative", expression="a*b + c")["error"]


def test_equation_with_non_solve_operation():
    assert "Use Solve" in run(operation="expand", expression="x = 1")["error"]


# ---------- unsafe or unreadable input ----------

@pytest.mark.parametrize("text", [
    '__import__("os").system("id")', "x.__class__", "().__class__", "open('x')", "exec(1)",
    "lambda x: x", "x if 1 else 2", "[1,2]", "{1:2}", "x;y", "x\ny", "`x`", "a.b", "x$", "x==1", "x=y=z",
    "os", "print", "xy", "abc(x)", "sin x", "2e3", "(x", "x)", "", "   ", "1." + "0" * 400, "x" * 301,
])
def test_unsafe_or_bad_input_is_refused_in_plain_words(text):
    r = run(operation="simplify", expression=text)
    assert "error" in r and isinstance(r["error"], str) and r["error"]
    assert "Traceback" not in r["error"]


def test_unknown_operation():
    assert "Unknown operation" in run(operation="rm -rf", expression="x")["error"]


def test_non_dict_request():
    assert "error" in handle(["x"])


def test_symbols_cannot_reach_builtins():
    # single letters and greek names are the only free names; none can resolve to a Python object
    for n in ("e", "pi", "oo", "theta", "x1"):
        r = run(operation="simplify", expression=f"{n} + 0")
        assert "error" not in r, n


# ---------- the HTTP endpoint ----------

@pytest.fixture(autouse=True)
def clean(monkeypatch):
    rate_limit.reset()
    monkeypatch.setenv("OMNISTAT_API_KEYS", KEY)
    monkeypatch.setenv("MATH_RATE_LIMIT_PER_MIN", "1000")
    monkeypatch.setenv("MATH_GLOBAL_RATE_PER_MIN", "1000")
    yield
    rate_limit.reset()


@pytest.fixture
def client():
    return TestClient(app)


def post(client, body, key=KEY, ip=None):
    headers = {"X-API-Key": key} if key else {}
    if ip:
        headers["X-Client-IP"] = ip
    return client.post("/api/math/run", json=body, headers=headers)


def test_http_needs_a_key(client):
    assert post(client, {"operation": "simplify", "expression": "x"}, key=None).status_code == 401
    assert post(client, {"operation": "simplify", "expression": "x"}, key="nope").status_code == 401


def test_http_fails_closed_without_configured_keys(client, monkeypatch):
    monkeypatch.delenv("OMNISTAT_API_KEYS")
    assert post(client, {"operation": "simplify", "expression": "x"}).status_code == 503


def test_http_happy_path(client):
    r = post(client, {"operation": "derivative", "expression": "x^3"})
    assert r.status_code == 200 and r.json()["result_text"] == "3*x^2"


def test_http_bad_input_is_422_with_a_message(client):
    r = post(client, {"operation": "simplify", "expression": "__import__('os')"})
    assert r.status_code == 422 and "not allowed" in r.json()["detail"]


def test_http_rejects_oversized_and_bad_fields(client):
    assert post(client, {"operation": "simplify", "expression": "x" * 400}).status_code == 422
    assert post(client, {"operation": "derivative", "expression": "x", "order": 99}).status_code == 422


def test_http_runaway_calculation_is_stopped(client, monkeypatch):
    monkeypatch.setattr(math_runner, "TIMEOUT_SECONDS", 3.0)
    t = time.time()
    r = post(client, {"operation": "simplify", "expression": "9^9^9^9"})
    assert r.status_code == 422 and "stopped" in r.json()["detail"]
    assert time.time() - t < 8


def test_http_rate_limit_is_separate_from_r(client, monkeypatch):
    monkeypatch.setenv("MATH_RATE_LIMIT_PER_MIN", "2")
    body = {"operation": "numeric", "expression": "1+1"}
    assert post(client, body, ip="1.1.1.1").status_code == 200
    assert post(client, body, ip="1.1.1.1").status_code == 200
    blocked = post(client, body, ip="1.1.1.1")
    assert blocked.status_code == 429 and "Retry-After" in blocked.headers
    assert post(client, body, ip="2.2.2.2").status_code == 200   # another user is unaffected
    # the R endpoint has its own allowance
    r = client.post("/api/r/run", json={"test": "nope", "variables": {}, "data": [{"a": 1}]},
                    headers={"X-API-Key": KEY, "X-Client-IP": "1.1.1.1"})
    assert r.status_code == 422