# Python API + R runtime in one image (Render's native Python runtime has no R).
FROM rocker/r-ver:4.4.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Pre-install every R package the templates use. Runtime installs are not allowed.
RUN install2.r --error --skipinstalled jsonlite

WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:${PATH}"

COPY app ./app
COPY data ./data
COPY tests ./tests

# Run unprivileged; R_* limits are read by app/services/r_runner.py
RUN useradd --create-home appuser
USER appuser
ENV R_MAX_CONCURRENT=4 R_CPU_SECONDS=30 R_MEMORY_MB=2048

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]