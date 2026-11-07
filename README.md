# OmniStat AI

> Upload clinical data. Get instant statistical insights. No coding required.

OmniStat AI is an AI-powered statistical analysis platform built for researchers, clinicians, and lab scientists who need publication-ready results without writing a single line of code.

---

## The Problem

Statistical software like SPSS and SAS costs thousands of dollars annually and requires technical training most researchers don't have. General AI tools only *generate* code — they don't execute it, meaning a developer is still required to get actual results.

OmniStat closes both gaps: it understands what you want, runs the analysis, and delivers real results instantly.

---

## What's Built

### Jarvis AI Agent and Test Wizard
Type a research question in plain English (or speak it). Jarvis identifies the
statistical test and suggests columns; you confirm the columns before anything
runs. The **Test Wizard** reaches the same tests by answering a few questions.

```
"Compare blood pressure between treatment and control"
→ test: independent_t_test (Welch)
→ choose columns → review plan and assumption checks → run in R
```

### Data
- Upload **CSV, Excel, SPSS (`.sav`/`.zsav`) or Stata (`.dta`)**, keeping
  variable and value labels.
- Automatic **data-quality audit**: missing values, duplicates, empty or
  constant columns, numeric-looking text and infinities.
- **Data dashboard**: overview, distributions, categorical charts, correlations.
- **Dataset projects** saved in the browser.
- **Maps** (Maps tab, works offline, no background tiles): upload GeoJSON
  boundaries (WGS84 polygons) and colour areas by a mean, sum, median or row
  count of your data (choropleth with quantile or equal-interval classes), or
  show a heatmap of latitude/longitude points with an optional weight column.
  Boundaries are kept in the tab only and are not saved with the dataset.

### Statistical Analyses (R)
| Area | Procedures |
|------|------------|
| Group comparisons | Welch t-test, paired t-test, one-way ANOVA with Tukey, Mann-Whitney U, Wilcoxon signed-rank, Kruskal-Wallis |
| Association | Pearson (with Spearman) correlation, chi-square with Fisher's exact test |
| Models | Linear and logistic regression with diagnostics |
| Other | Shapiro-Wilk normality, dose-response (4PL) and Michaelis-Menten curve fitting |
| Browser tools | Descriptive statistics, Kaplan-Meier survival curves, power and math tools |

### Trust and Transparency
- **Reviewed analysis plan** before execution, re-verified by the server.
- **Assumption checks** with suggested alternatives for small samples.
- **R code** shown for every result, with a SHA-256 fingerprint of the data.
- **Plain-English summaries** in which every number links to its source.
- **Python cross-check**: key numbers are recomputed independently with SciPy and
  statsmodels and compared with R; disagreements are flagged.

### Reports and Reproducibility
- **Print / Save as PDF** and **Word (.docx) with APA 7 formatting**.
- **Reproducibility ZIP** with data, R script, results, plan, charts and manifest.

### Accounts and Audit (optional, Supabase)
- Email sign-in and **cloud analysis history** visible only to its owner.
- **Tamper-evident audit log** of uploads, runs, saves and exports, with
  integrity verification and JSON export.

