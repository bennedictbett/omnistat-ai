import os

structure = [
    "app/api/routes/analytics.py",
    "app/api/routes/predictions.py",
    "app/api/routes/agent.py",
    "app/api/dependencies.py",
    "app/agents/analyst_agent.py",
    "app/agents/tools.py",
    "app/agents/prompts.py",
    "app/ml/model.py",
    "app/ml/predict.py",
    "app/ml/preprocessing.py",
    "app/database/models.py",
    "app/database/connection.py",
    "app/database/repository.py",
    "app/services/analytics_service.py",
    "app/services/prediction_service.py",
    "app/services/report_service.py",
    "app/security/auth.py",
    "app/security/validation.py",
    "app/security/guardrails.py",
    "app/main.py",
    "data/raw/.gitkeep",
    "data/processed/.gitkeep",
    "tests/test_api.py",
    "tests/test_ml.py",
    "tests/test_agents.py",
    "scripts/train.py",
    "scripts/seed_db.py",
    ".github/workflows/ci.yml",
    "Dockerfile",
    "docker-compose.yml",
    "requirements.txt",
    ".env.example",
    "README.md",
    "SECURITY.md",

        # Frontend
    "frontend/app/page.tsx",
    "frontend/app/layout.tsx",
    "frontend/app/globals.css",
    "frontend/app/dashboard/page.tsx",
    "frontend/app/analysis/page.tsx",
    "frontend/app/results/page.tsx",
    "frontend/app/history/page.tsx",

    # Components - Core
    "frontend/components/core/Sidebar.tsx",
    "frontend/components/core/Header.tsx",
    "frontend/components/core/ThemeToggle.tsx",

    # Components - Jarvis AI
    "frontend/components/jarvis/JarvisInput.tsx",
    "frontend/components/jarvis/JarvisResponse.tsx",
    "frontend/components/jarvis/VoiceInput.tsx",

    # Components - Data
    "frontend/components/data/FileUpload.tsx",
    "frontend/components/data/DataGrid.tsx",
    "frontend/components/data/DataSummary.tsx",

    # Components - Analytics
    "frontend/components/analytics/NormalityTest.tsx",
    "frontend/components/analytics/SurvivalCurve.tsx",
    "frontend/components/analytics/DescriptiveStats.tsx",
    "frontend/components/analytics/RegressionPlot.tsx",
    "frontend/components/analytics/CorrelationMatrix.tsx",

    # Components - ML
    "frontend/components/ml/ROCCurve.tsx",
    "frontend/components/ml/FeatureImportance.tsx",
    "frontend/components/ml/ConfusionMatrix.tsx",

    # Components - Charts
    "frontend/components/charts/BoxPlot.tsx",
    "frontend/components/charts/Histogram.tsx",
    "frontend/components/charts/ScatterPlot.tsx",
    "frontend/components/charts/KaplanMeier.tsx",
    "frontend/components/charts/BlandAltman.tsx",

    # Components - Reports
    "frontend/components/reports/ReportBuilder.tsx",
    "frontend/components/reports/ExportPanel.tsx",

    # Lib
    "frontend/lib/api.ts",
    "frontend/lib/types.ts",
    "frontend/lib/utils.ts",
    "frontend/lib/constants.ts",

    # Hooks
    "frontend/hooks/useJarvis.ts",
    "frontend/hooks/useAnalysis.ts",
    "frontend/hooks/useFileUpload.ts",

    # Store
    "frontend/store/analysisStore.ts",
    "frontend/store/dataStore.ts",

    # Public
    "frontend/public/.gitkeep",
]

base = "."  # current directory

for path in structure:
    full_path = os.path.join(base, path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    if not os.path.exists(full_path):
        with open(full_path, "w") as f:
            f.write("")
        print(f"✅ Created: {path}")
    else:
        print(f"⏭️  Exists:  {path}")

print("\n✅ Folder structure ready")