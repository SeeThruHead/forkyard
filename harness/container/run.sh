#!/bin/sh
set -eu
cd "$(dirname "$0")"
rm -f forkyard.tgz
pnpm --dir ../.. pack --pack-destination "$PWD" >/dev/null
mv forkyard-*.tgz forkyard.tgz
docker build -q -t forkyard-container-test . >/dev/null
docker run --rm -v "$PWD/test.sh:/test.sh:ro" forkyard-container-test /test.sh