See the sections under [Getting Started](#getting-started) for details,
limitations and setup of each feature.

---

## Architecture

```
User (text, voice, point-and-click, file upload)
        ↓
Next.js 14 frontend (React, Tailwind, Recharts, Plotly)
  · server-side proxies hold the API key
  · reports, explanations and projects are built in the browser
        ↓                                   ↓ (optional)
FastAPI backend (Python)                 Supabase
  · Jarvis agent (Groq + intent model)     · Auth (email link or code)
  · upload, audit, plans, checks           · analysis history (RLS)
  · sandboxed R worker (curated templates) · hash-chained audit log
  · math and voice (Whisper) workers
```

**Stack:**
- **Backend:** FastAPI, Python 3.11 (pandas, numpy, scipy, lifelines, pyreadstat)
- **Statistics engine:** R (curated templates; `jsonlite`) in a resource-limited worker
- **AI:** Groq for intent extraction and voice transcription; a local intent classifier
- **Frontend:** Next.js 14, Tailwind CSS, Recharts, Plotly, `docx`
- **Accounts and audit:** Supabase Auth and PostgreSQL with row-level security
- **Testing:** pytest, Vitest and GitHub Actions

---

## Getting Started

### Prerequisites
- Python 3.11 (recommended for the pinned backend dependencies)
- Node.js 18+
- A free [Groq API key](https://console.groq.com)
- R with the `jsonlite` package for R analyses
- FFmpeg for the voice test suite

### Backend Setup

```bash
# Clone the repo
git clone https://github.com/bennedictbett/omnistat-ai.git
cd omnistat-ai

# Create virtual environment
python -m venv venv
venv\Scripts\activate  # Windows
# source venv/bin/activate  # Mac/Linux

# Install dependencies
pip install -r requirements.txt

# Set up environment
cp .env.example .env
# Add your GROQ_API_KEY to .env

# Start the API
uvicorn app.main:app --reload
```

API docs available at: `http://localhost:8000/docs`

### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`

### Backend Selection and Uploaded-Data Analyses

Browser requests use `NEXT_PUBLIC_API_URL`; the default remains the hosted
OmniStat API. To work against your local backend, create `frontend/.env.local`
(ignored by Git) with:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8000
BACKEND_URL=http://localhost:8000
OMNISTAT_API_KEY=replace-with-your-local-key
```

Set `OMNISTAT_API_KEYS` to the same key in the backend's `.env`. Never prefix
the secret key with `NEXT_PUBLIC_`. R, math and voice use Next.js server-side
proxies, which add this key; `BACKEND_URL` overrides their destination and
otherwise defaults to `NEXT_PUBLIC_API_URL`. Keep both URLs pointed at the same
backend. Restart Next.js after changing environment variables; production public
URLs are set at build time.

Uploads are checked before being saved. In Jarvis, a supported recommendation
opens a column picker; the user confirms columns and runs the curated R analysis
on the full uploaded dataset. Unsupported procedures, incomplete AI plans,
ambiguous questions and unavailable catalogs show a message instead of running
sample data or silently substituting another statistical test. The Test Wizard
can select supported analyses without the AI model.

Descriptive statistics use all uploaded rows, not just the five-row preview,
excluding non-finite/non-numeric values in the selected column. The separate
Normality and Survival tabs remain manual-entry tools; they do not automatically
select uploaded columns.

### SPSS and Stata Import

Upload SPSS (`.sav`, compressed `.zsav`) or Stata (`.dta`) files like CSV or
Excel files. Files are read with `pyreadstat`; the upload is written to a private
temporary folder that is deleted immediately after parsing.

- **Stored codes are kept.** Analyses use the values stored in the file (for
  example `1` and `2`), so results and the R script match the data exactly.
- **Labels are returned alongside.** `variable_labels` maps columns to their
  descriptions and `value_labels` maps each stored value to its label, for
  example `{"sex": {"1": "Male", "2": "Female"}}`. Keys match how the value is
  displayed (`1.0` becomes `"1"`). Labels appear in the upload summary and column
  pickers, and beside group codes in analysis plan reviews. CSV and Excel uploads
  return empty label objects.
- **Missing codes become missing.** SPSS user-defined missing values (for
  example `99 = Refused`) and Stata extended missing values (`.a`–`.z`) are
  treated as missing, as SPSS and Stata do in analyses. The audit counts them as
  missing.
- **Dates become ISO text** (for example `2026-01-01`), matching CSV uploads.

Corrupt or unsupported files return HTTP 422. Results tables and charts still
show stored codes rather than value labels.

### Upload Data-Quality Audit

The upload API returns an additive `audit` object (version `1.0`), displayed above
the Data Dashboard tabs. It reports:

- Missing count and percentage per column, using pandas CSV/Excel missing-value
  parsing, or SPSS/Stata missing codes. Whitespace-only strings are counted separately as blank text.
- Exact duplicate rows beyond the first occurrence across all parsed columns.
  These are not necessarily duplicate patients and are never removed automatically.
- Entirely empty columns (missing or blank text) and columns constant among
  populated cells. Empty columns are not also marked constant.
- Numeric-looking text columns: at least 80% of populated cells must be text
  parsable as finite numbers. This is a review flag, not an instruction to convert
  identifiers or codes, and it does not change inferred column types.
- Infinite numeric values, counted before serialization. JSON cannot represent
  NaN or infinity: undefined statistics and missing/infinite numeric cells become
  `null`; summaries, histograms and correlations use finite numeric values.

The audit itself does not mutate the parsed dataset, delete duplicate rows or
convert text columns. CSV/Excel import still applies pandas' normal type inference
and missing-value conventions. It does not certify statistical assumptions.
Empty files or header-only datasets return HTTP 422.

Previously saved datasets and older backends without an audit remain usable, but
the dashboard explicitly says the audit is unavailable and requests a fresh
upload. Invalid audit versions or structures are reported rather than shown as
clean. No raw values are logged by these checks.

### Large Datasets (server-side store, API)

The classic upload (`POST /api/analytics/upload`) returns every row to the browser
and every analysis sends them all back, which cannot work for large files (a
1,000,000-row, 9-column file is about 150 MB of JSON, browsers cap `localStorage` at
about 5 MB, and Vercel limits proxied request bodies to 4.5 MB). The dataset store
parses a file **once**, keeps it on the API server as a typed Parquet file, and
lets analyses refer to it by id:

```powershell
# 1. Upload once. Returns a dataset_id, summaries, audit and a 100-row preview (about 14 KB, not the rows).
curl.exe -s -F "file=@big.csv" http://127.0.0.1:8000/api/datasets
# 2. Review, check and run by id instead of sending rows. Only the columns an analysis needs are read.
curl.exe -s -H "X-API-Key: $env:OMNISTAT_API_KEY" -H "Content-Type: application/json" `
  -d '{"test":"independent_t_test","variables":{"outcome":"bp","group":"arm"},"dataset_id":"<id>"}' `
  http://127.0.0.1:8000/api/r/run
# 3. Page through rows, or delete the dataset now.
curl.exe -s "http://127.0.0.1:8000/api/datasets/<id>/rows?offset=0&limit=100"
curl.exe -s -X DELETE http://127.0.0.1:8000/api/datasets/<id>
```

`/api/r/plan`, `/checks`, `/run` and `/bundle` accept either `data` (rows, as before)
or `dataset_id`, never both. Results are the same as with inline rows.

**What is stored, and for how long.** The full dataset is kept on the API server's
disk (`OMNISTAT_DATA_DIR`, default a temporary folder). It is deleted after 24 hours
without use (`DATASET_TTL_HOURS`; every read refreshes the clock), when you call
`DELETE`, or by a sweep that runs every 30 minutes. Like the classic upload, the
endpoint is public because the browser cannot hold an API key, so it is rate-limited
per connecting address and bounded in size, rows and total storage; the 128-bit
random id is what grants access to a dataset (it is not tied to a user), so treat ids
like passwords. If storage is full, new uploads are refused (HTTP 507); datasets in
use are never evicted. Do not enable this for data that must not be held on a shared
server.

| Setting | Default | Meaning |
|---------|---------|---------|
| `OMNISTAT_DATA_DIR` | temp folder | Where datasets are stored; use a persistent, private folder in production |
| `DATASET_MAX_UPLOAD_MB` / `DATASET_MAX_EXCEL_MB` | 200 / 50 | File size limits (Excel is parsed in pure Python and needs far more memory per row) |
| `DATASET_MAX_ROWS` / `DATASET_MAX_COLUMNS` | 1,000,000 / 1,000 | Rejected above this (HTTP 413) |
| `DATASET_TTL_HOURS` | 24 | Hours of inactivity before deletion |
| `DATASET_MAX_TOTAL_MB` / `DATASET_MAX_PER_CLIENT_MB` | 5000 / 1000 | Store-wide and per-address storage caps |
| `DATASET_MAX_CONCURRENT_UPLOADS` | 1 | Parsing a large file is memory-hungry, so uploads queue (HTTP 503 if busy) |
| `DATASET_UPLOAD_RATE_PER_MIN` | 6 | Per-address upload limit (`DATASET_READ_RATE_PER_MIN`, 120, for reads) |
| `R_MAX_ROWS` | 1,000,000 | R analyses refuse more rows than this |
| `R_TIMEOUT_SECONDS`, `R_TIMEOUT_PER_MB`, `R_TIMEOUT_MAX_SECONDS` | 30, 3, 300 | R wall-clock limit: 30 s plus 3 s per MB of CSV beyond the first, up to 300 s; the CPU limit is raised to match. Datasets under 1 MB keep the original limits |

Put a request-size cap on your reverse proxy too (the upload guard only sees
declared lengths; for Caddy, `request_body { max_size 250MB }` on `/api/datasets`).

**Measured at 1,000,000 rows** (9 columns, 37 MB CSV, on an 8 GB Windows laptop with
under 1 GB of free memory and R in Docker Desktop, so a slow case): upload and
audit 17-18 s; the API process peaked at **484 MB**; a page of rows 0.1-0.4 s;
Welch t-test, linear and logistic regression all completed (about 15-25 s, 40-50 s
and 30-75 s end to end, including 10-15 s of container start-up here). The t-test
statistic matched SciPy exactly (-137.336492). Linux servers start containers in
about a second, so expect it to be quicker there.

Changes this needed: the data audit is vectorised (3-4x faster, identical results,
checked against the original implementation in `tests/test_data_audit_equivalence.py`),
diagnostic plots draw at most 20,000 evenly spaced points (drawing 1,000,000 points
took 61 of the 70 seconds for a linear regression), and a logistic-regression
integer overflow was fixed: `n1 * n0` exceeded 2^31 above about 92,000 balanced rows,
which turned the AUC into `NA`. Servers without `pyarrow` (such as the current Render
build, which does not install `requirements.txt`) still start; the dataset endpoints
answer HTTP 503 there.

**Not done yet:** the web app still uses the classic upload, so large files do not
work in the browser until the frontend is switched to `dataset_id` (charts, maps and
summaries would use server-side aggregates or labelled samples, and Dataset Projects
would decline files above 100,000 rows). Vercel's 60-second function limit also
caps how long a proxied R analysis can run. DuckDB was not needed at this scale:
Parquet plus pandas used under 500 MB for 1,000,000 rows.

### Dataset Projects (This Browser)

Use **Projects** in the sidebar to keep several uploaded datasets on this device:

1. Upload a CSV, Excel, SPSS or Stata file, then open **Projects**.
2. Enter a project name (1–100 characters) and select **Save project**.
3. Select **Open** on a saved project to make it the active dataset for the
   summary, Jarvis, Test Wizard and other analyses. Opening a project does not
   upload it or rerun anything.
4. **Delete** requires confirmation.

Each project stores the complete validated upload response (all rows, columns
and audit, when available), the original filename and save time, in the
browser's IndexedDB. Projects are **not uploaded, synced or encrypted** by
OmniStat. Anyone with access to this browser profile may be able to read them,
and clearing site data or using another browser/device removes access. Save only
data you are authorized to store on this device.

Saving is never automatic. Damaged or unrecognized saved records are reported
and can be deleted, but are never opened. If the browser cannot store a project,
or cannot make a large project the active dataset, an explicit error is shown and
the previous active dataset remains in use. Projects store datasets only; analysis
results are not saved with them.

### Plain-English Result Summaries

Successful results for the independent and paired t-tests, one-way ANOVA,
Pearson correlation, Shapiro-Wilk, Mann-Whitney U, Wilcoxon signed-rank,
Kruskal-Wallis, chi-square, linear regression and logistic regression start with
a **Plain-English summary**. Regression summaries describe overall model tests,
R², adjusted R² or McFadden R², predictor estimates or odds ratios with 95%
confidence intervals, and relevant diagnostic warnings. Categorical predictors
are described relative to their reference level; logistic summaries identify
the event and reference outcome.

For example, a linear-regression summary describes the change in the outcome per
unit increase in a predictor while holding other predictors constant. A logistic
summary describes how many times as high the event odds are for a predictor
change. These are associations, not evidence of causation.

The summary is generated from fixed rules in the browser, not by AI, so it cannot
invent numbers:

- Every number is read from a named result field (for example
  `results.groups[0].mean`); hover over an underlined number to see its source.
  The only other figures are the fixed method settings `95%` and `0.05`.
- If any required value is missing or invalid, no summary is shown rather than a
  partial one.
- Non-significant results are not described as showing no difference, and
  significance is not presented as clinical importance or causation.
- Group codes are shown with SPSS/Stata value labels, for example “1” (Male).
- Outcome, predictor and category labels can appear in explanations and reports;
  review them for identifiers or other sensitive information before sharing.

Tests explain real R outputs for all eleven procedures (stored in
`frontend/tests/fixtures/rResults.json`) and independently verify that every
number matches its source field. Other procedures show the results without a
summary. The printable report includes the same summary.

### Word Report With APA Formatting

After a successful R analysis, select **Download Word (.docx)** in the Report
panel. The editable document is created in the browser with the open-source
`docx` library (MIT), loaded only when needed; nothing is uploaded or saved.
It contains:

- an APA 7-style results statement, for example
  *t*(27.81) = −0.89, *p* = .382, *M*<sub>diff</sub> = −3.95, 95% CI [−13.08, 5.17], *d* = −0.32;
- regression statements such as
  *F*(3, 596) = 435.93, *p* < .001, *R*² = .69, adjusted *R*² = .69, or
  *χ*²(3) = 69.99, *p* < .001, McFadden *R*² = .09, AUC = .69;
- the plain-English summary and caveats;
- numbered APA tables (horizontal rules only): group or paired descriptive
  statistics, Tukey HSD or Holm-adjusted pairwise comparisons, and observed
  counts for chi-square, regression coefficients or logistic odds ratios, with
  value labels beside group codes;
- the method (procedure, R version, columns, data SHA-256, rows used and
  excluded, declared assumptions);
- numbered figures from the R charts; and
- an appendix with the R script.

APA formatting uses italic statistic symbols, true minus signs, two decimals for
statistics, exact *p* values to three decimals (`< .001` below that) and no
leading zero for values bounded by 1 (*p*, *r*, R², AUC, η², ε², *V*). Numbers
are rounded copies of the result fields; tests check statements and regression
tables against real R output. Other procedures get a simple results table instead
of an APA statement. Invalid chart images are replaced with a note rather than
embedded. Reports are generated in the browser from the displayed result; they
do not upload or rerun the analysis, but labels, tables and charts can reveal
sensitive information. As with the printable report, the document is a snapshot
to review with a statistician, not a signed attestation.

### Python Cross-Check
After every successful R run, the backend recomputes the headline numbers in
Python (SciPy, plus statsmodels for regression) from the same prepared data and
compares them with R. The result panel shows a badge: **agrees** (all values
match within a tight tolerance), **differs** (the differing values are listed
first and flagged as an alert) or **not available** (with the reason). R stays
the reported result, and agreement confirms the arithmetic, not that the method
suits your data. The check never fails or delays an analysis beyond a fraction of
a second, and the outcome is added to the printable report and the Word report.

Covered: every procedure in the table above. For example, regression compares
the F-test, R², every coefficient with its standard error, confidence interval
and robust (HC3) p-value, Breusch-Pagan, VIF, odds ratios, AUC and
Hosmer-Lemeshow. A few values are deliberately not compared: the Hodges-Lehmann
shift intervals, Spearman's p-value (R and SciPy use different methods) and
rank-test p-values on very large groups. If Python and R see a different number
of rows (for example because of how blank cells are read), the check reports
"not available" rather than a false disagreement. Datasets over 50,000 rows are
not cross-checked.

The `cross_check` object in `/api/r/run` responses holds `status`, `engine`,
`note` and `checks` (label, R value, Python value, agree, relative tolerance).

### Printable Analysis Report

After a successful R analysis, select **Print / Save as PDF** below the result.
Your browser's print dialog opens with a report containing:

- the plain-English summary, when available;
- methods: procedure, R version, selected columns, data SHA-256 and, for
  reviewed plans, row counts, missing-data handling, settings, group sizes and
  declared assumptions (not all are checked automatically);
- results: p-value with the 0.05 decision, statistics, tables and warnings;
- charts produced by R; and
- an appendix with the standalone R script.

Choose **Save as PDF** in the print dialog to keep a copy. The report is created
in the browser from the displayed result, so nothing is uploaded, rerun or saved
automatically. It contains no raw data rows, but tables, group labels and charts
can still reveal sensitive information.

Tables longer than 200 rows are shortened with a note. Curve-fit coordinates,
data points and residuals are left out; use the reproducibility ZIP for
complete outputs. The report is printed from an isolated, script-free frame,
and all values are escaped. It is auto-generated, should be reviewed by a
qualified statistician, and is not a signed attestation.

### Reproducibility ZIP Export

After a successful R analysis, the shared analysis panel offers **Download ZIP**.
Read the sensitive-data warning and check the authorization box first. Nothing is
exported automatically or saved to account history. Export sends the selected
rows and the result snapshot back to the configured analysis server to verify
their consistency; it does not rerun R.

The archive contains:

- `data.csv`: the exact selected-column CSV sent to R, including rows later
  excluded for missing values, but not unrelated columns or the original workbook.
- `analysis.R`: the standalone curated R script, preserving original column names.
- `results.json`: the original result snapshot, including outputs and charts.
- `analysis-plan.json`: the executed reviewed plan, when present.
- `plots/plot-01.png`, etc.: the original PNG charts.
- `manifest.json`: R version, selected columns, row count and SHA-256/byte counts
  for the data, script, result, optional plan and charts.
- `README.txt`: privacy warnings and rerun instructions.

**Privacy:** selected data, results, console output and charts can contain
patient-level information or identifiers. Store and share the ZIP only with
appropriate authorization. The export does not deliberately attach API keys or
passwords, but cannot remove sensitive values present in the selected data or
results.

Extract into a private folder, review the script, and run `Rscript analysis.R`
from that folder using the R version recorded in the manifest. The curated
scripts use standard/recommended R packages and install nothing. Numerical
results print to the terminal; plots go to `Rplots.pdf`. Rerunning does not
overwrite the saved `results.json`. Plot appearance and low-order numerical
digits may differ across R/platform versions.

`POST /api/r/bundle` accepts `{result, data}` and uses the same API-key and
rate-limit controls as `/api/r/run`. Its browser-facing Next.js proxy uses the
existing server-only `OMNISTAT_API_KEY` and `BACKEND_URL` (or `API_URL`) settings.
Responses are ZIP downloads with `Cache-Control: no-store`. The browser limits
the serialized request to 4,000,000 bytes for hosted request limits; the backend
limits total uncompressed archive contents to 20 MiB, with up to 100 charts and
8 MiB of base64 per chart.

Changed data, code or reviewed plans, failed/timed-out analyses, missing R
versions and invalid chart encodings are rejected explicitly. Older results
without complete metadata must be rerun before export. **This is a user-supplied
snapshot, not a signed server attestation:** hashes help check file consistency
but do not prove that the numerical results came from an authentic server run.

### Analysis Plan Review

The independent-groups t-test, paired t-test, one-way ANOVA, Pearson correlation
and Shapiro-Wilk normality test have an explicit review step in both Jarvis and
the Test Wizard's shared column picker:

1. Choose the outcome and grouping columns, then select **Review Analysis Plan**.
2. The backend prepares a version `1.0` specification without executing R.
3. Review the selected procedure, R engine, column mappings, full selected-data
   SHA-256, total/complete/excluded row counts, group sizes (where applicable),
   procedure-specific settings, assumptions and expected outputs.
4. Select **Confirm and Run in R**, or cancel. Changing columns invalidates the
   review. Independence is a study-design requirement, not an automatic check.
5. The backend regenerates and compares the plan before execution. Changed data
   or plan fields are rejected (409 for a mismatch, 422 for invalid input).
   Results include the exact executed specification under **Executed analysis
   specification**, alongside the existing R script and data fingerprint.

`POST /api/r/plan` uses the same API-key and rate-limit controls as `/api/r/run`.
The browser uses the server-side `/api/r/plan` proxy; no API key is exposed.
`/api/r/run` accepts an optional `analysis_plan` containing the reviewed JSON.
The SHA-256 covers selected columns in canonical role order, including rows later
excluded for missing values; it is not a fingerprint of unrelated dataset columns.

Other analyses retain their existing run flow. Existing API clients may still run without a plan for
backwards compatibility; this is a UI review and consistency check, not a stored
approval record or audit log. R version remains part of the execution result,
not the pre-execution plan. Parameters are fixed to the existing curated template;
the review does not yet support editing alpha, confidence level or alternatives.
Plans retain schema version `1.0` and the existing Welch plan shape. For the added
procedures, inapplicable settings are explicitly `null`, and non-group analyses
have empty group counts:

| Procedure | Settings and pre-execution checks |
|-----------|-----------------------------------|
| Independent t-test | Welch, two-sided, 95% CI; exactly two groups with at least two complete rows each |
| Paired t-test | Two-sided, 95% CI; at least three complete pairs, nonconstant first-minus-second differences; matching is a user-confirmed study-design requirement |
| One-way ANOVA | Equal variances assumed, Tukey HSD 95% intervals; at least three groups with two complete rows each and nonzero within-group variation |
| Pearson correlation | Two-sided, 95% CI; at least four complete pairs and nonconstant numeric columns; Spearman comparison is disclosed |
| Shapiro-Wilk | 3–5000 complete, nonconstant numeric values; alpha 0.05 decision and Q-Q plot, no confidence interval or directional alternative |

Plan review rejects nonnumeric or infinite selected values before execution.
Rows missing any selected value are excluded together, preserving paired
observations. Assumptions are disclosed, not certified automatically. The ANOVA
review deliberately requires replicated groups to make its diagnostics meaningful;
legacy requests without a plan retain the existing template validation.
Use numeric group codes or non-numeric text labels. Numeric-looking text codes
and the literal text label `NA` must be recoded before review to avoid R CSV
type inference changing group membership.

### Pre-Run Assumption Checks

When a reviewed plan is prepared, OmniStat also runs read-only diagnostics on the
same selected complete-case data and shows them in the review. R is not run.
The checks are computed in Python with SciPy; tests confirm they match R's
`shapiro.test` and a base-R Brown-Forsythe calculation.

| Procedure | Checks | Suggestion when flagged |
|-----------|--------|-------------------------|
| Independent t-test | Shapiro-Wilk per group; Brown-Forsythe variance comparison (information only, since Welch does not assume equal variances); outliers per group | Mann-Whitney U, if the smallest group has fewer than 30 observations |
| Paired t-test | Shapiro-Wilk and outliers for paired differences | Wilcoxon signed-rank, if there are fewer than 30 pairs |
| One-way ANOVA | Shapiro-Wilk of residuals; Brown-Forsythe (warns, as ANOVA and Tukey assume equal variances); outliers per group | Kruskal-Wallis, if the smallest group has fewer than 30 observations |
| Pearson correlation | Shapiro-Wilk and outliers for each variable | Interpret the Spearman correlation reported alongside |
| Shapiro-Wilk | None; the procedure is itself a normality check | — |

Each check is shown as **No concern**, **Review**, **Information** or **Not
assessed**. Shapiro-Wilk needs 3–5000 non-constant values, and outlier flags
(outside 1.5 × IQR) need at least 4 values. With larger samples, a note explains
that t-tests and ANOVA are usually robust to moderate non-normality instead of
suggesting a switch. Rank-based alternatives answer a different question
(distributions or medians rather than means), and the review says so.

Diagnostics use alpha 0.05 and are screening aids. A non-significant result does
not prove an assumption holds; large samples can flag trivial departures; and
independence or study design cannot be checked from the data. Outliers are for
review, never automatic removal. Suggestions are advisory: you can continue with
the reviewed plan, or choose the alternative in the Test Wizard or Jarvis.

`POST /api/r/checks` accepts the same body as `/api/r/plan`, applies the same
validation, API-key and rate-limit controls, and returns the checks with the
plan's canonical columns and data SHA-256. The browser rejects reports that do
not match the reviewed plan. If checks are unavailable, the review says so
explicitly and the analysis can still be run.

### Supabase Accounts and Cloud History

Accounts are optional: analysis execution still works without sign-in. Account
ownership applies to saved history, not to the existing shared R/math/voice API
key. Sign-in uses email codes (Supabase manages account creation and verification;
this app never handles passwords).

Configure a development Supabase project before enabling this feature:

1. In the Supabase SQL Editor, run
   [the history migration](supabase/migrations/202610270001_analysis_history.sql).
   It creates append-only result snapshots (with owner deletion), an index and
   row-level security policies. Do not disable RLS or grant anonymous access.
2. Run [the ownership checks](supabase/tests/history_ownership.sql) in the SQL
   Editor. They create two temporary users inside a transaction, verify owner
   reads/deletes, reject forged ownership, check cross-user isolation and
   anonymous/update privileges, then roll back. Use a development project; if an
   assertion fails, run `rollback;` and fix the configuration before proceeding.
3. Enable Email authentication and account sign-ups in Supabase Auth. Users can
   sign in with either the emailed link or a code:
   - **Links** work with Supabase's default templates. Open the link in the same
     browser. Under **Authentication → URL Configuration**, set the Site URL and
     add every app address to **Redirect URLs**, for example
     `http://localhost:3000/**` and your Vercel URL. Expired or invalid links
     show an explicit message.
   - **Codes** need custom templates, which Supabase only allows after you set up
     custom SMTP. Add the code to **both** the **Confirm signup** template (new
     users) and the **Magic Link** template (returning users), for example
     `<p>Your sign-in code is {{ .Token }}</p>`.
   Configure a production SMTP provider and review auth rate limits before launch.
4. Add these public values to `frontend/.env.local` and the Vercel environment:

   ```dotenv
   NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
   ```

   Use the project URL only (Project Settings → Data API / API Keys), not the REST
   endpoint ending in `/rest/v1/`; a URL with a path shows an explicit
   misconfiguration message. Use the project's publishable key (or legacy anon
   key), **never a secret or service-role key**. Restart local Next.js/rebuild Vercel after setting them.
   Neither variable is needed on Render. Environment files are ignored by Git.
5. Open **History**, request an email code, then verify it. Run an R analysis from
   Jarvis or the Test Wizard and explicitly consent before selecting **Save to
   History**. Reopen or delete that snapshot from History or `/history`.
6. Verify with two real accounts: A can save/reopen/delete its records, B cannot
   see A's records, refreshing preserves A's history, and sign-out hides history.
   Test network failures and expired sessions before using real research data.

Saving is opt-in, not automatic. The saved R response includes results, plots,
column labels, reproducible code, data fingerprint and the executed specification
when present. No raw dataset is separately attached, **but charts, stdout and
statistics can themselves contain patient-level data or identifiers**. Cloud
storage is not automatically suitable for clinical data: confirm consent,
institutional approval, region, retention, access and provider agreements first.
Client saves have a 4 MB limit; the database also caps serialized JSON at 5 MB.

History lists 20 records per page, loads full results only on opening, and requires
confirmation for deletion. Stored snapshots are not an immutable audit log or
proof that a result originated on the analysis server: signed-in users can submit
their own snapshots. Uploads remain in browser localStorage, outside the account;
signing out does not clear them. Use separate/private browser profiles on shared
machines. Reopening does not restore a dataset or rerun a procedure. Manual-entry
Normality/Survival tabs do not yet offer cloud saving.

Frontend tests mock Supabase to verify sign-in requests, consent, ownership filters,
payload limits and save/load/delete failures. They **do not replace** running the
SQL ownership checks and the two-account live test above. Missing Supabase
configuration leaves history disabled with an explicit message, without breaking
the workstation.

### Audit Log (Supabase)

While a user is signed in, OmniStat records an append-only audit entry for each
data upload, R analysis run (successful or failed), save to history and export
(PDF print, Word or reproducibility ZIP). Signed-out use is not recorded. Entries
follow the specification's minimum fields: event ID, UTC time, user, action,
procedure, engine and R version, SHA-256 of the reviewed plan, data and R code,
warnings and details such as column names, row counts, export format or the
uploaded file name. **No data rows, results or code are stored**, only
fingerprints.

Setup: in the Supabase SQL Editor, run
[the audit migration](supabase/migrations/202610280001_audit_log.sql), then
[the integrity checks](supabase/tests/audit_log_integrity.sql). The checks use
temporary users inside a transaction and roll back.

Integrity is enforced by the database, not the browser:

- A trigger assigns the owner, time, per-user sequence number, previous hash and
  entry hash. Client-supplied values for these are ignored, and recording for
  another user is rejected. A per-user lock keeps the sequence gap-free across
  tabs.
- Each hash is SHA-256 over a canonical encoding of the entry plus the previous
  entry's hash, so entries form a chain.
- Users can only read and add their own entries. Updates, deletes and truncation
  are refused by both permissions and triggers. Entries are retained if an
  account is deleted.
- **Verify integrity** (History → Audit log) recomputes the whole chain in the
  database and reports the first changed, missing or reordered entry.
  **Export JSON** downloads every entry with the verification result.

Limitations: removing only the newest entries cannot be detected from the chain
alone; compare entry counts with earlier exports. A database administrator could
disable the triggers and rewrite the entire chain, so exported copies held
elsewhere are the independent evidence. Recording never blocks or fails your
work; if an entry cannot be recorded, a warning banner says so.

### Development Checks (macOS/Linux)

Use Python 3.11 to create an isolated environment. The `.venv` directory is ignored
by Git.

```bash
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
python -m pytest -q

cd frontend
npm ci
npm test
npm run build
```

R-dependent tests are skipped when `Rscript` is unavailable; audio fixtures require
FFmpeg with `libopus`, `libmp3lame`, FLAC and PCM encoding support. Use
`python -m pytest -q -ra` to see skip reasons.

Agent unit tests replace the intent classifier with deterministic predictions and
mock Groq requests, so they need neither private model access nor API keys. These
tests cover routing, clarification, SDK request compatibility and the existing
classifier-only fallback when Groq fails; they do not measure model accuracy.
Running the real classifier separately requires the model in `models/intent_model/`
or access to the Hugging Face repository configured by `HF_MODEL_REPO` and, for
private models, `HF_TOKEN`.

On macOS, install the native tools and the R JSON dependency with:

```bash
brew install r ffmpeg
Rscript -e 'install.packages("jsonlite", repos="https://cloud.r-project.org")'
```

On macOS, the R and math workers retain CPU, file-size and wall-clock limits but
skip the unsupported address-space limit (`RLIMIT_AS`) and log a warning.
Use a Linux container for memory-limited execution; these controls alone are not
a security sandbox. Linux retains the configured address-space limit. The R
executable is resolved from your shell's `PATH` (including Homebrew); alternatively,
set `RSCRIPT_BIN` to its absolute path.

#### Container sandbox for R and maths (no network)

Set `R_SANDBOX=docker` and/or `MATH_SANDBOX=docker` to run every R job or maths
calculation in its own throwaway container instead of a host process. Each container
has no network (`--network none`), a read-only root filesystem (plus a 64 MB `/tmp`
tmpfs), all capabilities dropped, `no-new-privileges`, a non-root user, and hard
memory, CPU, process-count and file-size limits. R jobs get only their per-run
working directory mounted writable; maths containers get no host mounts at all
(the request arrives on stdin). If Docker is unavailable the run fails with an
explicit error; it never falls back to running on the host.

```bash
docker build -f Dockerfile.rworker -t omnistat-r-worker .
docker build -f Dockerfile.mathworker -t omnistat-math-worker .
export R_SANDBOX=docker MATH_SANDBOX=docker   # PowerShell: $env:R_SANDBOX = "docker"
```

At startup the API checks that each enabled sandbox's image exists and logs an error
if not; `GET /health` then adds `"sandbox": {"r": "ready", "math": "unavailable"}`
(it stays `"status": "ok"`, and error details are only logged).

Optional settings: `R_DOCKER_IMAGE` (default `omnistat-r-worker`),
`MATH_DOCKER_IMAGE` (default `omnistat-math-worker`), `DOCKER_BIN`,
`DOCKER_SANDBOX_USER`, `DOCKER_SANDBOX_CPUS`, `DOCKER_SANDBOX_PIDS`, plus the existing
`R_*` and `MATH_*` memory, CPU and timeout limits. The sandbox is off by default so
local development works without Docker; **enable it in any deployment that runs
user-supplied analyses**. The API process needs access to the Docker CLI (and, for R,
the host path of its temp directory), so run the API on the host or mount the Docker
socket deliberately; a container without Docker access, such as the bundled
`Dockerfile` on Render, keeps the rlimit-only protection. On timeout the container is
killed; on native Windows without Docker the whole `Rscript` process tree is now
terminated, so a runaway job can no longer hang the request.

Run the focused worker checks with:

```bash
python -m pytest -q tests/test_worker_portability.py tests/test_math.py tests/test_r_runner.py tests/test_r_templates.py tests/test_r_security.py tests/test_r_sandbox.py tests/test_math_sandbox.py tests/test_docker_integration.py
```

`tests/test_docker_integration.py` runs real containers (network blocked, read-only
root, timeout kill) and skips itself unless both worker images are built.

The Ogg recognition fixture uses Opus, the same encoder as the WebM fixture, so
Vorbis support is not required.

### Continuous Integration

Pull requests and pushes to `master` run two checks:

- **Backend:** Python 3.11, R with `jsonlite`, FFmpeg, the two sandbox worker images
  (so the real-container tests run) and the full pytest suite.
  Hugging Face offline mode prevents accidental model downloads during tests.
  Native prerequisite checks fail explicitly if required R/Opus/MP3 support is
  missing, and pytest reports any remaining skips.
- **Frontend:** Node.js 22, `npm ci`, `npm test` for uploaded-data workflow
  regressions, and `npm run build`, including Next.js lint and TypeScript checks.

To require these checks before merging, configure a GitHub branch protection rule
or ruleset for `master`; the workflow alone does not enforce merge protection.

---

## API Endpoints

R, math and voice endpoints require the server-side API key and are rate limited;
the browser reaches them through Next.js proxies.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/analytics/upload` | Upload CSV/Excel/SPSS/Stata; returns data, labels, audit and dashboard statistics |
| POST | `/api/datasets` | Upload once into the server-side dataset store (large files); returns a `dataset_id`, summaries and a 100-row preview, not the rows |
| GET | `/api/datasets/{id}`, `/api/datasets/{id}/rows?offset=&limit=` | Dataset summary; pages of rows (up to 1,000 at a time) |
| DELETE | `/api/datasets/{id}` | Delete a stored dataset now |
| POST | `/api/analytics/descriptive` | Descriptive statistics |
| POST | `/api/analytics/normality` | Shapiro-Wilk normality test |
| POST | `/api/analytics/survival` | Kaplan-Meier survival curve |
| POST | `/api/analytics/compare-groups`, `/compare-paired`, `/correlation`, `/regression`, `/categorical`, `/power` | Python statistics endpoints |
| POST | `/api/agent/query` | Natural language → statistical intent |
| GET | `/api/r/tests` | Available R procedures and their column roles |
| POST | `/api/r/plan` | Prepare a reviewed analysis plan (no execution) |
| POST | `/api/r/checks` | Pre-run assumption checks (no execution) |
| POST | `/api/r/run` | Run an R procedure (rows in `data`, or a stored `dataset_id`), optionally against a reviewed plan |
| POST | `/api/r/bundle` | Build a reproducibility ZIP from a result |
| GET/POST | `/api/math/operations`, `/api/math/run` | Symbolic and numeric math |
| POST | `/api/voice/transcribe` | Speech to text for Jarvis |

---

## Roadmap

Prioritised against the NexStat technical specification.

### Next
- [ ] Golden test datasets with reference outputs for every procedure
- [ ] Basic maps: offline basemap tiles and map export (boundaries, choropleth and heatmaps are built)

### Phase 1 remaining
- [x] Stronger sandboxing: R and maths workers can run in containers with no network (`R_SANDBOX` / `MATH_SANDBOX=docker`); still to do: enable it by default in the hosted deployment (needs a worker host with Docker access)
- [ ] Large datasets (1 million rows on 8 GB RAM): server-side Parquet store, upload and R analyses by `dataset_id` are built and verified at 1,000,000 rows (API only); the web app still needs to use them (see "Large Datasets")
- [ ] Offline desktop app (Electron or Tauri) with local AI models
- [ ] Privacy tools: identifier detection, pseudonymisation, encryption at rest, roles

### Later
- [ ] Survival models, mixed models, GLM family, multivariate methods
- [ ] Epidemiology: epidemic curves, 2×2 tables; spatial hotspots (Moran's I, Gi*)
- [ ] DHIS2 connector, collaboration, Bayesian methods, meta-analysis, time series
- [ ] Bland-Altman, Levey-Jennings with Westgard rules, ROC analysis

---

## Project Structure

```
omnistat-ai/
├── app/
│   ├── agents/                  # Jarvis agent and prompts
│   ├── api/routes/              # analytics, datasets, agent, r_analysis, math, voice
│   ├── security/                # API keys, rate limits, upload size guard
│   ├── services/
│   │   ├── analytics_service.py # Upload parsing and Python statistics
│   │   ├── dataset_store.py     # Server-side Parquet store for large datasets
│   │   ├── data_audit.py        # Upload data-quality audit
│   │   ├── analysis_plan.py     # Reviewed analysis plans
│   │   ├── assumption_checks.py # Pre-run diagnostics
│   │   ├── r_templates.py       # Curated R procedures
│   │   ├── r_runner.py          # Resource-limited R worker
│   │   └── reproducibility_bundle.py
│   └── main.py                  # FastAPI entry point
├── frontend/
│   ├── app/                     # Pages and server-side API proxies
│   ├── components/              # accounts, analytics, audit, charts, data,
│   │                            # history, jarvis, reports
│   ├── lib/                     # API clients, APA, explanations, reports,
│   │                            # projects, history, audit, Supabase
│   └── tests/                   # Vitest tests and real R fixtures
├── supabase/
│   ├── migrations/              # History and audit log tables
│   └── tests/                   # SQL ownership and integrity checks
├── tests/                       # pytest suite
├── requirements.txt             # Backend dependencies
├── requirements-dev.txt         # Plus test dependencies
└── build.sh                     # Render build script
```

---

## Sample Dataset

A sample clinical dataset is included at `data/raw/sample_clinical.csv` with:
- Patient demographics (age, gender)
- Clinical measurements (blood_pressure, cholesterol)
- Survival data (time_to_event, event_occurred)
- Treatment groups (group A/B)

Upload it to see the full dashboard in action.

---

## Built By

**Paul** ([ShadesBlue](https://github.com/ShadesBlue)) — Idea Owner. OmniStat AI concept and medical domain expertise

**Collaboration with:** Benedict Bett — GitHub: [github.com/bennedictbett]

---

## License

MIT — see LICENSE for details.