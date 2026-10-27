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

import hashlib
import json
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
    optional_roles: tuple[str, ...] = ()  # roles the caller may leave out


_TWO_GROUP_PREP = r"""
y <- df[[params$outcome]]; g <- df[[params$group]]
ok <- complete.cases(y, g); y <- y[ok]; g <- factor(g[ok])
if (!is.numeric(y)) stop("Outcome variable must be numeric")
if (nlevels(g) != 2) stop(paste("Group variable must have exactly 2 levels, found", nlevels(g)))
lv <- levels(g)
grp <- setNames(lapply(lv, function(l) y[g == l]), lv)
if (any(sapply(grp, length) < 2)) stop("Each group needs at least 2 observations")
"""

_FIT_PREP = r"""
x <- df[[params$x]]; y <- df[[params$y]]
ok <- complete.cases(x, y); x <- x[ok]; y <- y[ok]
if (!is.numeric(x) || !is.numeric(y)) stop("x and y must both be numeric")
if (length(x) < 6) stop("Need at least 6 complete points to fit a curve")
"""

# fit_report(): parameter table with Wald 95% CIs, plus a delta-method 95% band
# for the fitted curve. `f(grid, p)` must be the same model the nls call fits.
_FIT_HELPERS = r"""
fit_report <- function(fit, f, grid) {
  p <- coef(fit); V <- vcov(fit)
  tq <- qt(0.975, df.residual(fit)); se <- sqrt(diag(V))
  pars <- data.frame(parameter = names(p), estimate = unname(p), se = unname(se),
                     lwr = unname(p - tq * se), upr = unname(p + tq * se), row.names = NULL)
  fy <- f(grid, p)
  J <- sapply(seq_along(p), function(i) {
    h <- max(abs(p[i]), 1e-8) * 1e-6
    q <- p; q[i] <- q[i] + h
    (f(grid, q) - fy) / h
  })
  se_fit <- sqrt(rowSums((J %*% V) * J))
  list(pars = pars, fit = fy, lwr = fy - tq * se_fit, upr = fy + tq * se_fit)
}
r_squared <- function(y, fit) 1 - sum(residuals(fit)^2) / sum((y - mean(y))^2)
"""
_PAIRED_PREP = r"""
a <- df[[params$first]]; b <- df[[params$second]]
ok <- complete.cases(a, b); a <- a[ok]; b <- b[ok]
if (!is.numeric(a) || !is.numeric(b)) stop("Both columns must be numeric")
if (length(a) < 3) stop("Need at least 3 complete pairs")
d <- a - b  # first minus second
"""

_PAIRED_ROLES = {
    "first": "numeric column: first measurement (e.g. before)",
    "second": "numeric column: second measurement (e.g. after)",
}
_REG_ROLES = {
    "outcome": "outcome column",
    "predictor_1": "first predictor column",
    **{f"predictor_{i}": f"predictor column {i} (optional)" for i in range(2, 7)},
}
_REG_OPTIONAL = tuple(f"predictor_{i}" for i in range(2, 7))

# Column names never reach the R parser: variables are renamed to y, x1, x2... and mapped back for display.
_REG_PREP = r"""
pnames <- sort(names(params)[grepl("^predictor_", names(params))])
preds <- unname(unlist(params[pnames]))
if (length(preds) < 1) stop("Choose at least one predictor")
if (anyDuplicated(c(params$outcome, preds))) stop("Each variable can be used only once")
d0 <- df[c(params$outcome, preds)]
names(d0) <- c("y", paste0("x", seq_along(preds)))
n_total <- nrow(d0)
d <- d0[complete.cases(d0), , drop = FALSE]
n_used <- nrow(d)
if (n_used < length(preds) + 10) stop("Not enough complete rows for this many predictors (need at least 10 more rows than predictors)")
for (nm in names(d)[-1]) {
  if (is.character(d[[nm]]) || is.logical(d[[nm]])) d[[nm]] <- factor(d[[nm]])
  if (length(unique(d[[nm]])) < 2) stop(paste("Predictor", preds[as.integer(sub("x", "", nm))], "has only one distinct value after removing missing rows"))
}
term_label <- function(fit) {
  asg <- attr(model.matrix(fit), "assign")
  mapply(function(n, k) if (k == 0) n else sub(paste0("^x", k), preds[k], n),
         names(coef(fit)), asg, USE.NAMES = FALSE)
}
collinear_msg <- "Some predictors are perfectly collinear (one is a combination of the others). Remove one and try again."
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
        "dose_response_4pl": Template(
        "Dose-response: 4-parameter logistic (EC50 / IC50)",
        {"x": "concentration column (numeric, > 0)", "y": "response column (numeric)"},
        _FIT_PREP + _FIT_HELPERS + r"""
