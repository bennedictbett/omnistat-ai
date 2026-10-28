import datetime as dt
import io
import logging
import os
import tempfile

import numpy as np
import pandas as pd
from scipy import stats
from app.services.data_audit import audit_dataset

logger = logging.getLogger("omnistat.analytics")


def _json_finite(value):
    if isinstance(value, dict):
        return {key: _json_finite(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_finite(item) for item in value]
    if value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, (float, np.floating)) and not np.isfinite(value):
        return None
    return value


def _label_key(value) -> str:
    """Matches how the browser displays the stored value (1.0 -> "1")."""
    if isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, bool):
        return format(float(value), ".15g")
    return str(value)


def _read_statistical_file(content: bytes, name: str) -> tuple[pd.DataFrame, dict, dict]:
    """Reads SPSS/Stata files, keeping stored codes; user-defined and extended missing codes become missing."""
    import pyreadstat

    suffix = os.path.splitext(name)[1]
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, f"upload{suffix}")
        with open(path, "wb") as handle:
            handle.write(content)
        reader = pyreadstat.read_dta if suffix == ".dta" else pyreadstat.read_sav
        try:
            df, meta = reader(path)
        except Exception as e:
            # pyreadstat raises its own exception types for corrupt or unsupported files.
            raise ValueError("Unreadable SPSS or Stata file") from e
    for column in df.columns:
        if pd.api.types.is_datetime64_any_dtype(df[column]):
            df[column] = df[column].map(lambda v: None if pd.isna(v) else v.isoformat())
        elif df[column].dtype == object:
            df[column] = df[column].map(
                lambda v: v.isoformat() if isinstance(v, (dt.date, dt.time)) else v)
    variable_labels = {str(c): str(label) for c, label in meta.column_names_to_labels.items() if label}
    value_labels = {
        str(c): {_label_key(code): str(label) for code, label in labels.items()}
        for c, labels in meta.variable_value_labels.items() if labels
    }
    return df, variable_labels, value_labels


