"""
Agent route — kept for backwards compatibility with the frontend's useJarvis hook.
All logic lives in AnalystAgent; this is a thin wrapper.
"""

from fastapi import APIRouter
from pydantic import BaseModel

from app.agents.analyst_agent import AnalystAgent

router = APIRouter()
agent  = AnalystAgent()


class QueryRequest(BaseModel):
    query:   str
    context: dict = {}


@router.post("/query")
async def query_agent(request: QueryRequest):
    """
    Natural language → statistical procedure routing.

    The classifier runs first (local ONNX, ~5 ms, no API cost).
    If confidence ≥ 0.50, Groq extracts parameters for the classified family.
    If confidence < 0.50, the top-3 options are returned for the user to confirm.

    Low-confidence response (needs_clarification=True):
    {
        "success": true,
        "needs_clarification": true,
        "options": [
            {"intent": "compare_two_groups", "confidence": 0.38},
            {"intent": "compare_paired",     "confidence": 0.21},
            {"intent": "normality",          "confidence": 0.14}
        ],
        "route": "/analytics/compare-groups",
        "raw_query": "are these different"
    }

    High-confidence response:
    {
        "success": true,
        "needs_clarification": false,
        "family": "survival",
        "route": "/analytics/survival",
        "intent": {
            "test": "kaplan_meier",
            "variables": ["time_to_event", "event_occurred"],
            "assumptions": ["non_informative_censoring"],
            "parameters": {"confidence_interval": 0.95},
            "visualization": "survival_curve"
        },
        "top3": [...],
        "model_used": "openai/gpt-oss-20b",
        "classifier_source": "model"
    }
    """
    return await agent.process(request.query, request.context)