pos <- x > 0
if (sum(pos) < 6) stop("Need at least 6 points with concentration > 0 (a log scale cannot include 0)")
emit("excluded_zero_concentration_points", sum(!pos))
x <- x[pos]; y <- y[pos]
if (length(unique(x)) < 5) stop("Need at least 5 distinct concentrations")
d <- data.frame(lx = log10(x), y = y)
fit <- tryCatch(
  nls(y ~ SSfpl(lx, left_asymptote, right_asymptote, log10_ec50, scale), data = d),
  error = function(e) stop(paste("Curve fit failed to converge (does the data span the full sigmoid?):", conditionMessage(e)))
)
f <- function(lx, p) p[1] + (p[2] - p[1]) / (1 + exp((p[3] - lx) / p[4]))
gx <- seq(min(d$lx), max(d$lx), length.out = 100)
r <- fit_report(fit, f, gx)
p <- coef(fit); pr <- r$pars
hill_ci <- if (pr$lwr[4] > 0 || pr$upr[4] < 0) sort(1 / (log(10) * c(pr$lwr[4], pr$upr[4]))) else c(NA, NA)
emit("test", "4-parameter logistic fit (nls)")
emit("ec50", unname(10^p[3]))
emit("ec50_ci_95", 10^c(pr$lwr[3], pr$upr[3]))
emit("hill_slope", unname(1 / (log(10) * p[4])))
emit("hill_slope_ci_95", hill_ci)
emit("r_squared", r_squared(y, fit))
emit("n", length(y))
emit("df_residual", df.residual(fit))
emit("parameters", r$pars)
emit("curve", data.frame(x = 10^gx, fit = r$fit, lwr = r$lwr, upr = r$upr))
emit("points", data.frame(x = x, y = y))
emit("residuals", data.frame(x = x, fitted = unname(fitted(fit)), residual = unname(residuals(fit))))
plot(x, y, log = "x", pch = 19, xlab = params$x, ylab = params$y, main = "4-parameter logistic fit")
lines(10^gx, r$fit, lwd = 2); lines(10^gx, r$lwr, lty = 2); lines(10^gx, r$upr, lty = 2)
""",
    ),
    "michaelis_menten": Template(
        "Michaelis-Menten / one-site binding (hyperbola)",
        {"x": "substrate or ligand concentration column (numeric, >= 0)", "y": "rate or binding response column (numeric)"},
        _FIT_PREP + _FIT_HELPERS + r"""
if (any(x < 0)) stop("Concentrations must be zero or positive")
d <- data.frame(x = x, y = y)
fit <- tryCatch(
  nls(y ~ SSmicmen(x, Vmax, Km), data = d),
  error = function(e) stop(paste("Curve fit failed to converge (does the data approach a plateau?):", conditionMessage(e)))
)
f <- function(x, p) p[1] * x / (p[2] + x)
gx <- seq(0, max(x), length.out = 100)
r <- fit_report(fit, f, gx)
emit("test", "Michaelis-Menten fit (nls); for one-site binding read Vmax as Bmax and Km as Kd")
emit("r_squared", r_squared(y, fit))
emit("n", length(y))
emit("df_residual", df.residual(fit))
emit("parameters", r$pars)
emit("curve", data.frame(x = gx, fit = r$fit, lwr = r$lwr, upr = r$upr))
emit("points", data.frame(x = x, y = y))
emit("residuals", data.frame(x = x, fitted = unname(fitted(fit)), residual = unname(residuals(fit))))
plot(x, y, pch = 19, xlab = params$x, ylab = params$y, main = "Michaelis-Menten fit")
lines(gx, r$fit, lwd = 2); lines(gx, r$lwr, lty = 2); lines(gx, r$upr, lty = 2)
""",
    ),
    "paired_t_test": Template(
        "Paired t-test",
        _PAIRED_ROLES,
        _PAIRED_PREP + r"""
