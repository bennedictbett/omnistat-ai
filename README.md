# OmniStat AI

> Upload clinical data. Get instant statistical insights. No coding required.

OmniStat AI is an AI-powered statistical analysis platform built for researchers, clinicians, and lab scientists who need publication-ready results without writing a single line of code.

---

## The Problem

Statistical software like SPSS and SAS costs thousands of dollars annually and requires technical training most researchers don't have. General AI tools only *generate* code — they don't execute it, meaning a developer is still required to get actual results.

OmniStat closes both gaps: it understands what you want, runs the analysis, and delivers real results instantly.

---

## What's Built

### Jarvis AI Agent
Type your research question in plain English. Jarvis identifies the correct statistical test, extracts the required variables, lists assumptions to check, and executes the analysis automatically.

```
"Compare blood pressure between two groups before and after treatment"
→ test: repeated_measures_anova
→ variables: [blood_pressure, group, time_point]
→ assumptions: [normality, sphericity, equal_variances]
→ Run Analysis → results rendered inline
```

### Visual Data Dashboard
Upload any CSV, Excel, SPSS or Stata file — OmniStat instantly generates:
- **Overview** — row/column counts, numeric summary table (mean, median, std, min, max)
- **Distributions** — histograms for every numeric column
- **Categorical** — donut pie charts + bar charts for every categorical column
- **Correlation** — full Pearson correlation heatmap with strong correlation insights

### Statistical Analysis Modules
| Module | Description |
|--------|-------------|
| Normality Test | Shapiro-Wilk test with interpretation and clinical guidance |
| Survival Curve | Kaplan-Meier with median survival time and interactive chart |
| Descriptive Stats | Mean, median, SD, IQR, range, variance, skewness, kurtosis |

---

## Architecture

```
User (Natural Language / File Upload)
        ↓
Next.js 14 Frontend (React + Tailwind)
        ↓
FastAPI Backend (Python)
        ↓
┌──────────────────┬─────────────────────┐
│  Jarvis Agent    │  Analytics Engine   │
│  Groq LLaMA3     │  scipy + lifelines  │
│  Intent routing  │  pandas + numpy     │
└──────────────────┴─────────────────────┘
```

**Stack:**
- **Backend:** FastAPI + Python (scipy, lifelines, pandas, numpy)
- **AI Agent:** Groq (`groq/compound` model) for natural language → statistical intent
- **Frontend:** Next.js 14 + Tailwind CSS + Recharts
- **Data:** CSV, Excel, SPSS (`.sav`/`.zsav`) and Stata (`.dta`) parsing with automatic column type detection and variable/value labels

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

### Printable Analysis Report

After a successful R analysis, select **Print / Save as PDF** below the result.
Your browser's print dialog opens with a report containing:

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

Run the focused worker checks with:

```bash
python -m pytest -q tests/test_worker_portability.py tests/test_math.py tests/test_r_runner.py tests/test_r_templates.py tests/test_r_security.py
```

The Ogg recognition fixture uses Opus, the same encoder as the WebM fixture, so
Vorbis support is not required.

### Continuous Integration

Pull requests and pushes to `master` run two checks:

- **Backend:** Python 3.11, R with `jsonlite`, FFmpeg and the full pytest suite.
  Hugging Face offline mode prevents accidental model downloads during tests.
  Native prerequisite checks fail explicitly if required R/Opus/MP3 support is
  missing, and pytest reports any remaining skips.
- **Frontend:** Node.js 22, `npm ci`, `npm test` for uploaded-data workflow
  regressions, and `npm run build`, including Next.js lint and TypeScript checks.

To require these checks before merging, configure a GitHub branch protection rule
or ruleset for `master`; the workflow alone does not enforce merge protection.

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/analytics/upload` | Upload CSV/Excel/SPSS/Stata — returns full stats, labels + visualization data |
| POST | `/api/analytics/normality` | Shapiro-Wilk normality test |
| POST | `/api/analytics/survival` | Kaplan-Meier survival curve |
| POST | `/api/analytics/descriptive` | Full descriptive statistics |
| POST | `/api/agent/query` | Natural language → statistical intent |

---

## Roadmap

### In Progress
- [ ] Bland-Altman plots for method comparison
- [ ] Levey-Jennings charts with Westgard rules (lab QC)
- [ ] ROC curve analysis with AUC optimization
- [ ] Competing risks survival analysis

### Planned
- [ ] DuckDB Wasm for large dataset support (100M+ rows)
- [ ] DICOM/medical imaging ingestion via ONNX
- [ ] Bayesian probabilistic programming
- [ ] GWAS genomics pipelines
- [ ] CDISC compliance (SDTM/ADaM) for pharma/clinical trials
- [ ] Federated mesh ML across institutions
- [ ] Mobile companion app (voice-driven, OCR table scanner)
- [ ] Peer-to-peer collaboration with real-time sync

---

## Project Structure

```
omnistat-ai/
├── app/
│   ├── agents/
│   │   ├── analyst_agent.py     # Groq-powered Jarvis agent
│   │   └── prompts.py           # Statistical intent prompt
│   ├── api/routes/
│   │   ├── analytics.py         # Statistical analysis endpoints
│   │   └── agent.py             # Natural language query endpoint
│   ├── services/
│   │   └── analytics_service.py # Core statistical computation
│   └── main.py                  # FastAPI app entry point
├── frontend/
│   ├── app/
│   │   └── page.tsx             # Main dashboard
│   └── components/
│       ├── core/                # Sidebar, Header
│       ├── jarvis/              # AI agent UI
│       ├── data/                # Upload + Data Dashboard
│       └── analytics/           # Normality, Survival, Descriptive
├── data/raw/                    # Sample clinical datasets
├── requirements.txt
└── .env.example
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