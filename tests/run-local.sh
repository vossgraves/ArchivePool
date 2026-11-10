#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
set -euo pipefail
export TMPDIR=/data/workspace/tmp
mkdir -p "$TMPDIR"
if [ "$(df --output=avail -k /data | tail -1)" -lt 409600 ]; then
  echo 'Less than 400 MB free on /data; refusing to start the database harness.' >&2
  exit 1
fi
fixture_container="ap-limits-test-$$"
trap 'docker rm -f "$fixture_container" >/dev/null 2>&1 || true' EXIT INT TERM
docker run -d --name "$fixture_container" -e POSTGRES_PASSWORD=local-test-fixture -e POSTGRES_DB=archivepool -p 127.0.0.1::5432 postgres:16-alpine >/dev/null
fixture_port=$(docker port "$fixture_container" 5432/tcp | awk -F: '{print $NF}')
export TEST_DATABASE_URL="postgresql://postgres:local-test-fixture@127.0.0.1:$fixture_port/archivepool"
for attempt in {1..30}; do
  if docker exec "$fixture_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
if [ "$#" -gt 0 ]; then "$@"; else npm run test:limits; fi
