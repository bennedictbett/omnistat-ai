import asyncio
import logging
from types import SimpleNamespace

from app.agents import analyst_agent
from app.agents.analyst_agent import AnalystAgent


class StatusError(Exception):
    def __init__(self, status_code, msg="boom"):
        super().__init__(msg)
        self.status_code = status_code


def make_agent(behaviors):
    """behaviors: list of str (model reply) or Exception (raised), consumed one per API call."""
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        b = behaviors.pop(0)
        if isinstance(b, Exception):
            raise b
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=b), finish_reason="stop")])

    agent = AnalystAgent()
    agent._client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    return agent, calls


def run(agent, q="compare two groups"):
    return asyncio.run(agent.process(q))


GOOD = '{"test": "independent_t_test", "variables": ["bp", "group"]}'


def test_default_models_do_not_include_retired_compound():
    assert not any("compound" in m for m in analyst_agent.DEFAULT_MODELS)


def test_first_model_success_and_request_shape():
    agent, calls = make_agent([GOOD])
    r = run(agent)
    assert r["success"] and r["intent"]["test"] == "independent_t_test"
    assert r["model_used"] == "openai/gpt-oss-20b" and len(calls) == 1
    c = calls[0]
    assert c["reasoning_effort"] == "low" and c["max_tokens"] >= 1000
    assert c["response_format"] == {"type": "json_object"}


def test_falls_back_to_second_model_on_server_error():
    agent, calls = make_agent([StatusError(500), GOOD])
    r = run(agent)
    assert r["success"] and r["model_used"] == "openai/gpt-oss-120b"


def test_empty_content_moves_to_next_model():
    agent, _ = make_agent(["", GOOD])
    assert run(agent)["model_used"] == "openai/gpt-oss-120b"


def test_json_inside_fence_and_prose_is_parsed():
    agent, _ = make_agent(['Sure!\n```json\n{"test": "pearson_correlation", "variables": ["a", "b"]}\n```\nDone.'])
    assert run(agent)["intent"]["test"] == "pearson_correlation"


def test_non_json_reply_moves_on():
    agent, _ = make_agent(["I think a t-test", GOOD])
    assert run(agent)["model_used"] == "openai/gpt-oss-120b"


def test_400_retries_same_model_without_json_mode():
    agent, calls = make_agent([StatusError(400), GOOD])
    r = run(agent)
    assert r["success"] and r["model_used"] == "openai/gpt-oss-20b"
    assert "response_format" in calls[0] and "response_format" not in calls[1]
    assert calls[0]["model"] == calls[1]["model"]


def test_401_stops_immediately_and_logs_key_problem(caplog):
    agent, calls = make_agent([StatusError(401, "Invalid API Key")])
    with caplog.at_level(logging.WARNING, logger="omnistat.agent"):
        r = run(agent)
    assert not r["success"] and len(calls) == 1
    assert "GROQ_API_KEY" in caplog.text


def test_all_models_fail_returns_failure_and_logs_reasons(caplog):
    agent, calls = make_agent([StatusError(404, "model not found"), StatusError(404, "model not found")])
    with caplog.at_level(logging.WARNING, logger="omnistat.agent"):
        r = run(agent)
    assert r == {"success": False, "error": "Failed to parse intent — try rephrasing your query"}
    assert "model not found" in caplog.text and len(calls) == 2


def test_models_can_be_overridden_by_env(monkeypatch):
    monkeypatch.setenv("GROQ_INTENT_MODELS", "some/other-model")
    agent, calls = make_agent([GOOD])
    r = run(agent)
    assert r["model_used"] == "some/other-model"
    assert "reasoning_effort" not in calls[0]  # only sent to gpt-oss models