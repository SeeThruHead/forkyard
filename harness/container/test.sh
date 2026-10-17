#!/bin/sh
set -u
forkyard daemon > /tmp/daemon.log 2>&1 &
i=0; until forkyard status >/dev/null 2>&1 || [ $i -ge 60 ]; do sleep 1; i=$((i+1)); done
forkyard up --branch main
echo "--- api through the proxy"; curl -s http://api.main.boxed.localhost/health; echo
echo "--- web calling api by its routed name"; curl -s http://web.main.boxed.localhost/; echo
echo "--- getent api.main.boxed.localhost"; getent hosts api.main.boxed.localhost || echo "does not resolve"
echo "--- daemon log tail"; tail -5 /tmp/daemon.log
