"""Conversational Jarvis: chats, and proposes analyses on the uploaded dataset.

The model sees column names and types only, never data values or results, and may
only propose actions. The server validates every action against the real test
catalogue and the caller's columns; the browser asks for confirmation before any
reviewed analysis runs. Statistics shown to users come from R, not from this model.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import Literal

from pydantic import BaseModel, Field

from app.agents.analyst_agent import _build_kwargs, _extract_json, _models
from app.services.r_templates import supported_tests

logger = logging.getLogger("omnistat.agent.chat")

MAX_HISTORY = 12
MAX_REPLY_CHARS = 1500
MAX_DESCRIPTIVE_COLUMNS = 10
MAX_OPTIONS = 4
# Figures that describe methods, not data; anything else must come from the user.
METHOD_NUMBERS = {"0.05", "95%", "0.95", "95"}
NUMBER_BLOCKED_REPLY = (
    "I can't state statistics myself, because I don't see your data values. "
    "Run the analysis to get results computed in R."
)


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)


class ColumnInfo(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    type: Literal["numeric", "categorical"]
    distinct: int | None = Field(default=None, ge=0)
    label: str | None = Field(default=None, max_length=200)


class DatasetContext(BaseModel):
    rows: int = Field(ge=0)
    columns: list[ColumnInfo] = Field(max_length=300)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)
    dataset: DatasetContext | None = None


class JarvisUnavailable(Exception):
    """Raised with a user-safe message when the language model cannot be used."""


def _catalog_text(catalog: dict) -> str:
    lines = []
    for name, spec in catalog.items():
        roles = ", ".join(
            f"{role}{' (optional)' if role in spec['optional'] else ''}: {desc}"
            for role, desc in spec["variables"].items()
        )
        lines.append(f"- {name} — {spec['title']}. Roles: {roles}")
    return "\n".join(lines)


def system_prompt(catalog: dict) -> str:
    return f"""You are Jarvis, the friendly statistics assistant inside OmniStat AI, a clinical data analysis app.
Chat naturally (greetings, questions about statistics, help choosing tests), and help the user run analyses on their uploaded dataset.

Respond with ONLY a JSON object: {{"reply": "<message to the user>", "action": <action or null>}}.

Actions (use at most one, and only when the user wants to analyse their data):
1. {{"type": "run_analysis", "test": "<test name>", "variables": {{"<role>": "<column name>"}}}}
   Use only these tests and roles; fill every required role with an exact column name from the dataset:
{_catalog_text(catalog)}
2. {{"type": "descriptive", "columns": ["<numeric column>", ...]}}  (empty list = all numeric columns)
3. {{"type": "choose_test", "options": [{{"test": "<test name>", "reason": "<short reason>"}}]}}  (2-{MAX_OPTIONS} options, when several tests fit)

