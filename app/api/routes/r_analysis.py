import asyncio

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator

from app.security.rate_limit import rate_limit_r
from app.services import dataset_store
from app.services.r_runner import RunnerBusy
from app.services.r_templates import TemplateError, run_named_test, supported_tests
from app.services.analysis_plan import AnalysisPlan, prepare_analysis_plan
from app.services.assumption_checks import check_assumptions
from app.services.reproducibility_bundle import BundleError, BundleResult, build_bundle

router = APIRouter()


def _exactly_one_source(data, dataset_id):
    if (data is None) == (dataset_id is None):
        raise ValueError("Send either 'data' (rows) or 'dataset_id', not both and not neither")


class RAnalysisRequest(BaseModel):
    test: str = Field(..., description="Intent test name, e.g. 'independent_t_test'")
    variables: dict[str, str] = Field(..., description="role -> column name, per /r/tests")
    data: list[dict] | None = Field(None, description="Rows, e.g. the upload endpoint's full_data")
    dataset_id: str | None = Field(None, description="A dataset stored with POST /api/datasets (use instead of data)")
    analysis_plan: AnalysisPlan | None = None

    @model_validator(mode="after")
    def _one_source(self):
        _exactly_one_source(self.data, self.dataset_id)
        return self


class BundleRequest(BaseModel):
    result: BundleResult
    data: list[dict] | None = None
    dataset_id: str | None = None

    @model_validator(mode="after")
    def _one_source(self):
        _exactly_one_source(self.data, self.dataset_id)
        return self


def _frame(data: list[dict] | None, dataset_id: str | None, variables: dict[str, str]) -> pd.DataFrame:
    """The rows an analysis runs on: sent inline, or only the needed columns of a stored dataset."""
    if dataset_id is None:
        return pd.DataFrame(data)
    try:
        return dataset_store.load_columns(dataset_id, list(variables.values()))
    except dataset_store.DatasetError as e:
        raise HTTPException(status_code=e.status, detail=str(e)) from e


@router.post("/bundle", dependencies=[Depends(rate_limit_r)])
def export_r_bundle(req: BundleRequest):
    try:
        df = _frame(req.data, req.dataset_id, req.result.variables)
        archive = build_bundle(req.result, df)
    except (BundleError, TemplateError) as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return Response(
        archive, media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="omnistat-reproducibility.zip"',
                 "Cache-Control": "no-store"},
    )


@router.post("/plan", dependencies=[Depends(rate_limit_r)])
def review_r_plan(req: RAnalysisRequest):
    try:
        return prepare_analysis_plan(req.test, req.variables, _frame(req.data, req.dataset_id, req.variables))
    except TemplateError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/checks", dependencies=[Depends(rate_limit_r)])
def check_r_assumptions(req: RAnalysisRequest):
    try:
        return check_assumptions(req.test, req.variables, _frame(req.data, req.dataset_id, req.variables))
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
        # Loading and preparing large datasets is CPU/IO work: keep it off the event loop.
        df = await asyncio.to_thread(_frame, req.data, req.dataset_id, req.variables)
        plan = None
        if req.analysis_plan is not None:
            plan = await asyncio.to_thread(prepare_analysis_plan, req.test, req.variables, df)
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