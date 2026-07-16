#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "RepoRoo requires Node.js 22 or newer."
  exit 1
fi

npm ci
npm run setup
