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
Upload any CSV or Excel file — OmniStat instantly generates:
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
- **Data:** Full CSV/Excel parsing with automatic column type detection

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

### Analysis Plan Review (First Milestone)

The independent-groups t-test now has an explicit review step in both Jarvis and
the Test Wizard's shared column picker:

1. Choose the outcome and grouping columns, then select **Review Analysis Plan**.
2. The backend prepares a version `1.0` specification without executing R.
3. Review the Welch procedure, R engine, column mappings, full selected-data
   SHA-256, total/complete/excluded row counts, group sizes, fixed two-sided
   alternative, 95% confidence level, assumptions and expected outputs.
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

This milestone supports only `independent_t_test` plans. Other analyses retain
their existing run flow. Existing API clients may still run without a plan for
backwards compatibility; this is a UI review and consistency check, not a stored
approval record or audit log. R version remains part of the execution result,
not the pre-execution plan. Parameters are fixed to the existing curated template;
the review does not yet support editing alpha, confidence level or alternatives.
Use numeric group codes or non-numeric text labels. Numeric-looking text codes
and the literal text label `NA` must be recoded before review to avoid R CSV
type inference changing group membership.

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
| POST | `/api/analytics/upload` | Upload CSV/Excel — returns full stats + visualization data |
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