"""Independent Python recomputation of the key statistics in an R result.

R stays the engine of record. After each successful run, the same prepared data is analysed again
with SciPy/statsmodels and the headline numbers are compared with R's. A disagreement means one
of the two engines (or the data preparation) deserves a closer look; it never changes the R result.
"""
from __future__ import annotations

import io
import logging
import math
import platform
import warnings
from importlib import metadata

import numpy as np
import pandas as pd
from scipy import stats

logger = logging.getLogger("omnistat.crosscheck")

MAX_ROWS = 50_000
# Exact rank tests get slow beyond this many observations per group; the p-value comparison is skipped.
_EXACT_LIMIT = 200

_REL = 1e-6
_ABS = 1e-9
_P_REL = 1e-5
_P_ABS = 1e-12
_FIT_REL = 1e-3
_FIT_SE_REL = 1e-2


class Unavailable(Exception):
    """The comparison cannot be made; the message is safe to show to the user."""


class _Checks:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, label: str, r_value, py_value, rel: float = _REL, abs_: float = _ABS) -> None:
        if not _is_number(r_value):
            return
        py = _finite(py_value)
        agree = py is not None and math.isclose(float(r_value), py, rel_tol=rel, abs_tol=abs_)
        self.items.append(
            {"label": label, "r": float(r_value), "python": py, "agree": agree, "rel_tolerance": rel}
        )

    def add_p(self, label: str, r_value, py_value) -> None:
        self.add(label, r_value, py_value, _P_REL, _P_ABS)


def _is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _finite(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _at(seq, index: int):
    return seq[index] if isinstance(seq, list) and len(seq) > index else None


def _label(v) -> str:
    """How R prints a value read from the CSV, so group names line up with R's."""
    if isinstance(v, (bool, np.bool_)):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (float, np.floating)) and float(v).is_integer():
        return str(int(v))
    return str(v)


def _numeric(series: pd.Series) -> np.ndarray:
    if not pd.api.types.is_numeric_dtype(series) or pd.api.types.is_bool_dtype(series):
        raise Unavailable("A column R treated as numeric could not be read as numbers in Python.")
    return series.to_numpy(dtype=float)


def _same_n(actual: int, expected, what: str) -> None:
    if _is_number(expected) and int(expected) != actual:
        raise Unavailable(f"Python and R counted a different number of {what}, so the results cannot be compared.")


# ---------- Group comparisons ----------

def _groups(df: pd.DataFrame, v: dict, res: dict) -> tuple[list[str], list[np.ndarray]]:
    sub = df[[v["outcome"], v["group"]]].dropna()
    y = _numeric(sub[v["outcome"]])
    labels = sub[v["group"]].map(_label).to_numpy()
    rows = res.get("groups")
    if not isinstance(rows, list) or not rows:
        raise Unavailable("R did not report its groups, so the results cannot be compared.")
    order = [str(r.get("group")) for r in rows]
    out = []
    for name, row in zip(order, rows):
        g = y[labels == name]
        _same_n(len(g), row.get("n"), "observations")
        out.append(g)
    if sum(len(g) for g in out) != len(y):
        raise Unavailable("Python found group values that R did not report, so the results cannot be compared.")
    return order, out


def _independent_t(df, v, res, c: _Checks) -> None:
    _, (a, b) = _groups(df, v, res)
    t = stats.ttest_ind(a, b, equal_var=False)
    ci = t.confidence_interval(0.95)
    diff = a.mean() - b.mean()
    n1, n2 = len(a), len(b)
    sp = math.sqrt(((n1 - 1) * a.var(ddof=1) + (n2 - 1) * b.var(ddof=1)) / (n1 + n2 - 2))
    c.add("t statistic", res.get("statistic_t"), t.statistic)
    c.add("Degrees of freedom", res.get("df"), t.df)
    c.add_p("p-value", res.get("p_value"), t.pvalue)
    c.add("Mean difference", res.get("mean_difference"), diff)
    c.add("95% CI lower", _at(res.get("ci_95"), 0), ci.low)
    c.add("95% CI upper", _at(res.get("ci_95"), 1), ci.high)
    c.add("Cohen's d", res.get("cohens_d"), diff / sp)


