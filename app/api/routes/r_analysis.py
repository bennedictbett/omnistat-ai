import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.r_templates import TemplateError, run_named_test, supported_tests

router = APIRouter()


class RAnalysisRequest(BaseModel):
    test: str = Field(..., description="Intent test name, e.g. 'independent_t_test'")
    variables: dict[str, str] = Field(..., description="role -> column name, per /r/tests")
    data: list[dict] = Field(..., description="Rows, e.g. the upload endpoint's full_data")


@router.get("/tests")
def list_r_tests():
    """Tests that can be executed in R, with the variable roles each needs."""
    return supported_tests()


@router.post("/run")
async def run_r_test(req: RAnalysisRequest):
    try:
        df = pd.DataFrame(req.data)
        return await run_named_test(req.test, req.variables, df)
    except TemplateError as e:
        raise HTTPException(status_code=422, detail=str(e))