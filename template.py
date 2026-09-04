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