def _mann_whitney(df, v, res, c: _Checks) -> None:
    _, (a, b) = _groups(df, v, res)
    n1, n2 = len(a), len(b)
    both = np.concatenate([a, b])
    ties = len(np.unique(both)) != len(both)
    # R's template uses the exact distribution when there are no ties, otherwise a continuity-corrected normal.
    method = "asymptotic" if ties else "exact"
    u = stats.mannwhitneyu(a, b, alternative="two-sided", method=method, use_continuity=True)
    c.add("W statistic", res.get("statistic_W"), u.statistic)
    if ties or max(n1, n2) <= _EXACT_LIMIT:
        c.add_p("p-value", res.get("p_value"), u.pvalue)
    c.add("Rank-biserial correlation", res.get("rank_biserial_r"), 2 * u.statistic / (n1 * n2) - 1)


def _anova(df, v, res, c: _Checks) -> None:
    _, groups = _groups(df, v, res)
    k, n = len(groups), sum(len(g) for g in groups)
    f = stats.f_oneway(*groups)
    grand = np.concatenate(groups).mean()
    ssb = sum(len(g) * (g.mean() - grand) ** 2 for g in groups)
    sst = sum(((g - grand) ** 2).sum() for g in groups)
    c.add("F statistic", res.get("F"), f.statistic)
    c.add("Degrees of freedom (between)", res.get("df_between"), k - 1)
    c.add("Degrees of freedom (within)", res.get("df_within"), n - k)
    c.add_p("p-value", res.get("p_value"), f.pvalue)
    c.add("Eta squared", res.get("eta_squared"), ssb / sst)


def _kruskal(df, v, res, c: _Checks) -> None:
    _, groups = _groups(df, v, res)
    n = sum(len(g) for g in groups)
    h = stats.kruskal(*groups)
    c.add("H statistic", res.get("statistic_H"), h.statistic)
    c.add("Degrees of freedom", res.get("df"), len(groups) - 1)
    c.add_p("p-value", res.get("p_value"), h.pvalue)
    c.add("Epsilon squared", res.get("epsilon_squared"), h.statistic * (n + 1) / (n**2 - 1))


# ---------- Paired comparisons ----------

def _pairs(df: pd.DataFrame, v: dict, res: dict) -> tuple[np.ndarray, np.ndarray]:
    sub = df[[v["first"], v["second"]]].dropna()
    a, b = _numeric(sub[v["first"]]), _numeric(sub[v["second"]])
    _same_n(len(a), res.get("n_pairs"), "pairs")
    return a, b


def _paired_t(df, v, res, c: _Checks) -> None:
    a, b = _pairs(df, v, res)
    d = a - b
    t = stats.ttest_rel(a, b)
    ci = t.confidence_interval(0.95)
    c.add("t statistic", res.get("statistic_t"), t.statistic)
    c.add("Degrees of freedom", res.get("df"), t.df)
    c.add_p("p-value", res.get("p_value"), t.pvalue)
    c.add("Mean difference", res.get("mean_difference"), d.mean())
    c.add("95% CI lower", _at(res.get("ci_95"), 0), ci.low)
    c.add("95% CI upper", _at(res.get("ci_95"), 1), ci.high)
    c.add("Cohen's dz", res.get("cohens_dz"), d.mean() / d.std(ddof=1))
    c.add("Number of pairs", res.get("n_pairs"), len(d))


def _wilcoxon(df, v, res, c: _Checks) -> None:
    a, b = _pairs(df, v, res)
    d = a - b
    nz = d[d != 0]
    exact = len(nz) == len(d) and len(np.unique(np.abs(d))) == len(d)
    ranks = stats.rankdata(np.abs(nz))
    w_plus, w_minus = ranks[nz > 0].sum(), ranks[nz < 0].sum()
    c.add("V statistic", res.get("statistic_V"), w_plus)
    if not exact or len(d) <= _EXACT_LIMIT:
        p = stats.wilcoxon(a, b, zero_method="wilcox", method="exact" if exact else "approx", correction=True)
        c.add_p("p-value", res.get("p_value"), p.pvalue)
    c.add("Median difference", res.get("median_difference"), np.median(d))
    c.add("Rank-biserial correlation", res.get("rank_biserial_r"), (w_plus - w_minus) / (w_plus + w_minus))
    c.add("Number of pairs", res.get("n_pairs"), len(d))
    c.add("Zero differences", res.get("n_zero_differences"), int((d == 0).sum()))


