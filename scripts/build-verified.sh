#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

# GNU timeout keeps CI builds bounded. macOS ships neither `timeout` nor
# `gtimeout` by default, so fall back to an unbounded build rather than
# failing the whole verify gate on a developer machine.
timeout_bin=""
if command -v timeout >/dev/null 2>&1; then
  timeout_bin="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
  timeout_bin="gtimeout"
fi

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

if [[ -n "${timeout_bin}" ]]; then
  echo "Running bounded vinext build..."
  "${timeout_bin}" \
    --signal=TERM \
    --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" \
    "${SITES_BUILD_TIMEOUT:-3m}" \
    "${vinext}" build
else
  echo "Warning: GNU timeout/gtimeout not found; running vinext build without a bounded timeout." >&2
  echo "Running unbounded vinext build..."
  "${vinext}" build
fi
