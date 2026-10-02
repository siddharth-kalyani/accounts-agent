# Cloud Run image. Cloud Build builds it from the staged release/ folder
# (python scripts/package_release.py); nobody needs Docker installed locally.
# Only the runtime, the built frontend and the startup script are copied in.
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY backend/pantry ./backend/pantry
COPY frontend/dist ./frontend/dist
COPY startup.sh ./
# Data lives in Cloud SQL and Cloud Storage, so the app needs no writable files.
RUN useradd --system --no-create-home --uid 10001 pantry
USER 10001
CMD ["bash", "startup.sh"]