# ---------- Association ----------

def _chi_square(df, v, res, c: _Checks) -> None:
    sub = df[[v["var1"], v["var2"]]].dropna()
    tab = pd.crosstab(sub[v["var1"]], sub[v["var2"]]).to_numpy()
    observed = res.get("observed")
    if isinstance(observed, list):
        _same_n(int(tab.sum()), sum(r.get("count", 0) for r in observed), "observations")
    corrected = stats.chi2_contingency(tab, correction=True)
    raw = stats.chi2_contingency(tab, correction=False)
    n = tab.sum()
    c.add("Chi-square statistic", res.get("statistic_chi2"), corrected.statistic)
    c.add("Degrees of freedom", res.get("df"), corrected.dof)
    c.add_p("p-value", res.get("p_value"), corrected.pvalue)
    c.add("Cramér's V", res.get("cramers_v"), math.sqrt(raw.statistic / (n * (min(tab.shape) - 1))))
    c.add("Expected counts below 5 (%)", res.get("pct_expected_counts_below_5"), (corrected.expected_freq < 5).mean() * 100)
    if tab.shape == (2, 2):
        c.add_p("Fisher exact p-value", res.get("fisher_exact_p"), stats.fisher_exact(tab).pvalue)


def _pearson(df, v, res, c: _Checks) -> None:
    sub = df[[v["x"], v["y"]]].dropna()
    x, y = _numeric(sub[v["x"]]), _numeric(sub[v["y"]])
    _same_n(len(x), res.get("n"), "pairs")
    r = stats.pearsonr(x, y)
    ci = r.confidence_interval(0.95)
    c.add("Pearson r", res.get("r"), r.statistic)
    c.add_p("p-value", res.get("p_value"), r.pvalue)
    c.add("95% CI lower", _at(res.get("ci_95"), 0), ci.low)
    c.add("95% CI upper", _at(res.get("ci_95"), 1), ci.high)
    # R's Spearman p-value uses an exact/Edgeworth method that SciPy does not offer, so only rho is compared.
    c.add("Spearman rho", res.get("spearman_rho"), stats.spearmanr(x, y).statistic)
    c.add("Number of pairs", res.get("n"), len(x))


def _shapiro(df, v, res, c: _Checks) -> None:
    x = _numeric(df[[v["variable"]]].dropna()[v["variable"]])
    _same_n(len(x), res.get("n"), "observations")
    s = stats.shapiro(x)
    c.add("W statistic", res.get("W"), s.statistic)
    c.add_p("p-value", res.get("p_value"), s.pvalue)


# ---------- Regression ----------

def _design(df: pd.DataFrame, v: dict, res: dict) -> tuple[pd.DataFrame, pd.Series]:
    """Intercept, numeric predictors and treatment-coded dummies named the way R names its terms."""
    rows = res.get("coefficients")
    if not isinstance(rows, list):
        raise Unavailable("R did not report its coefficients, so the results cannot be compared.")
    r_terms = [str(r.get("term")) for r in rows]
    preds = [v[k] for k in sorted(k for k in v if k.startswith("predictor_"))]
    sub = df[[v["outcome"], *preds]].dropna()
    _same_n(len(sub), res.get("n_used"), "complete rows")
    cols: dict[str, np.ndarray] = {"(Intercept)": np.ones(len(sub))}
    for p in preds:
        s = sub[p]
        if pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s):
            cols[p] = s.to_numpy(dtype=float)
            continue
        labels = s.map(_label)
        # R's term list says which levels are not the reference, which avoids re-deriving R's sort order.
        for level in sorted(labels.unique()):
            if f"{p}{level}" in r_terms:
                cols[f"{p}{level}"] = (labels == level).to_numpy(dtype=float)
    X = pd.DataFrame(cols, index=sub.index)
    if set(X.columns) != set(r_terms):
        raise Unavailable("Python and R built different model terms, so the results cannot be compared.")
    return X, sub[v["outcome"]]


