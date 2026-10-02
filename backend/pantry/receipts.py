"""Private, immutable local/Google Cloud Storage receipt objects (bounded to 10 MB on upload)."""
import asyncio
import os
import re
from pathlib import Path
from google.api_core.exceptions import PreconditionFailed
from google.cloud import storage
from .config import data_directory
from .compat import text


def safe_blob_name(name):
    if not isinstance(name, str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,160}", name) or name in (".", ".."):
        raise ValueError("Invalid receipt storage name.")
    return name


def safe_receipt_name(name, fallback):
    return re.sub(r"[^A-Za-z0-9._ -]", "", Path(text(name or fallback)).name)[:120] or fallback


def sniff_receipt(data):
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    return ""


def receipts_bucket():
    return os.getenv("GCS_RECEIPTS_BUCKET", "").strip()


def _gcs_client():
    # Application Default Credentials: the Cloud Run service account in
    # production, or an operator's own gcloud login for an explicit migration.
    return storage.Client()


def _store(name, data, content_type):
    if receipts_bucket():
        client = _gcs_client()
        try:
            blob = client.bucket(receipts_bucket()).blob(name)
            blob.cache_control = "no-store"
            blob.content_disposition = "attachment"
            try:
                # Generation 0 means "only if no object has this name": never overwrite.
                blob.upload_from_string(data, content_type=content_type, if_generation_match=0, timeout=20)
            except PreconditionFailed:
                raise FileExistsError(name) from None
        finally:
            client.close()
        return
    directory = data_directory() / "receipts"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
        output.write(data)


async def store_receipt(name, data, content_type):
    safe_blob_name(name)
    await asyncio.to_thread(_store, name, data, content_type)


def _read(name):
    if receipts_bucket():
        client = _gcs_client()
        try:
            return client.bucket(receipts_bucket()).blob(name).download_as_bytes(timeout=20)
        finally:
            client.close()
    return (data_directory() / "receipts" / name).read_bytes()


async def read_receipt(name):
    safe_blob_name(name)
    return await asyncio.to_thread(_read, name)