if (sd(d) == 0) stop("All pairwise differences are identical, so the test cannot be computed")
tt <- t.test(a, b, paired = TRUE)
emit("test", "Paired t-test")
emit("statistic_t", unname(tt$statistic))
emit("df", unname(tt$parameter))
emit("p_value", tt$p.value)
emit("mean_difference", mean(d))
emit("ci_95", as.numeric(tt$conf.int))
emit("cohens_dz", mean(d) / sd(d))
emit("n_pairs", length(d))
emit("assumption_shapiro_p_differences", if (length(d) <= 5000) shapiro.test(d)$p.value else NA)
emit("summary", data.frame(variable = c(params$first, params$second), n = length(a),
     mean = c(mean(a), mean(b)), sd = c(sd(a), sd(b))))
boxplot(list(a, b), names = c(params$first, params$second), ylab = "Value", main = "Paired measurements")
segments(1, a, 2, b, col = "grey70")
""",
    ),
    "wilcoxon_signed_rank": Template(
        "Wilcoxon signed-rank test (paired)",
        _PAIRED_ROLES,
        _PAIRED_PREP + r"""
nz <- d[d != 0]
if (length(nz) < 3) stop("Need at least 3 non-zero differences")
exact_ok <- all(d != 0) && !anyDuplicated(abs(d))
wt <- suppressWarnings(wilcox.test(a, b, paired = TRUE, conf.int = TRUE, exact = exact_ok))
rk <- rank(abs(nz))
wplus <- sum(rk[nz > 0]); wminus <- sum(rk[nz < 0])
emit("test", "Wilcoxon signed-rank test")
emit("statistic_V", unname(wt$statistic))
emit("p_value", wt$p.value)
emit("median_difference", median(d))
emit("hodges_lehmann_shift", unname(wt$estimate))
emit("shift_ci_95", as.numeric(wt$conf.int))
emit("rank_biserial_r", (wplus - wminus) / (wplus + wminus))
emit("n_pairs", length(d))
emit("n_zero_differences", sum(d == 0))
emit("summary", data.frame(variable = c(params$first, params$second), n = length(a),
     median = c(median(a), median(b)), q1 = c(quantile(a, 0.25), quantile(b, 0.25)),
     q3 = c(quantile(a, 0.75), quantile(b, 0.75)), row.names = NULL))
boxplot(list(a, b), names = c(params$first, params$second), ylab = "Value", main = "Paired measurements")
segments(1, a, 2, b, col = "grey70")
""",
    ),
    "kruskal_wallis": Template(
        "Kruskal-Wallis test (3+ groups)",
        {"outcome": "numeric or ordinal outcome column", "group": "column with 3 or more groups"},
        r"""
y <- df[[params$outcome]]; g <- df[[params$group]]
ok <- complete.cases(y, g); y <- y[ok]; g <- factor(g[ok])
if (!is.numeric(y)) stop("Outcome variable must be numeric (ordinal data coded as numbers is fine)")
if (nlevels(g) < 3) stop(paste("Kruskal-Wallis needs 3+ groups, found", nlevels(g), "(use Mann-Whitney for 2)"))
if (any(table(g) < 2)) stop("Each group needs at least 2 observations")
kw <- kruskal.test(y ~ g)
n <- length(y)
pw <- suppressWarnings(pairwise.wilcox.test(y, g, p.adjust.method = "holm", exact = FALSE))$p.value
idx <- which(!is.na(pw), arr.ind = TRUE)
emit("test", "Kruskal-Wallis rank sum test")
emit("statistic_H", unname(kw$statistic))
emit("df", unname(kw$parameter))
emit("p_value", kw$p.value)
emit("epsilon_squared", unname(kw$statistic) * (n + 1) / (n^2 - 1))
emit("post_hoc_pairwise", data.frame(comparison = paste(rownames(pw)[idx[, "row"]], "vs", colnames(pw)[idx[, "col"]]),
     p_adj = pw[idx], row.names = NULL))
emit("groups", data.frame(group = levels(g), n = as.integer(table(g)),
     median = as.numeric(tapply(y, g, median)), q1 = as.numeric(tapply(y, g, quantile, 0.25)),
     q3 = as.numeric(tapply(y, g, quantile, 0.75))))
boxplot(y ~ g, xlab = params$group, ylab = params$outcome, main = "Outcome by group")
""",
    ),
        "linear_regression": Template(
        "Linear regression (OLS)",
        _REG_ROLES,
        _REG_PREP + r"""
