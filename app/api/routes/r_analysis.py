import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.security.rate_limit import rate_limit_r
from app.services.r_runner import RunnerBusy
from app.services.r_templates import TemplateError, run_named_test, supported_tests
from app.services.analysis_plan import AnalysisPlan, prepare_analysis_plan

router = APIRouter()


class RAnalysisRequest(BaseModel):
    test: str = Field(..., description="Intent test name, e.g. 'independent_t_test'")
    variables: dict[str, str] = Field(..., description="role -> column name, per /r/tests")
    data: list[dict] = Field(..., description="Rows, e.g. the upload endpoint's full_data")
    analysis_plan: AnalysisPlan | None = None


@router.post("/plan", dependencies=[Depends(rate_limit_r)])
def review_r_plan(req: RAnalysisRequest):
    try:
        return prepare_analysis_plan(req.test, req.variables, pd.DataFrame(req.data))
    except TemplateError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.get("/tests")
def list_r_tests():
    """Tests that can be executed in R, with the variable roles each needs."""
    return supported_tests()


# rate_limit_r depends on require_api_key, so auth runs first, then the limiter.
@router.post("/run", dependencies=[Depends(rate_limit_r)])
async def run_r_test(req: RAnalysisRequest):
    try:
        df = pd.DataFrame(req.data)
        plan = None
        if req.analysis_plan is not None:
            plan = prepare_analysis_plan(req.test, req.variables, df)
            if plan != req.analysis_plan:
                raise HTTPException(status_code=409, detail="The analysis plan or data changed. Review a new plan before running.")
            # Use canonical role order so the executed CSV matches the reviewed fingerprint.
            variables = plan.variables
        else:
            variables = req.variables
        result = await run_named_test(req.test, variables, df)
        if plan is not None:
            result["analysis_plan"] = plan.model_dump()
        return result
    except TemplateError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except RunnerBusy as e:
        raise HTTPException(status_code=503, detail=str(e), headers={"Retry-After": "10"})