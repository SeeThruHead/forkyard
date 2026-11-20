#!/bin/sh
set -eu

if ! command -v bun >/dev/null 2>&1; then
  echo "Building forkyard's dashboard needs Bun, and bun is not on PATH. Install it from https://bun.sh and install again." >&2
  exit 1
fi

bun build dashboard/src/main.tsx --outdir dashboard/dist --target browser --minify
cp dashboard/index.html dashboard/dist/index.html
