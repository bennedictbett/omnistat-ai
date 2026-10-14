from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.security.rate_limit import rate_limit_math
from app.services.math_engine import OPERATIONS
from app.services.math_runner import MathBusy, MathFailure, MathTimeout, run_math

router = APIRouter()


class MathRequest(BaseModel):
    operation: str = Field(..., description=f"One of: {', '.join(OPERATIONS)}")
    expression: str = Field(..., max_length=300, description="e.g. 'x^2 sin(x)' or 'x^2 - 4 = 0'")
    variable: str | None = Field(None, max_length=12, description="Variable to differentiate / integrate / solve for")
    order: int | None = Field(None, ge=1, le=5, description="Derivative order")
    lower: str | None = Field(None, max_length=60, description="Definite integral lower limit")
    upper: str | None = Field(None, max_length=60, description="Definite integral upper limit")
    point: str | None = Field(None, max_length=60, description="Where a limit is taken, e.g. '0' or 'oo'")
    direction: str | None = Field(None, description="Limit direction: both, + or -")
    domain: str | None = Field(None, description="Solve over 'real' (default) or 'complex' numbers")


@router.get("/operations")
def list_operations():
    return {"operations": list(OPERATIONS)}


# rate_limit_math depends on require_api_key, so auth runs first, then the limiter.
@router.post("/run", dependencies=[Depends(rate_limit_math)])
async def run_math_operation(req: MathRequest):
    try:
        result = await run_math(req.model_dump(exclude_none=True))
    except MathTimeout as e:
        raise HTTPException(status_code=422, detail=str(e))
    except MathBusy as e:
        raise HTTPException(status_code=503, detail=str(e), headers={"Retry-After": "5"})
    except MathFailure:
        raise HTTPException(status_code=500, detail="The maths engine failed. Try again.")
    if "error" in result:
        raise HTTPException(status_code=422, detail=result["error"])
    return result