Rules:
- You never see data values or results. NEVER state statistics, p-values, means or other numbers about the data. Results are computed by R and shown to the user separately.
- Use exact column names from the dataset context. If no dataset is uploaded, ask the user to upload one (action null).
- If the request is ambiguous (unclear columns, groups or paired design), ask a short question or use choose_test.
- Paired/before-after measurements on the same subjects: paired_t_test (or wilcoxon_signed_rank). Two independent groups: independent_t_test (or mann_whitney_u). Three or more groups: one_way_anova (or kruskal_wallis). Binary (yes/no) outcome predicted by variables: logistic_regression. Numeric outcome predicted by variables: linear_regression.
- For run_analysis, briefly say what you prepared and that the user reviews and confirms it before it runs. Descriptive statistics run immediately: say they are being calculated (no confirmation). Keep replies under 120 words. Do not claim a result or its values.
- Only the tests listed above are available. If the user asks for any other analysis (e.g. Cox or survival models), say OmniStat does not support it yet and suggest the closest supported option or the Test Wizard; do not blame their data."""


def _dataset_text(dataset: DatasetContext | None) -> str:
    if dataset is None or not dataset.columns:
        return ("CURRENT DATASET: none shared. The user has not uploaded data, or chose not to share column names. "
                "Ask them to upload a file (or turn on column sharing) before preparing analyses.")
    cols = [
        {k: v for k, v in c.model_dump().items() if v is not None}
        for c in dataset.columns
    ]
    return (f"CURRENT DATASET: the user HAS uploaded a dataset with {dataset.rows} rows. "
            f"Do not ask them to upload data. Columns: {json.dumps(cols)}")


def _numbers(text: str) -> set[str]:
    return set(re.findall(r"\d+(?:\.\d+)?%?|\.\d+%?", text))


def unsupported_numbers(reply: str, allowed_text: str) -> set[str]:
    """Numbers in the reply that are neither method constants, small counts nor taken from the conversation."""
    allowed = _numbers(allowed_text) | METHOD_NUMBERS
    found = set()
    for token in _numbers(reply):
        if token in allowed:
            continue
        if re.fullmatch(r"\d+", token) and int(token) <= 10:
            continue
        found.add(token)
    return found


def validate_action(action: object, catalog: dict, dataset: DatasetContext | None) -> tuple[dict | None, str | None]:
    """Return (safe action, user-facing problem). Invalid actions are never passed on silently."""
    if action is None:
        return None, None
    if not isinstance(action, dict):
        return None, "Jarvis proposed an action in an unexpected format, so nothing was prepared."
    columns = {c.name: c for c in dataset.columns} if dataset else {}
    kind = action.get("type")
    if kind in ("run_analysis", "descriptive") and not columns:
        return None, "Upload a dataset first; no analysis was prepared."

    if kind == "run_analysis":
        test = action.get("test")
        variables = action.get("variables")
        if test not in catalog:
            return None, f"Jarvis suggested “{test}”, which is not available. Use the Test Wizard to choose a supported analysis."
        spec = catalog[test]
        if not isinstance(variables, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in variables.items()):
            return None, "Jarvis did not specify the columns correctly. Choose them yourself in the analysis panel."
        variables = {role: col for role, col in variables.items() if col}
        unknown_roles = [r for r in variables if r not in spec["variables"]]
        missing_roles = [r for r in spec["variables"] if r not in spec["optional"] and r not in variables]
        unknown_cols = [c for c in variables.values() if c not in columns]
        if unknown_roles or missing_roles or unknown_cols or len(set(variables.values())) != len(variables):
            return {"type": "run_analysis", "test": test, "variables": {}}, (
                "Jarvis could not match every column to your dataset, so please choose the columns yourself."
            )
        return {"type": "run_analysis", "test": test, "variables": variables}, None

    if kind == "descriptive":
        requested = action.get("columns") or []
        numeric = [n for n, c in columns.items() if c.type == "numeric"]
        if not isinstance(requested, list) or not all(isinstance(c, str) for c in requested):
            return None, "Jarvis did not specify the columns correctly; no descriptive statistics were prepared."
        chosen = [c for c in requested if c in numeric] if requested else numeric
        if not chosen:
            return None, "None of the requested columns are numeric, so descriptive statistics cannot be calculated."
        problem = None
        if requested and len(chosen) < len(requested):
            problem = "Some requested columns are not numeric and were left out."
        if len(chosen) > MAX_DESCRIPTIVE_COLUMNS:
            chosen = chosen[:MAX_DESCRIPTIVE_COLUMNS]
            problem = f"Only the first {MAX_DESCRIPTIVE_COLUMNS} numeric columns are included."
        return {"type": "descriptive", "columns": chosen}, problem

    if kind == "choose_test":
        options = action.get("options")
        if not isinstance(options, list):
            return None, "Jarvis's suggestions were in an unexpected format."
        valid = [
            {"test": o["test"], "title": catalog[o["test"]]["title"], "reason": str(o.get("reason", ""))[:200]}
            for o in options if isinstance(o, dict) and o.get("test") in catalog
        ][:MAX_OPTIONS]
        if not valid:
            return None, "Jarvis suggested analyses that are not available. Use the Test Wizard instead."
        return {"type": "choose_test", "options": valid}, None

    return None, "Jarvis proposed an unknown action, so nothing was prepared."


class ChatAgent:
    def __init__(self):
        self._client = None

    def _client_or_raise(self):
        if not os.getenv("GROQ_API_KEY"):
            raise JarvisUnavailable("Jarvis chat is not configured on the server (missing GROQ_API_KEY). Use the Test Wizard instead.")
        if self._client is None:
            from groq import Groq
            self._client = Groq(api_key=os.getenv("GROQ_API_KEY"))
        return self._client

    def _complete(self, messages: list[dict]) -> dict:
        client = self._client_or_raise()
        for model in _models():
            json_mode = True
            while True:
                try:
                    response = client.chat.completions.create(**_build_kwargs(model, messages, json_mode))
                    raw = (response.choices[0].message.content or "").strip()
                    if not raw:
                        logger.warning("chat model %s returned empty content", model)
                        break
                    parsed = _extract_json(raw)
                    if not isinstance(parsed.get("reply"), str):
                        logger.warning("chat model %s returned JSON without a reply", model)
                        break
                    return parsed
                except Exception as e:  # noqa: BLE001 - Groq raises many error types; try the next model
                    status = getattr(e, "status_code", None)
                    logger.warning("chat model %s failed (json_mode=%s): %s %s", model, json_mode, status or "", type(e).__name__)
                    if status == 401:
                        raise JarvisUnavailable("Jarvis chat is misconfigured on the server (the AI key was rejected). Use the Test Wizard instead.") from e
                    if status == 400 and json_mode:
                        json_mode = False
                        continue
                    break
        raise JarvisUnavailable("Jarvis is unavailable right now. Try again in a moment, or use the Test Wizard.")

    def chat(self, request: ChatRequest) -> dict:
        catalog = supported_tests()
        history = request.messages[-MAX_HISTORY:]
        messages = [
            {"role": "system", "content": f"{system_prompt(catalog)}\n\n{_dataset_text(request.dataset)}\n"
                                          "This dataset information is current and overrides anything said earlier in the conversation."},
            *({"role": m.role, "content": m.content} for m in history),
        ]
        parsed = self._complete(messages)
        reply = parsed["reply"].strip()[:MAX_REPLY_CHARS] or "Sorry, I didn't catch that. Could you rephrase?"
        allowed_text = " ".join(m.content for m in history if m.role == "user") + " " + _dataset_text(request.dataset)
        if unsupported_numbers(reply, allowed_text):
            logger.warning("chat reply contained unsupported numbers; replaced")
            reply = NUMBER_BLOCKED_REPLY
        action, problem = validate_action(parsed.get("action"), catalog, request.dataset)
        if action and action["type"] == "descriptive":
            # Descriptives run immediately, so drop any "please confirm" wording from the model.
            kept = [x for x in re.split(r"(?<=[.!?])\s+", reply) if not re.search(r"\bconfirm", x, re.I)]
            reply = " ".join(kept) or "Calculating descriptive statistics now."
        return {"reply": reply, "action": action, "action_problem": problem}