class AnalyticsService:

    # ── File parsing ────────────────────────────────────────────

    async def parse_file(self, file) -> dict:
        """Parse an uploaded CSV, Excel, SPSS (.sav/.zsav) or Stata (.dta) file."""
        content = await file.read()
        name = (file.filename or "").lower()
        variable_labels: dict[str, str] = {}
        value_labels: dict[str, dict[str, str]] = {}
        if name.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content))
        elif name.endswith((".sav", ".zsav", ".dta")):
            df, variable_labels, value_labels = _read_statistical_file(content, name)
        else:
            df = pd.read_excel(io.BytesIO(content))

        if df.empty:
            raise ValueError("The uploaded file has no data rows")
        df.columns = df.columns.map(str)
        audit = audit_dataset(df)
        # Audit the original parsed values; non-finite numeric values cannot be sent as JSON.
        finite_numeric = df.replace([np.inf, -np.inf], np.nan)
        numeric_cols     = df.select_dtypes(include=["int64", "float64"]).columns.tolist()
        categorical_cols = df.select_dtypes(include=["object"]).columns.tolist()

        numeric_stats = {
            col: {
                "mean":   round(float(finite_numeric[col].mean()),   4),
                "median": (round(float(finite_numeric[col].median()), 4)
                           if finite_numeric[col].notna().any() else None),
                "std":    round(float(finite_numeric[col].std()),    4),
                "min":    round(float(finite_numeric[col].min()),    4),
                "max":    round(float(finite_numeric[col].max()),    4),
            }
            for col in numeric_cols
        }

        categorical_stats = {
            col: df[col].value_counts().to_dict()
            for col in categorical_cols
        }

        histogram_data = {
            col: {
                "counts": (pd.cut(finite_numeric[col].dropna(), bins=10)
                           .value_counts(sort=False)
                           .tolist() if finite_numeric[col].notna().any() else []),
                "values": finite_numeric[col].tolist(),
            }
            for col in numeric_cols
        }

        result = {
            "audit":            audit,
            "variable_labels":  variable_labels,
            "value_labels":     value_labels,
            "rows":             len(df),
            "columns":          list(df.columns),
            "dtypes":           df.dtypes.astype(str).to_dict(),
            "missing":          df.isnull().sum().to_dict(),
            "preview":          finite_numeric.head(5).to_dict(orient="records"),
            "full_data":        finite_numeric.to_dict(orient="records"),
            "numeric_cols":     numeric_cols,
            "categorical_cols": categorical_cols,
            "numeric_stats":    numeric_stats,
            "categorical_stats":categorical_stats,
            "histogram_data":   histogram_data,
            "correlation": (
                finite_numeric[numeric_cols].corr().round(3).to_dict()
                if len(numeric_cols) > 1 else {}
            ),
        }
        return _json_finite(result)

    # ── Normality ───────────────────────────────────────────────

    def normality_test(self, data: dict) -> dict:
        """Shapiro-Wilk normality test."""
        values = data.get("values", [])
        stat, p = stats.shapiro(values)
        normal  = bool(p > 0.05)
        return {
            "test":           "shapiro_wilk",
            "statistic":      round(float(stat), 4),
            "p_value":        round(float(p),    4),
            "normal":         normal,
            "interpretation": (
                "Data appears normally distributed (p > 0.05) — "
                "parametric tests are appropriate."
                if normal else
                "Data is not normally distributed (p ≤ 0.05) — "
                "consider non-parametric tests."
            ),
        }

    # ── Descriptive stats ───────────────────────────────────────

    def descriptive_statistics(self, data: dict) -> dict:
        """Descriptive statistics for a numeric column."""
        values = np.array(data.get("values", []), dtype=float)
        column = data.get("column", "variable")
        q1, q3 = float(np.percentile(values, 25)), float(np.percentile(values, 75))
        return {
            "column":   column,
            "count":    int(len(values)),
            "mean":     round(float(np.mean(values)),          4),
            "median":   round(float(np.median(values)),        4),
            "std":      round(float(np.std(values,  ddof=1)),  4),
            "variance": round(float(np.var(values,  ddof=1)),  4),
            "min":      round(float(np.min(values)),           4),
            "max":      round(float(np.max(values)),           4),
            "q1":       round(q1,                              4),
            "q3":       round(q3,                              4),
            "iqr":      round(q3 - q1,                        4),
            "range":    round(float(np.max(values) - np.min(values)), 4),
            "skewness": round(float(stats.skew(values)),      4),
            "kurtosis": round(float(stats.kurtosis(values)),  4),
        }

    # ── Survival ────────────────────────────────────────────────

    def kaplan_meier(self, data: dict) -> dict:
        """Kaplan-Meier survival estimate."""
        from lifelines import KaplanMeierFitter
        label = data.get("label", "Survival")
        kmf   = KaplanMeierFitter()
        kmf.fit(
            durations      = data["durations"],
            event_observed = data["event_observed"],
            label          = label,
        )
        timeline = kmf.survival_function_.reset_index()
        return {
            "timeline":             timeline["timeline"].tolist(),
            "survival_probability": timeline[label].tolist(),
            "median_survival":      float(kmf.median_survival_time_),
        }

    # ── Compare groups ──────────────────────────────────────────

    def compare_groups(self, data: dict) -> dict:
        """
        Compare independent groups.
        Chooses the right test automatically:
          2 groups + parametric  → independent t-test
          2 groups + non-param   → Mann-Whitney U
          3+ groups + parametric → one-way ANOVA
          3+ groups + non-param  → Kruskal-Wallis
        Body: { "values": [...], "groups": [...], "parametric": true }
        """
        values     = np.array(data["values"], dtype=float)
        groups     = np.array(data["groups"])
        parametric = bool(data.get("parametric", True))
        labels     = sorted(set(groups))
        n_groups   = len(labels)
        group_data = [values[groups == g] for g in labels]

        if n_groups < 2:
            return {"error": "At least two groups are required."}

        if n_groups == 2:
            a, b = group_data
            if parametric:
                stat, p = stats.ttest_ind(a, b, equal_var=False)
                test    = "welch_t_test"
            else:
                stat, p = stats.mannwhitneyu(a, b, alternative="two-sided")
                test    = "mann_whitney_u"
        else:
            if parametric:
                stat, p = stats.f_oneway(*group_data)
                test    = "one_way_anova"
            else:
                stat, p = stats.kruskal(*group_data)
                test    = "kruskal_wallis"

        group_stats = {
            str(label): {
                "n":      int(len(g)),
                "mean":   round(float(np.mean(g)),   4),
                "median": round(float(np.median(g)), 4),
                "std":    round(float(np.std(g, ddof=1)), 4),
            }
            for label, g in zip(labels, group_data)
        }

        return {
            "test":            test,
            "statistic":       round(float(stat), 4),
            "p_value":         round(float(p),    4),
            "significant":     bool(p < 0.05),
            "groups":          group_stats,
            "interpretation": (
                f"There is a statistically significant difference between groups (p={p:.4f})."
                if p < 0.05 else
                f"No statistically significant difference between groups (p={p:.4f})."
            ),
        }

    # ── Compare paired ──────────────────────────────────────────

    def compare_paired(self, data: dict) -> dict:
        """
        Compare paired observations.
        Parametric  → paired t-test
        Non-param   → Wilcoxon signed-rank
        Body: { "before": [...], "after": [...], "parametric": true }
        """
        before     = np.array(data["before"], dtype=float)
        after      = np.array(data["after"],  dtype=float)
        parametric = bool(data.get("parametric", True))
        diff       = after - before

        if parametric:
            stat, p = stats.ttest_rel(before, after)
            test    = "paired_t_test"
        else:
            stat, p = stats.wilcoxon(before, after)
            test    = "wilcoxon_signed_rank"

        return {
            "test":            test,
            "statistic":       round(float(stat), 4),
            "p_value":         round(float(p),    4),
            "significant":     bool(p < 0.05),
            "mean_difference": round(float(np.mean(diff)), 4),
            "std_difference":  round(float(np.std(diff, ddof=1)), 4),
            "interpretation": (
                f"The change is statistically significant (p={p:.4f})."
                if p < 0.05 else
                f"The change is not statistically significant (p={p:.4f})."
            ),
        }

    # ── Correlation ─────────────────────────────────────────────

    def correlation(self, data: dict) -> dict:
        """
        Correlation between two variables.
        Body: { "x": [...], "y": [...], "method": "pearson" | "spearman" | "kendall" }
        """
        x      = np.array(data["x"], dtype=float)
        y      = np.array(data["y"], dtype=float)
        method = data.get("method", "pearson").lower()

        if method == "spearman":
            r, p = stats.spearmanr(x, y)
            test = "spearman_correlation"
        elif method == "kendall":
            r, p = stats.kendalltau(x, y)
            test = "kendall_correlation"
        else:
            r, p = stats.pearsonr(x, y)
            test = "pearson_correlation"

        strength = (
            "strong"   if abs(r) >= 0.7 else
            "moderate" if abs(r) >= 0.4 else
            "weak"
        )
        direction = "positive" if r > 0 else "negative"

        return {
            "test":            test,
            "r":               round(float(r), 4),
            "p_value":         round(float(p), 4),
            "significant":     bool(p < 0.05),
            "interpretation": (
                f"{strength.capitalize()} {direction} correlation "
                f"(r={r:.4f}, p={p:.4f})."
                + ("" if p < 0.05 else " Not statistically significant.")
            ),
        }

    # ── Regression ──────────────────────────────────────────────

    def regression(self, data: dict) -> dict:
        """
        Linear or logistic regression.
        Body: {
            "outcome": [...],
            "predictors": { "age": [...], "bmi": [...] },
            "type": "linear" | "logistic"
        }
        """
        from sklearn.linear_model import LinearRegression, LogisticRegression
        from sklearn.metrics import r2_score, roc_auc_score
        from sklearn.preprocessing import StandardScaler

        outcome    = np.array(data["outcome"], dtype=float)
        predictors = data.get("predictors", {})
        reg_type   = data.get("type", "linear").lower()

        if not predictors:
            return {"error": "No predictor variables provided."}

        X      = np.column_stack([np.array(v, dtype=float) for v in predictors.values()])
        scaler = StandardScaler()
        X_sc   = scaler.fit_transform(X)

        if reg_type == "logistic":
            model = LogisticRegression(max_iter=1000)
            model.fit(X_sc, outcome.astype(int))
            proba = model.predict_proba(X_sc)[:, 1]
            auc   = roc_auc_score(outcome.astype(int), proba)
            return {
                "test":         "logistic_regression",
                "auc":          round(float(auc), 4),
                "coefficients": {
                    name: round(float(coef), 4)
                    for name, coef in zip(predictors.keys(), model.coef_[0])
                },
                "intercept":    round(float(model.intercept_[0]), 4),
                "interpretation": f"Logistic regression AUC = {auc:.4f}.",
            }
        else:
            model  = LinearRegression()
            model.fit(X_sc, outcome)
            preds  = model.predict(X_sc)
            r2     = r2_score(outcome, preds)
            # Approximate p-values via t-distribution
            n, k   = len(outcome), X_sc.shape[1]
            resid  = outcome - preds
            mse    = float(np.sum(resid ** 2) / (n - k - 1))
            cov    = mse * np.linalg.pinv(X_sc.T @ X_sc)
            se     = np.sqrt(np.diag(cov))
            t_stat = model.coef_ / se
            p_vals = 2 * (1 - stats.t.cdf(np.abs(t_stat), df=n - k - 1))
            return {
                "test": "multiple_linear_regression",
                "r_squared": round(float(r2), 4),
                "coefficients": {
                    name: {
                        "coef":    round(float(c), 4),
                        "p_value": round(float(p), 4),
                    }
                    for name, c, p in zip(predictors.keys(), model.coef_, p_vals)
                },
                "intercept": round(float(model.intercept_), 4),
                "interpretation": (
                    f"The model explains {r2 * 100:.1f}% of the variance in the outcome (R² = {r2:.4f})."
                ),
            }

    # ── Categorical association ─────────────────────────────────

    def categorical_test(self, data: dict) -> dict:
        """
        Chi-square or Fisher exact test.
        Body: { "table": [[a, b], [c, d]] }
        Automatically uses Fisher exact when any expected cell < 5.
        """
        table    = np.array(data["table"])
        expected = stats.chi2_contingency(table, correction=False)[3]
        use_fisher = bool(np.any(expected < 5)) or table.shape == (2, 2)

        if use_fisher and table.shape == (2, 2):
            stat, p = stats.fisher_exact(table)
            test    = "fisher_exact"
            extra   = {"odds_ratio": round(float(stat), 4)}
        else:
            chi2, p, dof, _ = stats.chi2_contingency(table)
            stat = chi2
            test = "chi_square"
            extra = {"degrees_of_freedom": int(dof)}

        return {
            "test":        test,
            "statistic":   round(float(stat), 4),
            "p_value":     round(float(p),    4),
            "significant": bool(p < 0.05),
            **extra,
            "interpretation": (
                f"There is a statistically significant association between variables (p={p:.4f})."
                if p < 0.05 else
                f"No statistically significant association found (p={p:.4f})."
            ),
        }

    # ── Sample size / power ─────────────────────────────────────

    def power_analysis(self, data: dict) -> dict:
        """
        Sample size and power calculation.
        Body: {
            "test":        "t-test" | "anova" | "chi-square" | "correlation",
            "effect_size": 0.5,
            "alpha":       0.05,
            "power":       0.8,
            "n":           null        ← provide to calculate power instead of n
        }
        """
        from statsmodels.stats.power import (
            TTestIndPower, FTestAnovaPower, GofChisquarePower, NormalIndPower,
        )

        test        = data.get("test", "t-test").lower()
        effect_size = float(data.get("effect_size", 0.5))
        alpha       = float(data.get("alpha",       0.05))
        power       = float(data.get("power",       0.8))
        n           = data.get("n")

        analysers = {
            "t-test":      TTestIndPower(),
            "anova":       FTestAnovaPower(),
            "chi-square":  GofChisquarePower(),
            "correlation": NormalIndPower(),
        }
        analyser = analysers.get(test, TTestIndPower())

        if n is None:
            n_required = analyser.solve_power(
                effect_size = effect_size,
                alpha       = alpha,
                power       = power,
            )
            return {
                "test":            test,
                "effect_size":     effect_size,
                "alpha":           alpha,
                "power":           power,
                "n_per_group":     int(np.ceil(n_required)),
                "total_n":         int(np.ceil(n_required) * 2),
                "interpretation": (
                    f"You need {int(np.ceil(n_required))} participants per group "
                    f"({int(np.ceil(n_required)) * 2} total) to detect an effect size of "
                    f"{effect_size} with {power * 100:.0f}% power at α={alpha}."
                ),
            }
        else:
            achieved = analyser.solve_power(
                effect_size = effect_size,
                nobs1       = float(n),
                alpha       = alpha,
            )
            return {
                "test":        test,
                "n":           int(n),
                "effect_size": effect_size,
                "alpha":       alpha,
                "power":       round(float(achieved), 4),
                "interpretation": (
                    f"With n={n} per group, you have {achieved * 100:.1f}% power "
                    f"to detect an effect size of {effect_size} at α={alpha}."
                ),
            }