def _linear(df, v, res, c: _Checks) -> None:
    import statsmodels.api as sm
    from statsmodels.stats.diagnostic import het_breuschpagan
    from statsmodels.stats.outliers_influence import variance_inflation_factor

    X, outcome = _design(df, v, res)
    y = _numeric(outcome)
    n = len(y)
    fit = sm.OLS(y, X.to_numpy()).fit()
    se3 = np.asarray(fit.HC3_se)
    p3 = 2 * stats.t.sf(np.abs(fit.params / se3), fit.df_resid)
    ci = fit.conf_int(alpha=0.05)

    c.add("F statistic", res.get("statistic_F"), fit.fvalue)
    c.add("Degrees of freedom (model)", res.get("df_model"), fit.df_model)
    c.add("Degrees of freedom (residual)", res.get("df_residual"), fit.df_resid)
    c.add_p("Overall p-value", res.get("p_value"), fit.f_pvalue)
    c.add("R squared", res.get("r_squared"), fit.rsquared)
    c.add("Adjusted R squared", res.get("adj_r_squared"), fit.rsquared_adj)
    c.add("Residual standard error", res.get("rmse"), math.sqrt(fit.scale))
    c.add("Rows used", res.get("n_used"), n)
    for row in res["coefficients"]:
        term = str(row["term"])
        i = list(X.columns).index(term)
        c.add(f"{term}: estimate", row.get("estimate"), fit.params[i])
        c.add(f"{term}: standard error", row.get("se"), fit.bse[i])
        c.add_p(f"{term}: p-value", row.get("p_value"), fit.pvalues[i])
        c.add(f"{term}: 95% CI lower", row.get("ci_lwr"), ci[i, 0])
        c.add(f"{term}: 95% CI upper", row.get("ci_upr"), ci[i, 1])
        c.add(f"{term}: robust (HC3) standard error", row.get("se_hc3"), se3[i])
        c.add_p(f"{term}: robust (HC3) p-value", row.get("p_hc3"), p3[i])
    if _is_number(res.get("assumption_shapiro_p_residuals")):
        c.add_p("Shapiro-Wilk p-value (residuals)", res["assumption_shapiro_p_residuals"], stats.shapiro(fit.resid).pvalue)
    c.add_p("Breusch-Pagan p-value", res.get("assumption_breusch_pagan_p"), het_breuschpagan(fit.resid, X.to_numpy())[1])
    c.add("High-influence points", res.get("n_high_influence"), int((fit.get_influence().cooks_distance[0] > 4 / n).sum()))
    for row in res.get("vif") or []:
        i = list(X.columns).index(str(row["term"]))
        c.add(f"{row['term']}: variance inflation factor", row.get("vif"), variance_inflation_factor(X.to_numpy(), i))


