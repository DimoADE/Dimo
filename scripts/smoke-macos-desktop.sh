#!/usr/bin/env bash
set -euo pipefail

app_path="${1:?usage: smoke-macos-desktop.sh <app-bundle>}"
if [[ -x "$app_path/Contents/MacOS/Dimo" ]]; then
  executable="$app_path/Contents/MacOS/Dimo"
elif [[ -x "$app_path/Contents/MacOS/dimo" ]]; then
  executable="$app_path/Contents/MacOS/dimo"
else
  echo "macOS app executable is missing under $app_path/Contents/MacOS/" >&2
  exit 1
fi

log_file="${RUNNER_TEMP:-/tmp}/dimo-macos-startup.log"
temp_data_dir=""
if [[ "${DIMO_ELECTRON_SMOKE:-0}" = "1" ]]; then
  temp_data_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dimo-macos-smoke.XXXXXX")"
  export DIMO_DATA_DIR="$temp_data_dir"
  export DIMO_ALLOW_MULTI_INSTANCE="1"
fi

"$executable" >"$log_file" 2>&1 &
app_pid=$!

cleanup() {
  if kill -0 "$app_pid" 2>/dev/null; then
    kill -TERM "$app_pid" 2>/dev/null || true
    for _ in {1..10}; do
      if ! kill -0 "$app_pid" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    if kill -0 "$app_pid" 2>/dev/null; then
      kill -KILL "$app_pid" 2>/dev/null || true
    fi
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n "$temp_data_dir" && -d "$temp_data_dir" ]]; then
    rm -rf "$temp_data_dir"
  fi
}
trap cleanup EXIT

if [[ "${DIMO_ELECTRON_SMOKE:-0}" = "1" ]]; then
  for _ in {1..90}; do
    if ! kill -0 "$app_pid" 2>/dev/null; then
      if wait "$app_pid"; then
        cat "$log_file"
        exit 0
      else
        cat "$log_file"
        echo "Dimo Electron macOS smoke test failed." >&2
        exit 1
      fi
    fi
    sleep 0.5
  done
  cat "$log_file"
  echo "Dimo Electron macOS smoke test timed out." >&2
  exit 1
fi

sleep 8
if ! kill -0 "$app_pid" 2>/dev/null; then
  cat "$log_file"
  echo "Dimo exited during the macOS startup smoke test." >&2
  exit 1
fi
