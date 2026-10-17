#!/bin/sh
set -u
dockerd > /tmp/dockerd.log 2>&1 &
i=0; until docker info >/dev/null 2>&1 || [ $i -ge 60 ]; do sleep 1; i=$((i+1)); done
echo "--- inner docker engine: $(docker info --format '{{.ServerVersion}}')"
forkyard daemon > /tmp/daemon.log 2>&1 &
i=0; until forkyard status >/dev/null 2>&1 || [ $i -ge 180 ]; do sleep 1; i=$((i+1)); done
forkyard up --branch main
echo "--- api reading Postgres that runs inside this container's own Docker"; curl -s http://api.main.boxedpg.localhost/; echo
echo "--- containers on the inner engine"; docker ps --format '{{.Names}}  {{.Ports}}'
echo "--- daemon errors"; grep -E "ERROR|WARN" /tmp/daemon.log | cut -c1-200 | head -5
