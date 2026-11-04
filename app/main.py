import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import analytics, agent, datasets
from app.security.body_limit import BodyLimitMiddleware
from app.services import dataset_store, docker_sandbox

PURGE_INTERVAL_SECONDS = 1800


async def _purge_loop() -> None:
    while True:
        await asyncio.sleep(PURGE_INTERVAL_SECONDS)
        try:
            await asyncio.to_thread(dataset_store.purge_expired)
        except Exception:
            logging.getLogger("omnistat.main").exception("Dataset expiry sweep failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Fail loudly in the logs (jobs already fail closed) if a sandbox is misconfigured.
    app.state.sandbox = await asyncio.to_thread(docker_sandbox.verify_configured)
    purger = asyncio.create_task(_purge_loop())
    try:
        yield
    finally:
        purger.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await purger


app = FastAPI(
    title="OmniStat AI",
    description="AI-powered statistical analysis engine for clinical and research data",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(BodyLimitMiddleware, path="/api/datasets", max_bytes=dataset_store.max_upload_bytes)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Core routes (always loaded) ─────────────────────────────────
app.include_router(analytics.router, prefix="/api/analytics", tags=["Analytics"])
app.include_router(datasets.router,  prefix="/api/datasets",  tags=["Datasets"])
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
    """Used by Render and Docker healthchecks. Stays 'ok' (liveness only); sandbox
    problems are reported alongside so they are visible without failing the probe."""
    body = {"status": "ok"}
    sandbox = getattr(app.state, "sandbox", None)
    if sandbox:
        body["sandbox"] = {w: ("ready" if p is None else "unavailable") for w, p in sandbox.items()}
    return body