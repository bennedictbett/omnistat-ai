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

        return {
            "rows": len(df),
            "columns": list(df.columns),
            "dtypes": df.dtypes.astype(str).to_dict(),
            "missing": df.isnull().sum().to_dict(),
            "preview": df.head(5).to_dict(orient="records")
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