if (!is.numeric(d$y)) stop("Outcome must be numeric for linear regression")
fit <- lm(y ~ ., data = d)
if (anyNA(coef(fit))) stop(collinear_msg)
s <- summary(fit); cf <- coef(s); ci <- confint(fit); lab <- term_label(fit)
X <- model.matrix(fit); h <- pmin(hatvalues(fit), 1 - 1e-8); e <- residuals(fit)
XtXi <- solve(crossprod(X))
V3 <- XtXi %*% crossprod(X * (e / (1 - h))) %*% XtXi   # HC3 robust covariance
se3 <- sqrt(diag(V3))
p3 <- 2 * pt(abs(cf[, 1] / se3), fit$df.residual, lower.tail = FALSE)
e2 <- e^2
aux <- summary(lm(e2 ~ X[, -1, drop = FALSE]))          # Koenker's studentized Breusch-Pagan
bp_p <- pchisq(n_used * aux$r.squared, ncol(X) - 1, lower.tail = FALSE)
fs <- s$fstatistic
emit("test", "Linear regression (OLS); p-value is the overall F-test")
emit("statistic_F", unname(fs[1]))
emit("df_model", unname(fs[2]))
emit("df_residual", unname(fs[3]))
emit("p_value", unname(pf(fs[1], fs[2], fs[3], lower.tail = FALSE)))
emit("r_squared", s$r.squared)
emit("adj_r_squared", s$adj.r.squared)
emit("rmse", s$sigma)
emit("n_used", n_used)
emit("n_dropped_missing", n_total - n_used)
emit("coefficients", data.frame(term = lab, estimate = cf[, 1], se = cf[, 2], t = cf[, 3], p_value = cf[, 4],
     ci_lwr = ci[, 1], ci_upr = ci[, 2], se_hc3 = se3, p_hc3 = p3, row.names = NULL))
emit("assumption_shapiro_p_residuals", if (n_used <= 5000 && sd(e) > 0) shapiro.test(e)$p.value else NA)
emit("assumption_breusch_pagan_p", bp_p)
emit("n_high_influence", sum(cooks.distance(fit) > 4 / n_used))
if (length(preds) >= 2 && all(sapply(d[-1], is.numeric))) {
  vif <- tryCatch(diag(solve(cor(X[, -1, drop = FALSE]))), error = function(err) NULL)
  if (!is.null(vif)) emit("vif", data.frame(term = lab[-1], vif = unname(vif), row.names = NULL))
}
par(mfrow = c(1, 2))
plot(fitted(fit), e, xlab = "Fitted values", ylab = "Residuals", pch = 19, main = "Residuals vs fitted"); abline(h = 0, lty = 2)
qqnorm(e, main = "Normal Q-Q of residuals"); qqline(e)
""",
    _REG_OPTIONAL,
    ),
    "logistic_regression": Template(
        "Logistic regression",
        _REG_ROLES,
        _REG_PREP + r"""
u <- sort(unique(d$y))
if (length(u) != 2) stop(paste("Logistic regression needs an outcome with exactly 2 distinct values, found", length(u)))
y01 <- as.integer(d$y == u[2]); d$y <- y01
n1 <- sum(y01); n0 <- n_used - n1
if (min(n1, n0) < 5) stop("Too few events or non-events (fewer than 5 of one kind)")
w <- character(0)
fit <- withCallingHandlers(glm(y ~ ., data = d, family = binomial()),
  warning = function(x) { w <<- c(w, conditionMessage(x)); invokeRestart("muffleWarning") })
