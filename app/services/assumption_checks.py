"""Read-only pre-run diagnostics for reviewed procedures; screening aids, not proof."""
import math
from typing import Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict
from scipy import stats

from app.services.analysis_plan import AnalysisPlan, prepare_analysis_plan
from app.services.r_templates import TEMPLATES

ALPHA = 0.05
SMALL_SAMPLE = 30
GENERAL_NOTES = [
    "Diagnostics use alpha 0.05 and are screening aids: p ≥ 0.05 does not prove an assumption holds, "
    "and large samples can flag small, unimportant departures.",
    "Independence and study design cannot be checked from the data.",
    "Outliers are flagged for review only. Do not remove values just because they are flagged.",
]


class AssumptionCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    status: Literal["ok", "warning", "info", "not_assessed"]
    detail: str
    n: int | None = None
    statistic: float | None = None
    p_value: float | None = None


class Suggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    test: str | None
    title: str
    reason: str


class AssumptionReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    procedure: str
    variables: dict[str, str]
    data_sha256: str
    alpha: float
    checks: list[AssumptionCheck]
    suggestion: Suggestion | None
    notes: list[str]


def _p(p: float) -> str:
    return "< 0.001" if p < 0.001 else f"{p:.3f}"


def _normality(check_id: str, label: str, values: np.ndarray) -> AssumptionCheck:
    n = len(values)
    if n < 3:
        return AssumptionCheck(id=check_id, label=label, status="not_assessed", n=n,
                               detail="Too few values for Shapiro-Wilk (needs at least 3).")
    if n > 5000:
        return AssumptionCheck(id=check_id, label=label, status="not_assessed", n=n,
                               detail="More than 5000 values; Shapiro-Wilk is not used. Inspect the Q-Q plot instead.")
    if np.ptp(values) == 0:
        return AssumptionCheck(id=check_id, label=label, status="not_assessed", n=n,
                               detail="All values are identical, so normality cannot be assessed.")
    w, p = stats.shapiro(values)
    if not (math.isfinite(w) and math.isfinite(p)):
        return AssumptionCheck(id=check_id, label=label, status="not_assessed", n=n,
                               detail="Shapiro-Wilk could not be computed for these values.")
    flagged = p < ALPHA
    return AssumptionCheck(
        id=check_id, label=label, status="warning" if flagged else "ok", n=n,
        statistic=float(w), p_value=float(p),
        detail=f"Shapiro-Wilk W = {w:.3f}, p = {_p(p)}: "
               + ("evidence of non-normality." if flagged else "no clear evidence of non-normality."),
    )


def _outliers(check_id: str, label: str, values: np.ndarray) -> AssumptionCheck:
    n = len(values)
    if n < 4:
        return AssumptionCheck(id=check_id, label=label, status="not_assessed", n=n,
                               detail="Too few values to flag outliers (needs at least 4).")
    q1, q3 = np.percentile(values, [25, 75])
    spread = 1.5 * (q3 - q1)
    count = int(((values < q1 - spread) | (values > q3 + spread)).sum())
    return AssumptionCheck(
        id=check_id, label=label, status="warning" if count else "ok", n=n,
        detail=f"{count} of {n} values outside Tukey fences (1.5 × IQR)."
               + (" Check them for data-entry errors." if count else ""),
    )


def _variance(groups: list[np.ndarray], welch: bool) -> AssumptionCheck:
    label = "Equal variances (Brown-Forsythe)"
    n = int(sum(len(g) for g in groups))
    if all(np.ptp(g) == 0 for g in groups):
        return AssumptionCheck(id="equal_variances", label=label, status="not_assessed", n=n,
                               detail="No within-group variation, so variances cannot be compared.")
    statistic, p = stats.levene(*groups, center="median")
    if not (math.isfinite(statistic) and math.isfinite(p)):
        return AssumptionCheck(id="equal_variances", label=label, status="not_assessed", n=n,
                               detail="The variance comparison could not be computed.")
    differ = p < ALPHA
    detail = f"Brown-Forsythe F = {statistic:.3f}, p = {_p(p)}: " + (
        "evidence that group variances differ." if differ else "no clear evidence that group variances differ.")
    if welch:
        detail += " Welch's t-test does not assume equal variances."
    elif differ:
        detail += " Standard ANOVA and Tukey HSD assume equal variances, so interpret them cautiously."
    status = "info" if welch else ("warning" if differ else "ok")
    return AssumptionCheck(id="equal_variances", label=label, status=status, n=n,
                           statistic=float(statistic), p_value=float(p), detail=detail)


