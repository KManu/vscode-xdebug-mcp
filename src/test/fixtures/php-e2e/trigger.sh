#!/bin/bash
# Trigger script for E2E tests — waits for VS Code debug listener, then runs PHP.
# Runs in a loop: waits for listener → runs PHP → waits again.
# This supports multiple debug sessions (one per E2E test).

HOST="${XDEBUG_CLIENT_HOST:-host.docker.internal}"
PORT="${XDEBUG_CLIENT_PORT:-9003}"

echo "[trigger] Watching for debug listener at ${HOST}:${PORT}..."

while true; do
  # Wait for debug listener
  while true; do
    if timeout 1 bash -c "echo >/dev/tcp/${HOST}/${PORT}" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  echo "[trigger] Debug listener ready — running PHP in 3s"
  sleep 3
  php /app/scripts/test.php
  echo "[trigger] PHP done — waiting for next session..."
  sleep 2
done
