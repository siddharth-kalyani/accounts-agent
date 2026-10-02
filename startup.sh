#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PYTHONPATH="$PWD/backend${PYTHONPATH:+:$PYTHONPATH}"
# Cloud Run sets PORT (8080); 8000 is only a fallback for other hosts.
export PORT="${PORT:-8000}"
exec python -m pantry
