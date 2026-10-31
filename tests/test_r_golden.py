"""Deterministic R result goldens captured with R 4.5.2."""
import asyncio
import hashlib
import json
import math
import shutil
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.services.r_templates import run_named_test

pytestmark = pytest.mark.skipif(shutil.which("Rscript") is None, reason="Rscript not installed")
GOLDENS = json.loads((Path(__file__).parent / "fixtures" / "rGolden.json").read_text(encoding="utf-8"))


def _cases():
    groups = pd.DataFrame({
        "outcome": [3.0, 5.0, 6.5, 8.0, 10.0, 12.5, 14.0, 17.0, 2.0, 4.5, 5.0, 7.5, 8.5, 10.0, 12.0, 13.5],
        "group": ["A"] * 8 + ["B"] * 8,
    })
    paired_first = np.array([14.0, 16.0, 19.0, 21.0, 23.0, 25.0, 28.0, 31.0, 34.0, 36.0, 40.0, 43.0])
    paired_delta = np.array([1.1, 2.4, 1.8, 3.2, 0.7, 2.9, 1.4, 3.8, 2.1, 0.9, 4.2, 1.7])
    paired = pd.DataFrame({"first": paired_first, "second": paired_first - paired_delta})
    group_values = {
        "A": [8.2, 9.1, 10.4, 11.0, 12.3, 13.1, 14.2, 15.0],
        "B": [11.4, 12.2, 13.0, 14.8, 15.1, 16.3, 17.7, 18.2],
        "C": [15.3, 16.0, 17.4, 18.8, 19.1, 20.5, 21.2, 22.7],
    }
    three_groups = pd.DataFrame(
        [(group, value) for group, values in group_values.items() for value in values],
        columns=["group", "outcome"],
    )
    chi_square = pd.DataFrame(
        [
            (group, response)
            for group, yes, no in [("A", 22, 8), ("B", 12, 18)]
            for response, count in [("yes", yes), ("no", no)]
            for _ in range(count)
        ],
        columns=["group", "response"],
    )
    corr_x = np.arange(1, 13, dtype=float)
    correlation = pd.DataFrame({
        "x": corr_x,
        "y": 1.7 * corr_x + np.array([0.3, -0.4, 0.2, 0.8, -0.5, 0.1, -0.7, 0.4, 0.2, -0.2, 0.6, -0.3]),
    })
    shapiro = pd.DataFrame({"value": [-1.4, -0.8, -0.5, -0.2, 0.0, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.3]})

    regression_rng = np.random.default_rng(2026)
    n_regression = 80
    x1 = regression_rng.normal(size=n_regression)
    x2 = regression_rng.normal(size=n_regression)
    arm = regression_rng.choice(["control", "treatment"], size=n_regression)
    outcome = 4 + 1.6 * x1 - 2.0 * x2 + 1.1 * (arm == "treatment") + regression_rng.normal(0, 0.7, n_regression)
    linear = pd.DataFrame({"outcome": outcome, "x1": x1, "x2": x2, "arm": arm})

    logistic_rng = np.random.default_rng(41)
    n_logistic = 500
    x1 = logistic_rng.normal(size=n_logistic)
    x2 = logistic_rng.normal(size=n_logistic)
    arm = logistic_rng.choice(["control", "treatment"], size=n_logistic)
    probability = 1 / (1 + np.exp(-(-0.4 + 0.7 * x1 - 0.5 * x2 + 0.4 * (arm == "treatment"))))
    event = logistic_rng.binomial(1, probability)
    logistic = pd.DataFrame({"event": event, "x1": x1, "x2": x2, "arm": arm})

    # Rounded so the last-digit differences of logspace/pow across platforms cannot change the input hash.
    curve_x = np.array([float(f"{v:.9e}") for v in np.logspace(-9, -3, 20)])
    curve_noise = np.array([0.2, -0.3, 0.1, -0.2, 0.3, -0.1, 0.15, -0.25, 0.05, 0.2, -0.15, 0.1, -0.2, 0.25, -0.1, 0.15, -0.05, 0.1, -0.2, 0.15])
    dose_response = pd.DataFrame({
        "concentration": curve_x,
        "response": np.round(5 + 95 / (1 + (1e-6 / curve_x) ** 1.1) + curve_noise, 9),
    })
    substrate = np.array([0.5, 1, 2, 4, 8, 16, 32, 64], dtype=float)
    michaelis_menten = pd.DataFrame({
        "substrate": substrate,
        "rate": 50 * substrate / (5 + substrate) + np.array([0.2, -0.3, 0.1, -0.2, 0.3, -0.1, 0.15, -0.15]),
    })

    return {
        "independent_t_test": ({"outcome": "outcome", "group": "group"}, groups),
        "mann_whitney_u": ({"outcome": "outcome", "group": "group"}, groups),
        "paired_t_test": ({"first": "first", "second": "second"}, paired),
        "wilcoxon_signed_rank": ({"first": "first", "second": "second"}, paired),
        "one_way_anova": ({"outcome": "outcome", "group": "group"}, three_groups),
        "kruskal_wallis": ({"outcome": "outcome", "group": "group"}, three_groups),
        "chi_square": ({"var1": "group", "var2": "response"}, chi_square),
        "pearson_correlation": ({"x": "x", "y": "y"}, correlation),
        "shapiro_wilk": ({"variable": "value"}, shapiro),
        "linear_regression": (
            {"outcome": "outcome", "predictor_1": "x1", "predictor_2": "x2", "predictor_3": "arm"}, linear,
        ),
        "logistic_regression": (
            {"outcome": "event", "predictor_1": "x1", "predictor_2": "x2", "predictor_3": "arm"}, logistic,
        ),
        "dose_response_4pl": ({"x": "concentration", "y": "response"}, dose_response),
        "michaelis_menten": ({"x": "substrate", "y": "rate"}, michaelis_menten),
    }


