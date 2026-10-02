from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.routes import analytics, agent, r_analysis 

app = FastAPI(
    title="OmniStat AI",
    description="AI-powered statistical analysis engine for clinical and research data",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(
    analytics.router,
    prefix="/api/analytics",
    tags=["Analytics"]
)

app.include_router(
    r_analysis.router,
    prefix="/api/r",
    tags=["R Analysis"]
)

app.include_router(
    agent.router,
    prefix="/api/agent",
    tags=["Agent"]
)



@app.get("/")
def root():
    return {
        "status": "OmniStat AI is running",
        "version": "1.0.0",
        "endpoints": {
            "analytics": "/api/analytics",
            "agent": "/api/agent",
            "docs": "/docs"
        }
    }