"""Curated R analyses keyed by the intent `test` names the Jarvis agent returns.

Why templates instead of LLM-written R:
- no arbitrary code execution from model output or user input
- each analysis is reviewed once, so the statistics are trustworthy
- column names travel as JSON `params`, never spliced into code

To add a test: add an entry to TEMPLATES (roles + R code). The R code sees
`df` (only the columns requested) and `params` (role -> column name), and
returns results with emit("name", value). Plots are captured automatically.
"""
from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from app.services.r_runner import run_r

MAX_ROWS = 200_000


class TemplateError(ValueError):
    """Bad request (unknown test, missing/unknown column, too much data)."""


@dataclass(frozen=True)
class Template:
    title: str
    roles: dict[str, str]  # role -> human description
    code: str


_TWO_GROUP_PREP = r"""
y <- df[[params$outcome]]; g <- df[[params$group]]
ok <- complete.cases(y, g); y <- y[ok]; g <- factor(g[ok])
if (!is.numeric(y)) stop("Outcome variable must be numeric")
if (nlevels(g) != 2) stop(paste("Group variable must have exactly 2 levels, found", nlevels(g)))
lv <- levels(g)
grp <- setNames(lapply(lv, function(l) y[g == l]), lv)
if (any(sapply(grp, length) < 2)) stop("Each group needs at least 2 observations")
"""

TEMPLATES: dict[str, Template] = {
    "independent_t_test": Template(
        "Independent samples t-test (Welch)",
        {"outcome": "numeric outcome column", "group": "column with exactly 2 groups"},
        _TWO_GROUP_PREP + r"""
tt <- t.test(y ~ g)  # Welch: does not assume equal variances
n <- sapply(grp, length); m <- sapply(grp, mean); s <- sapply(grp, sd)
sp <- sqrt(((n[1] - 1) * s[1]^2 + (n[2] - 1) * s[2]^2) / (n[1] + n[2] - 2))
sw <- sapply(grp, function(v) if (length(v) >= 3 && length(v) <= 5000 && sd(v) > 0) shapiro.test(v)$p.value else NA)
emit("test", "Welch two-sample t-test")
emit("statistic_t", unname(tt$statistic))
emit("df", unname(tt$parameter))
emit("p_value", tt$p.value)
emit("mean_difference", unname(m[1] - m[2]))
emit("ci_95", as.numeric(tt$conf.int))
emit("cohens_d", unname((m[1] - m[2]) / sp))
emit("groups", data.frame(group = lv, n = as.integer(n), mean = unname(m), sd = unname(s)))
emit("assumption_shapiro_p_by_group", as.list(sw))
boxplot(y ~ g, xlab = params$group, ylab = params$outcome, main = "Outcome by group")
""",
    ),
    "mann_whitney_u": Template(
        "Mann-Whitney U (Wilcoxon rank-sum)",
        {"outcome": "numeric or ordinal outcome column", "group": "column with exactly 2 groups"},
        _TWO_GROUP_PREP + r"""
wt <- wilcox.test(y ~ g, conf.int = TRUE, exact = !anyDuplicated(y))
n <- sapply(grp, length)
emit("test", "Mann-Whitney U")
emit("statistic_W", unname(wt$statistic))
emit("p_value", wt$p.value)
emit("rank_biserial_r", unname(2 * wt$statistic / (n[1] * n[2]) - 1))
emit("location_shift_ci_95", as.numeric(wt$conf.int))
emit("groups", data.frame(group = lv, n = as.integer(n),
     median = sapply(grp, median), q1 = sapply(grp, quantile, 0.25), q3 = sapply(grp, quantile, 0.75),
     row.names = NULL))
boxplot(y ~ g, xlab = params$group, ylab = params$outcome, main = "Outcome by group")
""",
    ),
    "one_way_anova": Template(
        "One-way ANOVA with Tukey HSD",
        {"outcome": "numeric outcome column", "group": "column with 3+ groups"},
        r"""
y <- df[[params$outcome]]; g <- df[[params$group]]
ok <- complete.cases(y, g); y <- y[ok]; g <- factor(g[ok])
if (!is.numeric(y)) stop("Outcome variable must be numeric")
if (nlevels(g) < 3) stop(paste("One-way ANOVA needs 3+ groups, found", nlevels(g), "(use a t-test for 2)"))
if (length(y) <= nlevels(g)) stop("Not enough observations for the number of groups")
fit <- aov(y ~ g)
a <- summary(fit)[[1]]
tuk <- TukeyHSD(fit)$g
emit("test", "One-way ANOVA")
emit("F", a[1, "F value"])
emit("df_between", a[1, "Df"]); emit("df_within", a[2, "Df"])
emit("p_value", a[1, "Pr(>F)"])
emit("eta_squared", a[1, "Sum Sq"] / sum(a[, "Sum Sq"]))
emit("post_hoc_tukey", data.frame(comparison = rownames(tuk), diff = tuk[, "diff"],
     lwr = tuk[, "lwr"], upr = tuk[, "upr"], p_adj = tuk[, "p adj"], row.names = NULL))
emit("assumption_fligner_p", fligner.test(y ~ g)$p.value)
emit("assumption_shapiro_p_residuals", if (length(y) >= 3 && length(y) <= 5000) shapiro.test(residuals(fit))$p.value else NA)
emit("groups", data.frame(group = levels(g), n = as.integer(table(g)),
     mean = as.numeric(tapply(y, g, mean)), sd = as.numeric(tapply(y, g, sd))))
boxplot(y ~ g, xlab = params$group, ylab = params$outcome, main = "Outcome by group")
""",
    ),
    "chi_square": Template(
        "Chi-square test of independence",
        {"var1": "first categorical column", "var2": "second categorical column"},
        r"""
a <- df[[params$var1]]; b <- df[[params$var2]]
ok <- complete.cases(a, b)
tab <- table(a[ok], b[ok])
if (nrow(tab) < 2 || ncol(tab) < 2) stop("Both variables need at least 2 categories")
ct <- suppressWarnings(chisq.test(tab))
raw <- suppressWarnings(chisq.test(tab, correct = FALSE))
nn <- sum(tab)
emit("test", if (all(dim(tab) == 2)) "Chi-square (Yates continuity correction, 2x2)" else "Chi-square")
emit("statistic_chi2", unname(ct$statistic))
emit("df", unname(ct$parameter))
emit("p_value", ct$p.value)
emit("cramers_v", unname(sqrt(raw$statistic / (nn * (min(dim(tab)) - 1)))))
emit("pct_expected_counts_below_5", mean(ct$expected < 5) * 100)
if (all(dim(tab) == 2)) emit("fisher_exact_p", fisher.test(tab)$p.value)
emit("observed", as.data.frame(tab, responseName = "count", stringsAsFactors = FALSE))
barplot(t(tab), beside = TRUE, legend.text = TRUE, xlab = params$var1, main = paste(params$var1, "by", params$var2))
""",
    ),
    "pearson_correlation": Template(
        "Pearson correlation (with Spearman for comparison)",
        {"x": "first numeric column", "y": "second numeric column"},
        r"""
x <- df[[params$x]]; y <- df[[params$y]]
ok <- complete.cases(x, y); x <- x[ok]; y <- y[ok]
if (!is.numeric(x) || !is.numeric(y)) stop("Both variables must be numeric")
if (length(x) < 4) stop("Need at least 4 complete pairs")
ct <- cor.test(x, y)
sp <- suppressWarnings(cor.test(x, y, method = "spearman"))
emit("test", "Pearson correlation")
emit("r", unname(ct$estimate))
emit("p_value", ct$p.value)
emit("ci_95", as.numeric(ct$conf.int))
emit("n", length(x))
emit("spearman_rho", unname(sp$estimate))
emit("spearman_p_value", sp$p.value)
plot(x, y, xlab = params$x, ylab = params$y, pch = 19, main = "Scatter with linear fit")
abline(lm(y ~ x), lwd = 2)
""",
    ),
    "shapiro_wilk": Template(
        "Shapiro-Wilk normality test",
        {"variable": "numeric column"},
        r"""
v <- df[[params$variable]]; v <- v[!is.na(v)]
if (!is.numeric(v)) stop("Variable must be numeric")
if (length(v) < 3 || length(v) > 5000) stop("Shapiro-Wilk needs between 3 and 5000 observations")
if (sd(v) == 0) stop("Variable is constant")
sw <- shapiro.test(v)
emit("test", "Shapiro-Wilk")
emit("W", unname(sw$statistic))
emit("p_value", sw$p.value)
emit("normal_at_0.05", sw$p.value > 0.05)
emit("n", length(v))
qqnorm(v, main = paste("Normal Q-Q:", params$variable)); qqline(v)
""",
    ),
}


