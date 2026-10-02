"""Start one API process. Use --reload only for local development."""
import argparse
import os
import socket
from dotenv import load_dotenv
import uvicorn
from .config import ROOT, on_cloud_run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    os.environ.pop("NODE_TLS_REJECT_UNAUTHORIZED", None)
    # Cloud Run delivers requests to the container's network interface.
    host = "0.0.0.0" if on_cloud_run() else os.getenv("PANTRY_HOST") or "127.0.0.1"
    port = int(os.getenv("PORT") or 8787)
    if port == 0:
        # Isolated end-to-end tests: pick a free port. uvicorn's fd= option needs AF_UNIX, which Windows lacks.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((host, 0))
            port = probe.getsockname()[1]
    print(f"Pantry API on http://{host}:{port}", flush=True)
    uvicorn.run("pantry.app:app", host=host, port=port, reload=args.reload, reload_dirs=[str(ROOT / "backend" / "pantry")] if args.reload else None,
                workers=1, proxy_headers=False, server_header=False, access_log=False, timeout_keep_alive=5, timeout_graceful_shutdown=10)


if __name__ == "__main__":
    main()
