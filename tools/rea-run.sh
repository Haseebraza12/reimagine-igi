#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export GHIDRA_INSTALL_DIR="${GHIDRA_INSTALL_DIR:-$task_root/tools/native/ghidra_12.1.4_PUBLIC}"
if [[ -z "${JAVA_HOME:-}" ]]; then
  if [[ -x "$task_root/tools/native/jdk-21/bin/javac" ]]; then
    export JAVA_HOME="$task_root/tools/native/jdk-21"
  elif [[ -x /usr/lib/jvm/java-21-openjdk-amd64/bin/javac ]]; then
    export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
  else
    echo "Set JAVA_HOME to a full JDK 21 or newer (including bin/javac)." >&2
    exit 1
  fi
fi
export REA_GHIDRA_STARTUP_TIMEOUT_MS="${REA_GHIDRA_STARTUP_TIMEOUT_MS:-300000}"
exec "$task_root/tools/rea/node_modules/.bin/rea" "$@"