def supported_tests() -> dict:
    return {
        name: {"title": t.title, "variables": t.roles} for name, t in sorted(TEMPLATES.items())
    }


async def run_named_test(test: str, variables: dict[str, str], df: pd.DataFrame) -> dict:
    spec = TEMPLATES.get(test)
    if spec is None:
        raise TemplateError(
            f"No R template for '{test}' yet. Supported: {', '.join(sorted(TEMPLATES))}"
        )

    unknown_roles = set(variables) - set(spec.roles)
    if unknown_roles:
        raise TemplateError(f"Unknown variable roles {sorted(unknown_roles)}; expected {list(spec.roles)}")
    missing = [r for r in spec.roles if r not in variables]
    if missing:
        raise TemplateError(f"Missing variable roles: {missing}")

    bad_cols = [c for c in variables.values() if c not in df.columns]
    if bad_cols:
        raise TemplateError(f"Columns not found in data: {bad_cols}")
    if len(df) > MAX_ROWS:
        raise TemplateError(f"Too many rows ({len(df)}); limit is {MAX_ROWS}")

    # Send R only the columns it needs.
    cols = list(dict.fromkeys(variables.values()))
    csv = df[cols].to_csv(index=False).encode("utf-8")

    result = await run_r(spec.code, data_csv=csv, params=variables)
    out = result.to_dict()
    out.update({"test": test, "title": spec.title, "variables": variables})
    return out