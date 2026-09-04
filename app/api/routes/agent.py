from fastapi import APIRouter
from app.agents.analyst_agent import AnalystAgent
from pydantic import BaseModel

router = APIRouter()
agent = AnalystAgent()

class QueryRequest(BaseModel):
    query: str
    context: dict = {}

@router.post("/query")
async def query_agent(request: QueryRequest):
    """
    Natural language → statistical procedure routing.
    
    Example input:
    {
        "query": "compare blood pressure between two groups before and after treatment"
    }
    
    Example output:
    {
        "success": true,
        "intent": {
            "test": "paired_t_test",
            "variables": ["blood_pressure", "group"],
            "assumptions": ["normality", "equal_variance"],
            "parameters": { "confidence_interval": 0.95 },
            "visualization": "boxplot"
        }
    }
    """
    return await agent.process(request.query, request.context)