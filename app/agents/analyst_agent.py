import json
import logging
import os

from dotenv import load_dotenv

from app.agents.prompts import STATISTICAL_INTENT_PROMPT

load_dotenv()

logger = logging.getLogger("omnistat.agent")

# Groq retires models regularly (groq/compound was shut down on 2026-09-21), so the list
# can be changed without a code change: set GROQ_INTENT_MODELS="modelA,modelB" on the server.
DEFAULT_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]

FAILURE = {
    "success": False,
    "error": "Failed to parse intent — try rephrasing your query",
}


def _models() -> list:
    raw = os.getenv("GROQ_INTENT_MODELS", "")
    models = [m.strip() for m in raw.split(",") if m.strip()]
    return models or DEFAULT_MODELS


def _extract_json(raw: str) -> dict:
    """Parse the JSON object out of a model reply, tolerating code fences or extra prose."""
    text = raw.replace("```json", "").replace("```", "").strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object in model reply")
    return json.loads(text[start : end + 1])


def _build_kwargs(model: str, messages: list, json_mode: bool) -> dict:
    kwargs = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        # gpt-oss models spend part of this budget on reasoning, so keep it generous
        "max_tokens": 1500,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    if "gpt-oss" in model:
        # Sent via extra_body because the pinned groq SDK (0.8/0.9) has no reasoning_effort
        # argument and would raise TypeError. extra_body works on every SDK version.
        kwargs["extra_body"] = {"reasoning_effort": "low"}
    return kwargs


class AnalystAgent:
    def __init__(self):
        self._client = None

    def get_client(self):
        if self._client is None:
            from groq import Groq
            self._client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        return self._client

    async def process(self, query: str, context: dict = None) -> dict:
        context = context or {}
        messages = [
            {"role": "system", "content": STATISTICAL_INTENT_PROMPT},
            {
                "role": "user",
                "content": f"Query: {query}\nContext: {json.dumps(context)}\n\nRespond with ONLY a JSON object, no other text.",
            },
        ]

        for model in _models():
            json_mode = True
            while True:
                try:
                    kwargs = _build_kwargs(model, messages, json_mode)
                    response = self.get_client().chat.completions.create(**kwargs)
                    choice = response.choices[0]
                    raw = (choice.message.content or "").strip()
                    if not raw:
                        logger.warning(
                            "intent model %s returned empty content (finish_reason=%s)",
                            model, getattr(choice, "finish_reason", None),
                        )
                        break  # try the next model
                    return {"success": True, "intent": _extract_json(raw), "model_used": model}

                except Exception as e:  # noqa: BLE001 - log the reason, then decide what to do
                    status = getattr(e, "status_code", None)
                    logger.warning(
                        "intent model %s failed (json_mode=%s): %s %s: %s",
                        model, json_mode, status or "", type(e).__name__, str(e)[:200],
                    )
                    if status == 401:
                        logger.error("Groq rejected the API key (401). Check GROQ_API_KEY on this server.")
                        return dict(FAILURE)
                    if status == 400 and json_mode:
                        json_mode = False  # this model may not support JSON mode: retry once without it
                        continue
                    break  # try the next model

        return dict(FAILURE)