def _robustness_note(min_n: int, procedure: str) -> str | None:
    if min_n >= SMALL_SAMPLE:
        return (f"With at least {SMALL_SAMPLE} observations per group, the {procedure} is usually robust to "
                "moderate non-normality; review strong skew and outliers before relying on it.")
    return None


def _group_labels(values: pd.Series) -> pd.Series:
    """Matches the group labels shown in the analysis plan."""
    if pd.api.types.is_bool_dtype(values):
        return values.map({True: "TRUE", False: "FALSE"})
    if pd.api.types.is_numeric_dtype(values):
        return values.map(lambda value: format(float(value), ".15g"))
    return values.astype(str)


def _alternative(test: str, reason: str) -> Suggestion:
    return Suggestion(test=test, title=TEMPLATES[test].title, reason=reason)


def check_assumptions(test: str, variables: dict[str, str], df: pd.DataFrame) -> AssumptionReport:
    plan: AnalysisPlan = prepare_analysis_plan(test, variables, df)
    v = plan.variables
    complete = df[list(v.values())].dropna()
    checks: list[AssumptionCheck] = []
    suggestion: Suggestion | None = None
    notes: list[str] = []

    if test in ("independent_t_test", "one_way_anova"):
        outcome = complete[v["outcome"]].astype(float)
        grouped = [(str(label), g.to_numpy()) for label, g in outcome.groupby(_group_labels(complete[v["group"]]), sort=True)]
        min_n = min(len(g) for _, g in grouped)
        if test == "independent_t_test":
            for label, values in grouped:
                checks.append(_normality(f"normality:{label}", f"Normality in group “{label}”", values))
        else:
            residuals = np.concatenate([g - g.mean() for _, g in grouped])
            checks.append(_normality("normality:residuals", "Normality of ANOVA residuals", residuals))
        checks.append(_variance([g for _, g in grouped], welch=test == "independent_t_test"))
        for label, values in grouped:
            checks.append(_outliers(f"outliers:{label}", f"Outliers in group “{label}”", values))
        non_normal = any(c.status == "warning" for c in checks if c.id.startswith("normality"))
        name = "t-test" if test == "independent_t_test" else "ANOVA"
        if non_normal and min_n < SMALL_SAMPLE:
            alternative = "mann_whitney_u" if test == "independent_t_test" else "kruskal_wallis"
            suggestion = _alternative(alternative, (
                f"Normality is questionable and the smallest group has {min_n} observations. This rank-based "
                "test does not assume normality, but it compares distributions rather than means."))
        elif non_normal and (note := _robustness_note(min_n, name)):
            notes.append(note)
    elif test == "paired_t_test":
        differences = (complete[v["first"]].astype(float) - complete[v["second"]].astype(float)).to_numpy()
        checks.append(_normality("normality:differences", "Normality of paired differences", differences))
        checks.append(_outliers("outliers:differences", "Outliers in paired differences", differences))
        if checks[0].status == "warning":
            if len(differences) < SMALL_SAMPLE:
                suggestion = _alternative("wilcoxon_signed_rank", (
                    f"Paired differences look non-normal with {len(differences)} pairs. The signed-rank test "
                    "does not assume normality, but it tests the median difference rather than the mean."))
            else:
                notes.append(f"With at least {SMALL_SAMPLE} pairs, the paired t-test is usually robust to moderate "
                             "non-normality; review strong skew and outliers before relying on it.")
    elif test == "pearson_correlation":
        for role in ("x", "y"):
            values = complete[v[role]].astype(float).to_numpy()
            checks.append(_normality(f"normality:{role}", f"Normality of “{v[role]}”", values))
            checks.append(_outliers(f"outliers:{role}", f"Outliers in “{v[role]}”", values))
        if any(c.status == "warning" for c in checks):
            suggestion = Suggestion(test=None, title="Spearman's rank correlation (reported with this analysis)", reason=(
                "Non-normal values or outliers can distort Pearson's r. Spearman's rho, already reported alongside, "
                "measures monotonic association and is less sensitive to them."))
        notes.append("Linearity cannot be fully judged from these checks; inspect the scatter plot.")
    else:
        notes.append("This procedure is itself a normality check, so no additional diagnostics are run.")

    return AssumptionReport(
        procedure=test, variables=v, data_sha256=plan.data_sha256, alpha=ALPHA,
        checks=checks, suggestion=suggestion, notes=notes + GENERAL_NOTES,
    )
