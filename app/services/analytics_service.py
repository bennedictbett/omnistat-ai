import pandas as pd
from scipy import stats
import io

class AnalyticsService:
    async def parse_file(self, file) -> dict:
        """Parse uploaded Excel or CSV clinical file"""
        content = await file.read()
        if file.filename.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(content))
        else:
            df = pd.read_excel(io.BytesIO(content))

        # Get numeric and categorical columns
        numeric_cols = df.select_dtypes(include=['int64', 'float64']).columns.tolist()
        categorical_cols = df.select_dtypes(include=['object']).columns.tolist()

        # Descriptive stats for all numeric columns
        numeric_stats = {}
        for col in numeric_cols:
            numeric_stats[col] = {
                "mean": round(float(df[col].mean()), 4),
                "median": round(float(df[col].median()), 4),
                "std": round(float(df[col].std()), 4),
                "min": round(float(df[col].min()), 4),
                "max": round(float(df[col].max()), 4),
            }

        # Value counts for categorical columns
        categorical_stats = {}
        for col in categorical_cols:
            categorical_stats[col] = df[col].value_counts().to_dict()

        # Histogram data for numeric columns
        histogram_data = {}
        for col in numeric_cols:
            counts, bin_edges = pd.cut(df[col], bins=10, retbins=True)
            histogram_data[col] = {
                "counts": counts.value_counts(sort=False).tolist(),
                "values": df[col].tolist()
            }

        return {
            "rows": len(df),
            "columns": list(df.columns),
            "dtypes": df.dtypes.astype(str).to_dict(),
            "missing": df.isnull().sum().to_dict(),
            "preview": df.head(5).to_dict(orient="records"),
            "full_data": df.to_dict(orient="records"),
            "numeric_cols": numeric_cols,
            "categorical_cols": categorical_cols,
            "numeric_stats": numeric_stats,
            "categorical_stats": categorical_stats,
            "histogram_data": histogram_data,
            "correlation": df[numeric_cols].corr().round(3).to_dict() if len(numeric_cols) > 1 else {}
        }

    def normality_test(self, data: dict) -> dict:
        """Run Shapiro-Wilk normality test"""
        values = data.get("values", [])
        stat, p_value = stats.shapiro(values)
        
        return {
            "test": "shapiro_wilk",
            "statistic": round(stat, 4),
            "p_value": round(p_value, 4),
            "normal": bool(p_value > 0.05),
            "interpretation": (
                "Data appears normally distributed (p > 0.05) - parametric tests are appropriate"
                if p_value > 0.05
                else "Data is not normally distributed (p <= 0.05) - consider non-parametric tests"
            )
        }

    def kaplan_meier(self, data: dict) -> dict:
        """
        Compute Kaplan-Meier survival estimates
        Expects: { durations: [...], event_observed: [...], label: "..." }
        """
        from lifelines import KaplanMeierFitter
        
        kmf = KaplanMeierFitter()
        kmf.fit(
            durations=data["durations"],
            event_observed=data["event_observed"],
            label=data.get("label", "Survival")
        )
        
        timeline = kmf.survival_function_.reset_index()
        
        return {
            "timeline": timeline["timeline"].tolist(),
            "survival_probability": timeline[data.get("label", "Survival")].tolist(),
            "median_survival": kmf.median_survival_time_
        }

    def descriptive_statistics(self, data: dict) -> dict:
        """Compute descriptive statistics for a numeric column"""
        import numpy as np
        values = data.get("values", [])
        column = data.get("column", "variable")
        arr = np.array(values)

        q1 = float(np.percentile(arr, 25))
        q3 = float(np.percentile(arr, 75))

        return {
            "column": column,
            "count": int(len(arr)),
            "mean": round(float(np.mean(arr)), 4),
            "median": round(float(np.median(arr)), 4),
            "std": round(float(np.std(arr, ddof=1)), 4),
            "variance": round(float(np.var(arr, ddof=1)), 4),
            "min": round(float(np.min(arr)), 4),
            "max": round(float(np.max(arr)), 4),
            "q1": round(q1, 4),
            "q3": round(q3, 4),
            "iqr": round(q3 - q1, 4),
            "range": round(float(np.max(arr) - np.min(arr)), 4),
            "skewness": round(float(stats.skew(arr)), 4),
            "kurtosis": round(float(stats.kurtosis(arr)), 4),
        }