from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import analytics, agent

app = FastAPI(
    title="OmniStat AI",
    description="AI-powered statistical analysis engine for clinical and research data",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Core routes (always loaded) ─────────────────────────────────
app.include_router(analytics.router, prefix="/api/analytics", tags=["Analytics"])
app.include_router(agent.router,     prefix="/api/agent",     tags=["Agent"])

# ── Optional routes (loaded only if the file is implemented) ───
def _try_include(module_path: str, prefix: str, tag: str) -> None:
    """Import a route module and include it, silently skip if not ready."""
    import importlib
    try:
        mod = importlib.import_module(module_path)
        app.include_router(mod.router, prefix=prefix, tags=[tag])
    except Exception as e:
        import logging
        logging.getLogger("omnistat.main").warning(
            "Route %s not loaded: %s", prefix, e
        )

_try_include("app.api.routes.r_analysis", "/api/r",     "R Analysis")
_try_include("app.api.routes.math",       "/api/math",  "Equations")
_try_include("app.api.routes.voice",      "/api/voice", "Voice")


# ── Health check ────────────────────────────────────────────────
@app.get("/", tags=["Health"])
def root():
    return {
        "status":  "OmniStat AI is running",
        "version": "1.0.0",
        "endpoints": {
            "analytics": "/api/analytics",
            "agent":     "/api/agent",
            "r":         "/api/r",
            "math":      "/api/math",
            "voice":     "/api/voice",
            "docs":      "/docs",
        },
    }


@app.get("/health", tags=["Health"])
def health():
    """Used by Render and Docker healthchecks."""
    return {"status": "ok"}