"""R analyses at large n. Runs where R is available directly or through the Docker sandbox."""
import asyncio
import shutil

import numpy as np
import pandas as pd
import pytest
from scipy import stats

from app.services import r_runner
from app.services.r_templates import run_named_test

pytestmark = pytest.mark.skipif(
    shutil.which("Rscript") is None and not r_runner.DOCKER_SANDBOX,
    reason="needs Rscript or R_SANDBOX=docker",
)


def run(coro):
    return asyncio.run(coro)


def test_logistic_auc_is_not_lost_to_integer_overflow_at_large_n():
    # 100,000 rows with about 50,000 of each outcome: n1 * n0 is about 2.5e9, above 2^31.
    rng = np.random.default_rng(3)
    n = 100_000
    x = rng.normal(size=n)
    y = np.where(rng.random(n) < 1 / (1 + np.exp(-0.8 * x)), "yes", "no")
    df = pd.DataFrame({"y": y, "x": x})

    out = run(run_named_test("logistic_regression", {"outcome": "y", "predictor_1": "x"}, df))

    assert out["ok"], out["error"]
    assert "overflow" not in out["stderr"]
    scores = out["results"]
    assert scores["auc"] is not None
    fitted = 1 / (1 + np.exp(-(scores["coefficients"][0]["estimate_log_odds"] + scores["coefficients"][1]["estimate_log_odds"] * x)))
    ranks = stats.rankdata(fitted)
    positive = y == "yes"
    n_pos, n_neg = float(positive.sum()), float((~positive).sum())  # floats: int32 products overflow here too
    expected = (ranks[positive].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg)
    assert scores["auc"] == pytest.approx(expected, abs=1e-6)
