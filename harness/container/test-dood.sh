#!/bin/sh
set -u
forkyard daemon > /tmp/daemon.log 2>&1 &
i=0; until forkyard status >/dev/null 2>&1 || [ $i -ge 90 ]; do sleep 1; i=$((i+1)); done
forkyard up --branch main
echo "--- api reading the host-side Postgres"; curl -s http://api.main.boxedpg.localhost/; echo
echo "--- containers this daemon started on the host's Docker"; docker ps --format '{{.Names}}  {{.Ports}}' | grep forkyard-dood
forkyard down >/dev/null
echo "--- daemon log"; grep -E "ERROR" /tmp/daemon.log | cut -c1-160
