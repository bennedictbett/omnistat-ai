"""
Intent classifier inference using ONNX runtime.
Loads the exported DistilBERT model and returns top-k intent families.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import onnxruntime as ort
from transformers import AutoTokenizer

# ── Config ─────────────────────────────────────────────────────
MODEL_DIR   = Path(__file__).parent.parent.parent / "models" / "intent_model"
HF_REPO_ID  = os.getenv("HF_MODEL_REPO", "BenedictBett/omnistat-intent-classifier")
MAX_LENGTH  = 128
TOP_K       = 3


def _ensure_model_downloaded() -> Path:
    """Download the model from HF Hub if not already present locally."""
    if (MODEL_DIR / "model.onnx").exists():
        return MODEL_DIR
    from huggingface_hub import snapshot_download
    downloaded = snapshot_download(
        repo_id=HF_REPO_ID,
        token=os.getenv("HF_TOKEN"),
        local_dir=str(MODEL_DIR),
    )
    return Path(downloaded)

# Alias matcher — catches explicit test names and common misspellings
# before the model runs, guaranteeing high confidence on known terms
ALIASES: dict[str, str] = {
    # T-tests
    "t-test":                    "compare_two_groups",
    "independent t test":        "compare_two_groups",
    "mann whitney":              "compare_two_groups",
    "mann-whitney":              "compare_two_groups",
    "wilcoxon":                  "compare_paired",
    "paired t test":             "compare_paired",
    "paired t-test":             "compare_paired",
    "one sample t test":         "one_sample",
    # ANOVA
    "anova":                     "compare_multi_groups",
    "one way anova":             "compare_multi_groups",
    "one-way anova":             "compare_multi_groups",
    "kruskal wallis":            "compare_multi_groups",
    "kruskal-wallis":            "compare_multi_groups",
    "two way anova":             "compare_multi_groups",
    "repeated measures anova":   "repeated_measures",
    "friedman":                  "repeated_measures",
    # Post-hoc
    "tukey":                     "post_hoc",
    "tukey hsd":                 "post_hoc",
    "bonferroni":                "post_hoc",
    "post hoc":                  "post_hoc",
    "post-hoc":                  "post_hoc",
    # Normality
    "shapiro wilk":              "normality",
    "shapiro-wilk":              "normality",
    "shapiro wilks":             "normality",   # common Whisper error
    "kolmogorov smirnov":        "normality",
    "kolmogorov-smirnov":        "normality",
    "anderson darling":          "normality",
    "jarque bera":               "normality",
    # Correlation
    "pearson":                   "correlation",
    "spearman":                  "correlation",
    "kendall":                   "correlation",
    "correlation matrix":        "correlation",
    # Regression
    "linear regression":         "regression_continuous",
    "multiple regression":       "regression_continuous",
    "logistic regression":       "regression_binary_count",
    "poisson regression":        "regression_binary_count",
    "ridge regression":          "regression_continuous",
    # Survival
    "kaplan meier":              "survival",
    "kaplan-meier":              "survival",
    "kaplan meyer":              "survival",    # common Whisper error
    "cox regression":            "survival",
    "cox proportional hazards":  "survival",
    "log rank":                  "survival",
    "log-rank":                  "survival",
    # Categorical
    "chi square":                "categorical_association",
    "chi-square":                "categorical_association",
    "chi squared":               "categorical_association",
    "fisher exact":              "categorical_association",
    "fisher's exact":            "categorical_association",
    "mcnemar":                   "categorical_association",
    # Diagnostic
    "roc":                       "diagnostic_agreement",
    "auc":                       "diagnostic_agreement",
    "roc auc":                   "diagnostic_agreement",
    "bland altman":              "diagnostic_agreement",
    "bland-altman":              "diagnostic_agreement",
    "cohen kappa":               "diagnostic_agreement",
    "cohen's kappa":             "diagnostic_agreement",
    "icc":                       "diagnostic_agreement",
    # ML
    "random forest":             "ml_supervised",
    "gradient boosting":         "ml_supervised",
    "xgboost":                   "ml_supervised",
    "lightgbm":                  "ml_supervised",
    "shap":                      "ml_supervised",
    "svm":                       "ml_supervised",
    # Unsupervised
    "k-means":                   "unsupervised",
    "kmeans":                    "unsupervised",
    "k means":                   "unsupervised",
    "pca":                       "unsupervised",
    "t-sne":                     "unsupervised",
    "tsne":                      "unsupervised",
    "umap":                      "unsupervised",
    # Time series
    "arima":                     "time_series",
    "granger":                   "time_series",
    # Epi
    "odds ratio":                "epi_measures",
    "relative risk":             "epi_measures",
    "nnt":                       "epi_measures",
    "number needed to treat":    "epi_measures",
    "incidence rate":            "epi_measures",
    # Power
    "sample size":               "sample_size_power",
    "power analysis":            "sample_size_power",
    "power calculation":         "sample_size_power",
    # QC
    "levey jennings":            "quality_control",
    "levey-jennings":            "quality_control",
    "westgard":                  "quality_control",
    "spc chart":                 "quality_control",
    # Advanced
    "meta analysis":             "advanced_modeling",
    "meta-analysis":             "advanced_modeling",
    "propensity score":          "advanced_modeling",
    "structural equation":       "advanced_modeling",
    "mixed effects":             "advanced_modeling",
    "multilevel":                "advanced_modeling",
}


# ── Data classes ────────────────────────────────────────────────
@dataclass
class Prediction:
    intent:     str
    confidence: float
    source:     str       # "alias" | "model"


@dataclass
class PredictResult:
    top1:       Prediction
    top3:       list[Prediction]
    raw_query:  str
    low_confidence: bool  # True when top1 < 0.50 — show options to user


# ── Classifier ──────────────────────────────────────────────────
class IntentClassifier:
    _instance: Optional["IntentClassifier"] = None

    def __init__(self, model_dir: Path = MODEL_DIR) -> None:
        model_dir = _ensure_model_downloaded()
        if not model_dir.exists():
            raise FileNotFoundError(
                f"Model directory not found: {model_dir}\n"
                "Set HF_MODEL_REPO and HF_TOKEN, or unzip the model into models/intent_model/"
            )

        model_path = model_dir / "model.onnx"
        labels_path = model_dir / "labels.json"

        self.tokenizer = AutoTokenizer.from_pretrained(str(model_dir))
        self.labels: list[str] = json.loads(labels_path.read_text())
        self.session = ort.InferenceSession(
            str(model_path),
            providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
        )
        self.input_names = {i.name for i in self.session.get_inputs()}

    @classmethod
    def get(cls) -> "IntentClassifier":
        """Singleton — loads the model once per process."""
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def _alias_match(self, query: str) -> Optional[str]:
        """Return a family name if the query contains a known alias."""
        q = query.lower()
        # Longest match wins to avoid "svm" matching inside "Kolmogorov"
        matches = [
            (alias, family)
            for alias, family in ALIASES.items()
            if alias in q
        ]
        if not matches:
            return None
        best_alias, family = max(matches, key=lambda x: len(x[0]))
        return family

    def predict(self, query: str, top_k: int = TOP_K) -> PredictResult:
        # ── 1. Alias fast path ─────────────────────────────────
        alias_family = self._alias_match(query)
        if alias_family:
            pred = Prediction(
                intent     = alias_family,
                confidence = 1.0,
                source     = "alias",
            )
            return PredictResult(
                top1           = pred,
                top3           = [pred],
                raw_query      = query,
                low_confidence = False,
            )

        # ── 2. Model inference ─────────────────────────────────
        enc  = self.tokenizer(
            query,
            return_tensors = "np",
            truncation     = True,
            padding        = "max_length",
            max_length     = MAX_LENGTH,
        )
        feed = {
            k: enc[k].astype("int64")
            for k in self.input_names
            if k in enc
        }
        logits = self.session.run(None, feed)[0][0]

        # Softmax
        e = np.exp(logits - logits.max())
        probs = e / e.sum()

        top_idx = probs.argsort()[::-1][:top_k]
        top3 = [
            Prediction(
                intent     = self.labels[i],
                confidence = round(float(probs[i]), 4),
                source     = "model",
            )
            for i in top_idx
        ]

        return PredictResult(
            top1           = top3[0],
            top3           = top3,
            raw_query      = query,
            low_confidence = top3[0].confidence < 0.50,
        )


# ── Module-level helper ─────────────────────────────────────────
def classify(query: str) -> PredictResult:
    """Convenience wrapper used by the API routes."""
    return IntentClassifier.get().predict(query)