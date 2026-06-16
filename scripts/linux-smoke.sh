#!/usr/bin/env bash
# Linux glibc container smoke for the beta-hardening fixes. Builds the
# linux-arm64 binary natively, runs the daemon, and checks health, the
# /api/shutdown route, git-based capture resolution (#3), and the cooperative
# drain (#4). Invoked inside a node:22-bookworm container by the host.
set -euo pipefail
cd /work
export DEBIAN_FRONTEND=noninteractive

echo "=== toolchain ==="
apt-get update -qq >/dev/null && apt-get install -y -qq build-essential git curl ca-certificates >/dev/null
curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
export PATH="$HOME/.bun/bin:$PATH"
echo "node $(node -v) | bun $(bun -v) | gcc $(gcc -dumpversion) | $(git --version)"

echo "=== npm ci ==="
npm ci --no-audit --no-fund >/tmp/npmci.log 2>&1 || { echo "npm ci FAILED:"; tail -30 /tmp/npmci.log; exit 1; }

echo "=== build team + collective + myco (linux-arm64) ==="
npm run build -w @goondocks/myco-team >/tmp/team.log 2>&1 || { tail -20 /tmp/team.log; exit 1; }
npm run build -w @goondocks/myco-collective >/tmp/collective.log 2>&1 || { tail -20 /tmp/collective.log; exit 1; }
cd packages/myco
npx tsx scripts/gen-hook-config.ts
bash scripts/build-libsqlite3-target.sh linux-arm64
TARGET=linux-arm64 node scripts/build-single-target.mjs
node scripts/select-binary.mjs
cd /work
BIN=/work/packages/myco-linux-arm64/bin/myco
echo "built: $("$BIN" --version 2>&1 | head -1)"

echo "=== run daemon in a git project (exercises #3 git resolution on the capture path) ==="
mkdir -p /testproj && cd /testproj
git init -q && git config user.email t@t.t && git config user.name t && git commit --allow-empty -qm init
export MYCO_HOME=/root/.myco
"$BIN" daemon >/tmp/daemon.log 2>&1 &
PORT=""
for i in $(seq 1 40); do
  sleep 1
  DJ=$(find /root/.myco -name daemon.json 2>/dev/null | head -1) || true
  [ -z "$DJ" ] && continue
  P=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$DJ','utf8')).port)}catch(e){}" 2>/dev/null) || true
  [ -z "$P" ] && continue
  if curl -sf -m2 "http://127.0.0.1:$P/health" >/dev/null 2>&1; then PORT="$P"; break; fi
done
if [ -z "$PORT" ]; then echo "FAIL: daemon not healthy in 40s"; tail -30 /tmp/daemon.log; exit 1; fi
echo "HEALTHY: $(curl -s http://127.0.0.1:$PORT/health)"
echo "GET /api/shutdown -> $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/api/shutdown) (405 = route present, POST-only)"
echo "GET /ready -> $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/ready)"

echo "=== doctor ==="
"$BIN" doctor 2>&1 | grep -iE "vault|database|capture|daemon|git|hook|symbiont|service" | head -15 || true

echo "=== cooperative shutdown (POST /api/shutdown) ==="
echo "POST -> $(curl -s -X POST http://127.0.0.1:$PORT/api/shutdown)"
sleep 3
if curl -sf -m2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then echo "still up (FAIL)"; else echo "drained + exited (PASS)"; fi
grep -iE "shutdown-request received|Lifecycle lock released|Server stopped|drain at shutdown" /tmp/daemon.log | tail -6 || true
echo "=== LINUX SMOKE DONE ==="
