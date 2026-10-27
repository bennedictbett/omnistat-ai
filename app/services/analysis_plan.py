"""Versioned, deterministic plans for the first reviewed analysis workflow."""
import hashlib
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict

from app.services.r_templates import TemplateError, prepare_test_data


class AnalysisPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["1.0"]
    procedure: Literal["independent_t_test"]
    engine: Literal["r"]
    title: str
    variables: dict[str, str]
    data_sha256: str
    rows_total: int
    rows_used: int
    rows_dropped_missing: int
    group_counts: dict[str, int]
    alternative: Literal["two.sided"]
    confidence_level: Literal[0.95]
    equal_variances: Literal[False]
    missing_data_policy: Literal["complete_cases"]
    assumptions: list[str]
    outputs: list[str]


def prepare_analysis_plan(test: str, variables: dict[str, str], df: pd.DataFrame) -> AnalysisPlan:
    if test != "independent_t_test":
        raise TemplateError("Plan review currently supports only independent_t_test")
    if len(set(variables.values())) != len(variables):
        raise TemplateError("Choose a different column for each variable role")
    variables = {role: variables[role] for role in ("outcome", "group") if role in variables} | {
        role: col for role, col in variables.items() if role not in ("outcome", "group")
    }
    csv = prepare_test_data(test, variables, df)
    complete = df[[variables["outcome"], variables["group"]]].dropna()
    outcome = complete[variables["outcome"]]
    if not pd.api.types.is_numeric_dtype(outcome) or pd.api.types.is_bool_dtype(outcome):
        raise TemplateError("Outcome variable must be numeric")
    if not np.isfinite(outcome.to_numpy(dtype=float)).all():
        raise TemplateError("Outcome values must be finite")
    group_values = complete[variables["group"]]
    if pd.api.types.is_bool_dtype(group_values):
        groups = group_values.map({True: "TRUE", False: "FALSE"})
    elif pd.api.types.is_numeric_dtype(group_values):
        if not np.isfinite(group_values.to_numpy(dtype=float)).all():
            raise TemplateError("Group values must be finite")
        groups = group_values.map(lambda value: format(float(value), ".15g"))
    else:
        if not group_values.map(lambda value: isinstance(value, str)).all():
            raise TemplateError("Use consistently numeric or text group labels")
        if group_values.eq("NA").any() or pd.to_numeric(group_values, errors="coerce").notna().all():
            raise TemplateError("Use numeric group codes or non-numeric text labels other than 'NA' for plan review")
        groups = group_values
    counts = groups.value_counts().sort_index()
    if len(counts) != 2 or (counts < 2).any():
        raise TemplateError("Choose exactly two groups with at least two complete observations each")
    return AnalysisPlan(
        schema_version="1.0",
        procedure="independent_t_test",
        engine="r",
        title="Welch two-sample t-test",
        variables=variables,
        data_sha256=hashlib.sha256(csv).hexdigest(),
        rows_total=len(df),
        rows_used=len(complete),
        rows_dropped_missing=len(df) - len(complete),
        group_counts={str(group): int(count) for group, count in counts.items()},
        alternative="two.sided",
        confidence_level=0.95,
        equal_variances=False,
        missing_data_policy="complete_cases",
        assumptions=[
            "Observations are independent; confirm this from the study design.",
            "The outcome is continuous, with approximately normal within-group distributions or adequate sample sizes.",
            "Inspect outliers and the Shapiro-Wilk diagnostics; these checks do not prove assumptions.",
            "Equal group variances are not required by Welch's test.",
        ],
        outputs=["t statistic", "degrees of freedom", "p-value", "mean difference",
                 "95% confidence interval", "Cohen's d", "group summaries",
                 "Shapiro-Wilk diagnostics", "box plot", "reproducible R code"],
    )
