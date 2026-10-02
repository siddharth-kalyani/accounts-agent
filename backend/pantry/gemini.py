"""Gemini on Google Cloud (Agent Platform, formerly Vertex AI).

Calls use the OpenAI-compatible chat completions endpoint, so the request and
streaming shapes stay the same as before. There is no API key: the running
service account's short-lived Google token is sent instead.
"""
import asyncio
import os
import threading
from .config import GCP_LOCATION, GCP_PROJECT, GEMINI_MODEL

SCOPE = "https://www.googleapis.com/auth/cloud-platform"
CHAT_MODEL = "gemini-3.1-flash-lite"
RECEIPT_MODEL = "gemini-3.8-flash"
# Gemini 3 thinks at "high" unless told otherwise; low keeps replies quick.
EFFORTS = {"minimal", "low", "medium", "high"}
_lock = threading.Lock()
_credentials = None


def settings():
    project, location = os.getenv("VERTEX_PROJECT", "").strip(), os.getenv("VERTEX_LOCATION", "").strip()
    if not GCP_PROJECT.fullmatch(project) or not GCP_LOCATION.fullmatch(location):
        return None
    return project, location


def configured():
    return settings() is not None


def completions_url():
    project, location = settings()
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return f"https://{host}/v1beta1/projects/{project}/locations/{location}/endpoints/openapi/chat/completions"


def _model(name, default):
    value = os.getenv(name, "").strip().removeprefix("google/")
    return "google/" + (value if GEMINI_MODEL.fullmatch(value) else default)


def chat_model():
    return _model("GEMINI_CHAT_MODEL", CHAT_MODEL)


def receipt_model():
    return _model("GEMINI_RECEIPT_MODEL", RECEIPT_MODEL)


def reasoning_effort():
    value = os.getenv("GEMINI_REASONING_EFFORT", "").strip().lower()
    return value if value in EFFORTS else "low"


def _token():
    global _credentials
    with _lock:
        if _credentials is None:
            import google.auth
            _credentials, _ = google.auth.default(scopes=[SCOPE])
        if not _credentials.valid:
            from google.auth.transport.requests import Request
            _credentials.refresh(Request())
        return _credentials.token


async def headers():
    token = await asyncio.to_thread(_token)
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
