"""Versioned, deterministic plans for the first reviewed analysis workflow."""
import hashlib
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict

from app.services.r_templates import TEMPLATES, TemplateError, prepare_test_data

ReviewedProcedure = Literal[
    "independent_t_test", "paired_t_test", "one_way_anova",
    "pearson_correlation", "shapiro_wilk",
]


class AnalysisPlan(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    schema_version: Literal["1.0"]
    procedure: ReviewedProcedure
    engine: Literal["r"]
    title: str
    variables: dict[str, str]
    data_sha256: str
    rows_total: int
    rows_used: int
    rows_dropped_missing: int
    group_counts: dict[str, int]
    alternative: Literal["two.sided"] | None
    confidence_level: Literal[0.95] | None
    equal_variances: bool | None
    missing_data_policy: Literal["complete_cases"]
    assumptions: list[str]
    outputs: list[str]


def prepare_analysis_plan(test: str, variables: dict[str, str], df: pd.DataFrame) -> AnalysisPlan:
    if test not in ("independent_t_test", "paired_t_test", "one_way_anova", "pearson_correlation", "shapiro_wilk"):
        raise TemplateError("Plan review is not available for this procedure")
    if len(set(variables.values())) != len(variables):
        raise TemplateError("Choose a different column for each variable role")
    roles = tuple(TEMPLATES[test].roles)
    variables = {role: variables[role] for role in roles if role in variables} | {
        role: col for role, col in variables.items() if role not in roles
    }
    csv = prepare_test_data(test, variables, df)
    complete = df[list(variables.values())].dropna()
    if test in ("paired_t_test", "pearson_correlation", "shapiro_wilk"):
        return _numeric_plan(test, variables, df, complete, csv)
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
    if test == "independent_t_test":
        if len(counts) != 2 or (counts < 2).any():
            raise TemplateError("Choose exactly two groups with at least two complete observations each")
    elif len(counts) < 3 or (counts < 2).any():
        raise TemplateError("Choose at least three groups with at least two complete observations each")
    if test == "one_way_anova":
        if not complete.groupby(variables["group"])[variables["outcome"]].var().gt(0).any():
            raise TemplateError("ANOVA requires non-zero within-group variation")
        return AnalysisPlan(
            schema_version="1.0", procedure="one_way_anova", engine="r",
            title=TEMPLATES[test].title, variables=variables,
            data_sha256=hashlib.sha256(csv).hexdigest(),
            rows_total=len(df), rows_used=len(complete),
            rows_dropped_missing=len(df) - len(complete),
            group_counts={str(group): int(count) for group, count in counts.items()},
            alternative=None, confidence_level=0.95, equal_variances=True,
            missing_data_policy="complete_cases",
            assumptions=[
                "Observations are independent; confirm this from the study design.",
                "Residuals should be approximately normal and group variances comparable.",
                "Inspect outliers, Fligner variance and residual Shapiro-Wilk diagnostics.",
                "Tukey HSD comparisons use family-wise 95% confidence intervals.",
            ],
            outputs=["F statistic", "degrees of freedom", "p-value", "eta squared",
                     "Tukey HSD comparisons", "group summaries", "variance and normality diagnostics",
                     "box plot", "reproducible R code"],
        )
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


def _numeric_plan(test: ReviewedProcedure, variables: dict[str, str], df: pd.DataFrame,
                  complete: pd.DataFrame, csv: bytes) -> AnalysisPlan:
    for column in variables.values():
        values = complete[column]
        if not pd.api.types.is_numeric_dtype(values) or pd.api.types.is_bool_dtype(values):
            raise TemplateError("Selected variables must be numeric")
        if not np.isfinite(values.to_numpy(dtype=float)).all():
            raise TemplateError("Selected values must be finite")
    minimum = 4 if test == "pearson_correlation" else 3
    if len(complete) < minimum:
        raise TemplateError(f"Need at least {minimum} complete observations")
    if test == "shapiro_wilk" and len(complete) > 5000:
        raise TemplateError("Shapiro-Wilk needs between 3 and 5000 observations")
    if test == "paired_t_test":
        differences = complete[variables["first"]] - complete[variables["second"]]
        if differences.nunique() < 2:
            raise TemplateError("Paired differences must have non-zero variation")
        assumptions = [
            "Each row is one matched pair; confirm matching and independence between pairs.",
            "Differences (first minus second), not the raw measurements, should be approximately normal.",
            "Inspect outliers and the Shapiro-Wilk diagnostic of paired differences.",
        ]
        outputs = ["t statistic", "degrees of freedom", "p-value", "mean paired difference",
                   "95% confidence interval", "paired effect size", "difference normality diagnostic",
                   "paired plot", "reproducible R code"]
    else:
        if any(complete[column].nunique() < 2 for column in variables.values()):
            raise TemplateError("Selected variables must not be constant")
        if test == "pearson_correlation":
            assumptions = [
                "Rows are independent matched observations for x and y.",
                "Pearson measures linear association; inspect the scatter plot and influential outliers.",
                "Normal-theory inference assumes approximate bivariate normality.",
                "Spearman is reported for comparison, not as an automatic replacement.",
            ]
            outputs = ["Pearson r", "p-value", "95% confidence interval", "complete-pair count",
                       "Spearman rho and p-value", "scatter plot", "reproducible R code"]
        else:
            assumptions = [
                "Observations should be independent and measured on a continuous scale.",
                "The null hypothesis is normality; p > 0.05 is not proof of normality.",
                "Inspect the Q-Q plot; sensitivity depends on sample size.",
            ]
            outputs = ["Shapiro-Wilk W", "p-value", "normality decision at alpha 0.05",
                       "observation count", "Q-Q plot", "reproducible R code"]
    return AnalysisPlan(
        schema_version="1.0", procedure=test, engine="r",
        title=TEMPLATES[test].title, variables=variables,
        data_sha256=hashlib.sha256(csv).hexdigest(),
        rows_total=len(df), rows_used=len(complete),
        rows_dropped_missing=len(df) - len(complete), group_counts={},
        alternative=None if test == "shapiro_wilk" else "two.sided",
        confidence_level=None if test == "shapiro_wilk" else 0.95,
        equal_variances=None, missing_data_policy="complete_cases",
        assumptions=assumptions, outputs=outputs,
    )
