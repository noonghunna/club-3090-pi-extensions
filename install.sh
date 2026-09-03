#!/usr/bin/env bash
# Install the qwen-quota (ModelScope magicube) statusline extension for pi and/or omp.
#
#   ./install.sh            install for whichever agent(s) are detected
#   ./install.sh --extras   also copy the optional pi-only extras
#   ./install.sh --pi       only pi
#   ./install.sh --omp      only omp
#
# Nothing here needs root; files are copied into the agent extension dirs.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${HOME}/.pi/agent/extensions"
OMP_DIR="${HOME}/.omp/agent/extensions"

WANT_PI=false WANT_OMP=false WANT_EXTRAS=false
for arg in "$@"; do
  case "$arg" in
    --pi) WANT_PI=true ;;
    --omp) WANT_OMP=true ;;
    --extras) WANT_EXTRAS=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Default: autodetect whichever agent is installed.
if ! $WANT_PI && ! $WANT_OMP; then
  WANT_PI=false; WANT_OMP=false
  command -v pi >/dev/null 2>&1 && WANT_PI=true
  command -v omp >/dev/null 2>&1 && WANT_OMP=true
  if ! $WANT_PI && ! $WANT_OMP; then
    echo "Neither pi nor omp found on PATH; use --pi and/or --omp to force." >&2
    exit 1
  fi
fi

copy() { # copy <src> <dst-dir>
  mkdir -p "$2"
  cp "$1" "$2/"
  echo "  installed: $2/$(basename "$1")"
}

if $WANT_PI; then
  echo "pi:"
  copy "$REPO_DIR/extensions/qwen-quota/pi/qwen-quota.ts" "$PI_DIR"
  if $WANT_EXTRAS; then
    for f in "$REPO_DIR"/extras/*.ts; do copy "$f" "$PI_DIR"; done
  fi
fi

if $WANT_OMP; then
  echo "omp:"
  copy "$REPO_DIR/extensions/qwen-quota/omp/qwen-quota.ts" "$OMP_DIR"
  $WANT_EXTRAS && echo "  (extras are pi-only; skipped for omp)"
fi

echo
echo "Done. Restart the agent (or run /reload) and select a ModelScope model."
