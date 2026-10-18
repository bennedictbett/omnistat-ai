import logging

from fastapi import APIRouter, HTTPException, UploadFile, File

from app.agents.analyst_agent import AnalystAgent
from app.services.analytics_service import AnalyticsService

router  = APIRouter()
service = AnalyticsService()
agent   = AnalystAgent()
logger  = logging.getLogger("omnistat.routes.analytics")


# ── Natural-language entry point ────────────────────────────────

@router.post("/query")
async def query(body: dict):
    """
    Main entry point for the Jarvis input.
    Body: { "query": "compare blood pressure between two groups", "context": {} }

    Returns either:
      - needs_clarification=True  → show top3 options to user
      - needs_clarification=False → intent + route + parameters ready
    """
    q = (body.get("query") or "").strip()
    if not q:
        raise HTTPException(status_code=422, detail="query must not be empty")
    ctx = body.get("context") or {}
    return await agent.process(q, ctx)


# ── Direct statistical endpoints ────────────────────────────────

@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload clinical Excel/CSV file for analysis."""
    return await service.parse_file(file)


@router.post("/normality")
async def normality_check(data: dict):
    """
    Run Shapiro-Wilk normality test.
    Body: { "values": [1.2, 2.3, 3.1, ...] }
    """
    return service.normality_test(data)


@router.post("/survival")
async def survival_curve(data: dict):
    """
    Generate Kaplan-Meier survival curve.
    Body: { "durations": [...], "event_observed": [...], "label": "Group A" }
    """
    return service.kaplan_meier(data)


@router.post("/descriptive")
async def descriptive_stats(data: dict):
    """
    Run descriptive statistics on a list of values.
    Body: { "values": [...], "column": "blood_pressure" }
    """
    return service.descriptive_statistics(data)


@router.post("/compare-groups")
async def compare_groups(data: dict):
    """
    Compare two or more independent groups.
    Body: { "values": [...], "groups": [...], "parametric": true }
    Runs t-test, ANOVA, Mann-Whitney or Kruskal-Wallis depending on
    the number of groups and the parametric flag.
    """
    return service.compare_groups(data)


@router.post("/compare-paired")
async def compare_paired(data: dict):
    """
    Compare paired observations (before/after).
    Body: { "before": [...], "after": [...], "parametric": true }
    """
    return service.compare_paired(data)


@router.post("/correlation")
async def correlation(data: dict):
    """
    Compute correlation between two variables.
    Body: { "x": [...], "y": [...], "method": "pearson" }
    """
    return service.correlation(data)


@router.post("/regression")
async def regression(data: dict):
    """
    Run linear or logistic regression.
    Body: { "outcome": [...], "predictors": { "age": [...], "bmi": [...] }, "type": "linear" }
    """
    return service.regression(data)


@router.post("/categorical")
async def categorical(data: dict):
    """
    Chi-square or Fisher exact test.
    Body: { "table": [[a, b], [c, d]] }
    """
    return service.categorical_test(data)


@router.post("/power")
async def power(data: dict):
    """
    Sample size / power calculation.
    Body: { "test": "t-test", "effect_size": 0.5, "alpha": 0.05, "power": 0.8 }
    """
    return service.power_analysis(data)