def _hosmer_lemeshow(p: np.ndarray, y: np.ndarray) -> float | None:
    g = min(10, len(p) // 5)
    if g < 4:
        return None
    edges = np.unique(np.quantile(p, np.linspace(0, 1, g + 1)))
    if len(edges) < 5:
        return None
    codes = pd.cut(p, edges, include_lowest=True).codes
    groups = pd.DataFrame({"g": codes, "y": y, "p": p}).groupby("g")
    obs, exp, size = groups["y"].sum(), groups["p"].sum(), groups["y"].count()
    ok = (exp > 0) & (exp < size)
    stat = (((obs - exp) ** 2) / (exp * (1 - exp / size)))[ok].sum()
    return float(stats.chi2.sf(stat, len(edges) - 1 - 2))


def _logistic(df, v, res, c: _Checks) -> None:
    import statsmodels.api as sm

    X, outcome = _design(df, v, res)
    event = str(res.get("event"))
    y = (outcome.map(_label) == event).to_numpy(dtype=float)
    n1 = int(y.sum())
    n0 = len(y) - n1
    if n1 == 0 or n0 == 0:
        raise Unavailable("Python could not identify the event outcome R used, so the results cannot be compared.")
    fit = sm.Logit(y, X.to_numpy()).fit(disp=0, maxiter=200)
    if not fit.mle_retvals.get("converged", False):
        raise Unavailable("The Python model did not converge, so the results cannot be compared.")
    p = np.asarray(fit.predict(X.to_numpy()))
    ranks = stats.rankdata(p)
    auc = (ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)
    ci = np.exp(fit.conf_int(alpha=0.05))

    c.add("Likelihood-ratio chi-square", res.get("statistic_chi2"), fit.llr)
    c.add("Degrees of freedom", res.get("df"), fit.df_model)
    c.add_p("Overall p-value", res.get("p_value"), fit.llr_pvalue)
    c.add("McFadden R squared", res.get("mcfadden_r2"), fit.prsquared)
    c.add("AIC", res.get("aic"), fit.aic)
    c.add("AUC", res.get("auc"), auc)
    c.add("Sensitivity at 0.5", res.get("sensitivity_at_0.5"), (p[y == 1] >= 0.5).mean())
    c.add("Specificity at 0.5", res.get("specificity_at_0.5"), (p[y == 0] < 0.5).mean())
    c.add("Rows used", res.get("n_used"), len(y))
    c.add("Events", res.get("n_events"), n1)
    c.add("Events per parameter", res.get("events_per_parameter"), min(n1, n0) / (X.shape[1] - 1))
    for row in res["coefficients"]:
        term = str(row["term"])
        i = list(X.columns).index(term)
        c.add(f"{term}: odds ratio", row.get("odds_ratio"), math.exp(fit.params[i]))
        c.add(f"{term}: odds ratio 95% CI lower", row.get("or_lwr"), ci[i, 0])
        c.add(f"{term}: odds ratio 95% CI upper", row.get("or_upr"), ci[i, 1])
        c.add(f"{term}: log odds", row.get("estimate_log_odds"), fit.params[i])
        c.add(f"{term}: standard error", row.get("se"), fit.bse[i])
        c.add_p(f"{term}: p-value", row.get("p_value"), fit.pvalues[i])
    if _is_number(res.get("assumption_hosmer_lemeshow_p")):
        c.add_p("Hosmer-Lemeshow p-value", res["assumption_hosmer_lemeshow_p"], _hosmer_lemeshow(p, y))


# ---------- Curve fits ----------

def _fit_data(df: pd.DataFrame, v: dict) -> tuple[np.ndarray, np.ndarray]:
    sub = df[[v["x"], v["y"]]].dropna()
    return _numeric(sub[v["x"]]), _numeric(sub[v["y"]])


def _compare_fit(res: dict, c: _Checks, names: list[str], popt, pcov, y, resid, n_params: int) -> None:
    df_resid = len(y) - n_params
    se = np.sqrt(np.diag(pcov))
    tq = stats.t.ppf(0.975, df_resid)
    ss_res = float((resid**2).sum())
    c.add("R squared", res.get("r_squared"), 1 - ss_res / float(((y - y.mean()) ** 2).sum()), 1e-5, 1e-6)
    c.add("Number of points", res.get("n"), len(y))
    c.add("Degrees of freedom (residual)", res.get("df_residual"), df_resid)
    for row in res.get("parameters") or []:
        i = names.index(str(row["parameter"]))
        name = row["parameter"]
        c.add(f"{name}: estimate", row.get("estimate"), popt[i], _FIT_REL, 1e-9)
        c.add(f"{name}: standard error", row.get("se"), se[i], _FIT_SE_REL, 1e-9)
        c.add(f"{name}: 95% CI lower", row.get("lwr"), popt[i] - tq * se[i], _FIT_SE_REL, 1e-9)
        c.add(f"{name}: 95% CI upper", row.get("upr"), popt[i] + tq * se[i], _FIT_SE_REL, 1e-9)


def _fit(model, p0, x, y, res):
    from scipy.optimize import curve_fit

    start = [p0]
    # If the data-driven start fails, retry from R's estimates (still verifies the optimum and the statistics).
    r_start = [float(r["estimate"]) for r in res.get("parameters") or [] if _is_number(r.get("estimate"))]
    if len(r_start) == len(p0):
        start.append(r_start)
    last: Exception | None = None
    for guess in start:
        try:
            return curve_fit(model, x, y, p0=guess, maxfev=20_000)
        except (RuntimeError, ValueError) as e:
            last = e
    raise Unavailable("The Python curve fit did not converge, so the results cannot be compared.") from last


def _dose_response(df, v, res, c: _Checks) -> None:
    x, y = _fit_data(df, v)
    keep = x > 0
    x, y = x[keep], y[keep]
    lx = np.log10(x)

    def model(t, a, b, mid, scale):
        return a + (b - a) / (1 + np.exp((mid - t) / scale))

    order = np.argsort(lx)
    k = max(1, len(lx) // 5)
    p0 = [y[order[:k]].mean(), y[order[-k:]].mean(), float(np.median(lx)), (lx.max() - lx.min()) / 4]
    popt, pcov = _fit(model, p0, lx, y, res)
    _compare_fit(res, c, ["left_asymptote", "right_asymptote", "log10_ec50", "scale"], popt, pcov, y, y - model(lx, *popt), 4)
    c.add("EC50", res.get("ec50"), 10 ** popt[2], _FIT_REL, 1e-15)
    c.add("Hill slope", res.get("hill_slope"), 1 / (math.log(10) * popt[3]), _FIT_REL, 1e-9)


def _michaelis_menten(df, v, res, c: _Checks) -> None:
    x, y = _fit_data(df, v)

    def model(t, vmax, km):
        return vmax * t / (km + t)

    positive = x[x > 0]
    p0 = [float(y.max()), float(np.median(positive)) if len(positive) else 1.0]
    popt, pcov = _fit(model, p0, x, y, res)
    _compare_fit(res, c, ["Vmax", "Km"], popt, pcov, y, y - model(x, *popt), 2)


HANDLERS = {
    "independent_t_test": _independent_t,
    "mann_whitney_u": _mann_whitney,
    "one_way_anova": _anova,
    "kruskal_wallis": _kruskal,
    "paired_t_test": _paired_t,
    "wilcoxon_signed_rank": _wilcoxon,
    "chi_square": _chi_square,
    "pearson_correlation": _pearson,
    "shapiro_wilk": _shapiro,
    "linear_regression": _linear,
    "logistic_regression": _logistic,
    "dose_response_4pl": _dose_response,
    "michaelis_menten": _michaelis_menten,
}


def _engine() -> str:
    parts = [f"Python {platform.python_version()}"]
    for package, name in (("scipy", "SciPy"), ("statsmodels", "statsmodels")):
        try:
            parts.append(f"{name} {metadata.version(package)}")
        except metadata.PackageNotFoundError:
            pass
    return ", ".join(parts)


def _summary(status: str, checks: list[dict], note: str | None) -> dict:
    return {"status": status, "engine": _engine(), "note": note, "checks": checks}


def cross_check(test: str, variables: dict[str, str], csv: bytes, results: dict) -> dict:
    """Compare R's results with an independent Python computation. Never raises."""
    handler = HANDLERS.get(test)
    if handler is None:
        return _summary("unavailable", [], "No Python cross-check exists for this analysis yet.")
    try:
        # Read the exact CSV R received; blank and "NA" cells are missing in both engines.
        df = pd.read_csv(io.BytesIO(csv), keep_default_na=False, na_values=["", "NA"], float_precision="round_trip")
        if len(df) > MAX_ROWS:
            raise Unavailable("The dataset is too large to cross-check in Python.")
        checks = _Checks()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            handler(df, variables, results, checks)
    except Unavailable as e:
        return _summary("unavailable", [], str(e))
    except Exception:  # noqa: BLE001 - a failed cross-check must never fail the analysis
        logger.exception("Python cross-check failed for %s", test)
        return _summary("unavailable", [], "Python could not reproduce this analysis, so no comparison is available.")
    if not checks.items:
        return _summary("unavailable", [], "No comparable values were found in the R results.")
    status = "agree" if all(i["agree"] for i in checks.items) else "disagree"
    return _summary(status, checks.items, None)
