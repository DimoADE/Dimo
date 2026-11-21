#!/usr/bin/env bash
set -euo pipefail

executable="${1:?usage: smoke-linux-desktop.sh <executable>}"
if [[ ! -x "$executable" ]]; then
  echo "Desktop executable is missing or not executable: $executable" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace="$(cd "$script_dir/.." && pwd)"
executable_dir="$(cd "$(dirname "$executable")" && pwd)"
export LD_LIBRARY_PATH="${executable_dir}:${workspace}/target/release${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

log_file="${RUNNER_TEMP:-/tmp}/dimo-linux-startup.log"

if [[ "${DIMO_ELECTRON_SMOKE:-0}" = "1" ]]; then
  temp_data_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dimo-linux-smoke.XXXXXX")"
  trap 'rm -rf "$temp_data_dir"' EXIT
  export DIMO_DATA_DIR="$temp_data_dir"
  export DIMO_ALLOW_MULTI_INSTANCE="1"
  set +e
  timeout --signal=TERM 45s xvfb-run -a "$executable" --no-sandbox --disable-gpu >"$log_file" 2>&1
  exit_code=$?
  set -e
  cat "$log_file"
  if [[ "$exit_code" -ne 0 ]]; then
    echo "Dimo Electron Linux smoke test failed (code $exit_code)." >&2
    exit 1
  fi
  exit 0
fi

set +e
GDK_BACKEND=x11 timeout --signal=TERM 10s xvfb-run -a "$executable" >"$log_file" 2>&1
exit_code=$?
set -e

if [[ "$exit_code" -ne 124 && "$exit_code" -ne 143 ]]; then
  cat "$log_file"
  echo "Dimo exited during the Linux desktop startup smoke test (code $exit_code)." >&2
  exit 1
fi

