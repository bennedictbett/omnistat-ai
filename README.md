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
- Python 3.10+
- Node.js 18+
- A free [Groq API key](https://console.groq.com)

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