import os
import re
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
SESSION_IDLE_SECONDS = 90 * 86400
SESSION_ABSOLUTE_SECONDS = 180 * 86400
INVITE_SECONDS = 7 * 86400
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
ENTRA_SETTINGS = ("ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET", "ENTRA_REDIRECT_URI")
GCS_BUCKET = re.compile(r"[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]")
GCP_PROJECT = re.compile(r"[a-z][a-z0-9-]{4,28}[a-z0-9]")
GCP_LOCATION = re.compile(r"global|[a-z]+-[a-z]+[0-9]+")
GEMINI_MODEL = re.compile(r"[a-z0-9][a-z0-9.-]{0,80}")


def production():
    # Either setting enables the guardrails; a conflicting/new setting must not
    # weaken an existing NODE_ENV=production deployment during cutover.
    return os.getenv("APP_ENV") == "production" or os.getenv("NODE_ENV") == "production"


def on_cloud_run():
    # Cloud Run sets K_SERVICE in every container it starts.
    return bool(os.getenv("K_SERVICE"))


def entra_requested():
    # Microsoft sign-in is optional: off when none of its settings are present.
    return any(os.getenv(name, "").strip() for name in ENTRA_SETTINGS)


def data_directory():
    if os.getenv("PANTRY_DATA_DIR"):
        return Path(os.environ["PANTRY_DATA_DIR"]).resolve()
    legacy = ROOT / "server" / "data"
    modern = ROOT / "backend" / "data"
    # Source-preserving compatibility: never silently initialize an empty pantry
    # beside the old database, signing secret, receipts or MVP backup.
    return legacy if legacy.exists() else modern


def validate_model_config():
    project, location = os.getenv("VERTEX_PROJECT", "").strip(), os.getenv("VERTEX_LOCATION", "").strip()
    if not project and not location:
        return
    if not GCP_PROJECT.fullmatch(project) or not GCP_LOCATION.fullmatch(location):
        raise ValueError("Gemini needs a valid VERTEX_PROJECT and VERTEX_LOCATION.")
    for name in ("GEMINI_CHAT_MODEL", "GEMINI_RECEIPT_MODEL"):
        value = os.getenv(name, "").strip().removeprefix("google/")
        if value and not GEMINI_MODEL.fullmatch(value):
            raise ValueError(f"{name} is not a valid Gemini model id.")


def validate_production_config():
    if not production():
        return
    origin = urlsplit(os.getenv("APP_ORIGIN", ""))
    if origin.scheme != "https" or not origin.netloc or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ("", "/"):
        raise ValueError("Production APP_ORIGIN must be an HTTPS origin without a path.")
    if len(os.getenv("SESSION_SECRET", "")) < 48:
        raise ValueError("Production requires a random SESSION_SECRET of at least 48 characters.")
    if os.getenv("PANTRY_SEED") == "fixtures":
        raise ValueError("Fixture data is forbidden in production.")
    if not os.getenv("DATABASE_URL"):
        raise ValueError("Production requires DATABASE_URL for PostgreSQL.")
    if not re.match(r"^postgres(ql)?://", os.environ["DATABASE_URL"]):
        raise ValueError("DATABASE_URL must point to PostgreSQL.")
    if not GCS_BUCKET.fullmatch(os.getenv("GCS_RECEIPTS_BUCKET", "")):
        raise ValueError("Production requires GCS_RECEIPTS_BUCKET for private receipt storage.")
    validate_model_config()
    if not entra_requested():
        # Email and password only. The first Super Admin signs in with the
        # one-time BOOTSTRAP_SUPERADMIN_PASSWORD (see core.seed_production).
        return
    for name in ["ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "SEED_SUPERADMIN_OBJECT_ID"]:
        if not UUID.fullmatch(os.getenv(name, "")):
            raise ValueError(f"Production requires {name}.")
    if len(os.getenv("ENTRA_CLIENT_SECRET", "")) < 10 or os.getenv("ENTRA_REDIRECT_URI") != f"https://{origin.netloc}/api/auth/callback":
        raise ValueError("Production requires valid Microsoft credentials and the exact HTTPS callback URL.")