def _fingerprint(variables, data):
    # Explicit LF: pandas defaults to CRLF on Windows, which would change the hash per platform.
    columns = list(dict.fromkeys(variables.values()))
    return hashlib.sha256(data[columns].to_csv(index=False, lineterminator="\n").encode("utf-8")).hexdigest()


def _assert_golden(actual, expected, test, path=()):
    if isinstance(expected, dict):
        assert isinstance(actual, dict)
        for key, value in expected.items():
            _assert_golden(actual[key], value, test, path + (key,))
        return
    if isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected)
        for index, value in enumerate(expected):
            _assert_golden(actual[index], value, test, path + (str(index),))
        return
    if path[-1] in {"p_value", "spearman_p_value"}:
        assert 0 <= actual <= 1
        if expected == 0:
            assert actual == 0
        else:
            assert math.log10(actual) == pytest.approx(math.log10(expected), abs=1e-6)
        return
    if isinstance(expected, int) and not isinstance(expected, bool):
        assert actual == expected
        return
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        rel, absolute = (1e-4, 1e-12) if test == "dose_response_4pl" and path[-1] in {"ec50", "estimate"} else (1e-6, 1e-8)
        if test == "michaelis_menten" and path[-1] == "estimate":
            rel, absolute = 1e-4, 1e-8
        assert actual == pytest.approx(expected, rel=rel, abs=absolute)
        return
    assert actual == expected


@pytest.mark.parametrize("test", sorted(GOLDENS["cases"]))
def test_r_procedure_matches_golden_reference(test):
    variables, data = _cases()[test]
    result = asyncio.run(run_named_test(test, variables, data))
    assert result["ok"], result["error"]
    golden = GOLDENS["cases"][test]
    assert _fingerprint(variables, data) == golden["data_sha256"]
    _assert_golden(result["results"], golden["expected"], test)