if (!fit$converged) stop("The model did not converge. Try fewer predictors, or check whether a predictor perfectly separates the outcome.")
if (anyNA(coef(fit))) stop(collinear_msg)
s <- summary(fit); cf <- coef(s); ci <- confint.default(fit); lab <- term_label(fit)
p <- fitted(fit)
auc <- (sum(rank(p)[y01 == 1]) - n1 * (n1 + 1) / 2) / (n1 * n0)
lr <- fit$null.deviance - fit$deviance; dfm <- fit$df.null - fit$df.residual
hl_p <- NA
g <- min(10, floor(n_used / 5))
if (g >= 4) {
  br <- unique(quantile(p, probs = seq(0, 1, length.out = g + 1)))
  if (length(br) >= 5) {
    grp <- cut(p, br, include.lowest = TRUE)
    obs <- tapply(y01, grp, sum); ex <- tapply(p, grp, sum); ng <- tapply(y01, grp, length)
    ok <- ex > 0 & ex < ng
    hl_p <- pchisq(sum(((obs - ex)^2 / (ex * (1 - ex / ng)))[ok]), length(obs) - 2, lower.tail = FALSE)
  }
}
pred1 <- p >= 0.5
emit("test", "Logistic regression; odds ratios are per 1-unit increase for numeric predictors and versus the reference level for categorical ones; p-value is the overall likelihood-ratio test")
emit("event", as.character(u[2]))
emit("reference", as.character(u[1]))
emit("statistic_chi2", lr)
emit("df", dfm)
emit("p_value", pchisq(lr, dfm, lower.tail = FALSE))
emit("mcfadden_r2", 1 - fit$deviance / fit$null.deviance)
emit("aic", fit$aic)
emit("auc", auc)
emit("sensitivity_at_0.5", mean(pred1[y01 == 1]))
emit("specificity_at_0.5", mean(!pred1[y01 == 0]))
emit("n_used", n_used)
emit("n_dropped_missing", n_total - n_used)
emit("n_events", n1)
emit("events_per_parameter", min(n1, n0) / (length(coef(fit)) - 1))
emit("coefficients", data.frame(term = lab, odds_ratio = exp(cf[, 1]), or_lwr = exp(ci[, 1]), or_upr = exp(ci[, 2]),
     estimate_log_odds = cf[, 1], se = cf[, 2], p_value = cf[, 4], row.names = NULL))
emit("assumption_hosmer_lemeshow_p", hl_p)
if (length(w)) emit("model_warnings", unique(w))
o <- order(p, decreasing = TRUE); ys <- y01[o]
plot(c(0, cumsum(1 - ys) / n0), c(0, cumsum(ys) / n1), type = "l", lwd = 2,
     xlab = "1 - Specificity", ylab = "Sensitivity", main = sprintf("ROC curve (AUC = %.3f)", auc))
abline(0, 1, lty = 2, col = "grey60")
""",
        _REG_OPTIONAL,
    ),
}


# Appended to every template so R reports its own version; the value is moved out of `results` afterwards.
_VERSION_PROBE = '\nemit("r_version_info", R.version.string)\n'


def _pop_r_version(out: dict) -> str | None:
    results = out.get("results")
    if not isinstance(results, dict):
        return None
    value = results.pop("r_version_info", None)
    if isinstance(value, list):
        value = value[0] if value else None
    return value if isinstance(value, str) else None


def _script_for(spec: Template, variables: dict[str, str], digest: str, r_version: str | None) -> str:
    """A standalone R script for the user. Display only: the server never executes this text."""
    params = ", ".join(f"{role} = {json.dumps(col)}" for role, col in variables.items())
    version_line = r_version or "R version not recorded"
    header = (
        f"# OmniStat AI: {spec.title}\n"
        f"# {version_line}\n"
        f"# Fingerprint (SHA-256) of the data sent to R: {digest}\n"
        "# Save the columns you used as data.csv next to this script. No random numbers are used.\n"
        "\n"
        'df <- read.csv("data.csv", stringsAsFactors = FALSE)\n'
        f"params <- list({params})\n"
        "# Prints each result instead of returning it to the app.\n"
        "emit <- function(name, value) {\n"
        '  cat("\\n==", name, "==\\n")\n'
        "  print(value)\n"
        "}\n"
    )
    return header + spec.code.strip("\n") + "\n"


def supported_tests() -> dict:
    return {
        name: {"title": t.title, "variables": t.roles, "optional": list(t.optional_roles)}
        for name, t in sorted(TEMPLATES.items())
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
    missing = [r for r in spec.roles if r not in variables and r not in spec.optional_roles]
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

    result = await run_r(spec.code + _VERSION_PROBE, data_csv=csv, params=variables)
    out = result.to_dict()
    r_version = _pop_r_version(out)
    digest = hashlib.sha256(csv).hexdigest()
    out.update(
        {
            "test": test,
            "title": spec.title,
            "variables": variables,
            "code": _script_for(spec, variables, digest, r_version),
            "r_version": r_version,
            "data_sha256": digest,
        }
    )
    return out