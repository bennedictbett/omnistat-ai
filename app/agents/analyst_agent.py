import json
import logging
import os

from dotenv import load_dotenv

from app.agents.prompts import STATISTICAL_INTENT_PROMPT
from app.ml.predict import classify, PredictResult

load_dotenv()

logger = logging.getLogger("omnistat.agent")

# Groq retires models regularly (groq/compound was shut down on 2026-09-21), so the list
# can be changed without a code change: set GROQ_INTENT_MODELS="modelA,modelB" on the server.
DEFAULT_MODELS = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]

FAILURE = {
    "success": False,
    "error": "Failed to parse intent — try rephrasing your query",
}

# Maps each intent family to the analytics route the API will call.
# The agent fills in the parameters; the router picks the endpoint.
FAMILY_TO_ROUTE: dict[str, str] = {
    "compare_two_groups":       "/analytics/compare-groups",
    "compare_paired":           "/analytics/compare-paired",
    "one_sample":               "/analytics/one-sample",
    "compare_multi_groups":     "/analytics/compare-groups",
    "repeated_measures":        "/analytics/repeated-measures",
    "post_hoc":                 "/analytics/post-hoc",
    "normality":                "/analytics/normality",
    "correlation":              "/analytics/correlation",
    "regression_continuous":    "/analytics/regression",
    "regression_binary_count":  "/analytics/regression",
    "survival":                 "/analytics/survival",
    "categorical_association":  "/analytics/categorical",
    "diagnostic_agreement":     "/analytics/diagnostic",
    "descriptive":              "/analytics/descriptive",
    "epi_measures":             "/analytics/epi",
    "sample_size_power":        "/analytics/power",
    "ml_supervised":            "/analytics/ml",
    "unsupervised":             "/analytics/unsupervised",
    "time_series":              "/analytics/time-series",
    "quality_control":          "/analytics/qc",
    "advanced_modeling":        "/analytics/advanced",
    "genomics":                 "/analytics/genomics",
    "chart_request":            "/analytics/chart",
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
        "max_tokens": 1500,
    }
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    if "gpt-oss" in model:
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

        # ── Step 1: classify intent with the local ONNX model ──
        clf: PredictResult = classify(query)
        family   = clf.top1.intent
        route    = FAMILY_TO_ROUTE.get(family, "/analytics/descriptive")
        top3     = [{"intent": p.intent, "confidence": p.confidence} for p in clf.top3]

        logger.info(
            "classifier: query=%r family=%s confidence=%.2f source=%s",
            query, family, clf.top1.confidence, clf.top1.source,
        )

        # ── Step 2: if confidence is low, return options early ──
        # The frontend shows the top-3 choices and asks the user to confirm
        # before calling Groq. This saves API cost and avoids wrong analyses.
        if clf.low_confidence:
            logger.info("low confidence (%.2f) — returning options to frontend", clf.top1.confidence)
            return {
                "success":        True,
                "needs_clarification": True,
                "options":        top3,
                "route":          route,
                "raw_query":      query,
                "classifier_source": clf.top1.source,
            }

        # ── Step 3: ask Groq to extract parameters ─────────────
        # The prompt now includes the pre-classified family so the LLM
        # focuses on parameter extraction, not test selection.
        enriched_context = {
            **context,
            "classified_intent": family,
            "suggested_route":   route,
        }
        messages = [
            {"role": "system", "content": STATISTICAL_INTENT_PROMPT},
            {
                "role": "user",
                "content": (
                    f"Query: {query}\n"
                    f"Context: {json.dumps(enriched_context)}\n\n"
                    "The intent has already been classified as "
                    f"'{family}'. Extract the parameters for this "
                    "analysis and respond with ONLY a JSON object."
                ),
            },
        ]

        for model in _models():
            json_mode = True
            while True:
                try:
                    kwargs   = _build_kwargs(model, messages, json_mode)
                    response = self.get_client().chat.completions.create(**kwargs)
                    choice   = response.choices[0]
                    raw      = (choice.message.content or "").strip()
                    if not raw:
                        logger.warning(
                            "intent model %s returned empty content (finish_reason=%s)",
                            model, getattr(choice, "finish_reason", None),
                        )
                        break
                    parsed = _extract_json(raw)
                    return {
                        "success":           True,
                        "intent":            parsed,
                        "family":            family,
                        "route":             route,
                        "top3":              top3,
                        "model_used":        model,
                        "classifier_source": clf.top1.source,
                        "needs_clarification": False,
                    }

                except Exception as e:  # noqa: BLE001
                    status = getattr(e, "status_code", None)
                    logger.warning(
                        "intent model %s failed (json_mode=%s): %s %s: %s",
                        model, json_mode, status or "", type(e).__name__, str(e)[:200],
                    )
                    if status == 401:
                        logger.error("Groq rejected the API key (401). Check GROQ_API_KEY.")
                        return dict(FAILURE)
                    if status == 400 and json_mode:
                        json_mode = False
                        continue
                    break

        # Groq failed — fall back to classifier result alone
        logger.warning("all Groq models failed — returning classifier result only")
        return {
            "success":           True,
            "intent":            {"test": family},
            "family":            family,
            "route":             route,
            "top3":              top3,
            "model_used":        None,
            "classifier_source": clf.top1.source,
            "needs_clarification": False,
            "groq_failed":       True,
        }