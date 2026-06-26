---
name: myco:capture-pipeline-durability
description: |
  Implement capture pipeline resilience patterns and detect silent failure modes
  in the Myco daemon. Covers identifying when capture hooks fail silently while
  the daemon appears healthy, diagnosing liveness vs readiness issues, implementing
  service-manager-aware recovery patterns with capturePost(), and debugging capture
  ingestion delays. Essential for maintaining reliable session/prompt/event capture
  even when the daemon process is alive but routed endpoints are wedged.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Capture Pipeline Durability and Silent Failure Detection

The Myco capture pipeline can fail silently while the daemon appears healthy—sessions buffer durably but aren't ingested until manual restart. This skill covers detecting these failure modes, diagnosing root causes using four-layer architecture, and implementing resilient recovery patterns for managed daemon services.

## Prerequisites

- Myco daemon running as a managed service (launchd/systemd)
- Understanding of capture hook flow: client → daemon → ingestion → DB
- Access to daemon logs and buffer directories (`.myco/buffer/`)
- Access to `~/.claude/projects/<project>/<session>.jsonl` transcript files
- Familiarity with MCP bridge architecture (agent→MCP→daemon via stdio)

## Procedure 1: Detecting Silent Capture Failures

**Symptoms to watch for:**
- Sessions show in `.myco/buffer/` but not in daemon logs
- `/health` returns 200 OK but capture events aren't processed
- Manual daemon restart suddenly processes queued events
- Capture hooks time out while other daemon endpoints work

**Detection steps:**

0. **Check `~/.myco/logs/launcher.log` first:**
   The global launcher appends a timestamped one-line record to this file on every hook launch failure (ENOENT, signal kills, path-resolution errors, binary exec errors). This is the fastest way to rule out hook-layer failure before inspecting daemon internals. If the file is absent, zero hook launch failures have occurred — the hook is reaching the daemon. If entries are present, diagnose the launch error before proceeding to daemon-side checks.

1. **Check daemon health vs readiness:**
   ```bash
   # Liveness check - should respond quickly
   curl -s http://localhost:20915/health

   # Readiness check - tests full routing stack
   curl -s -H "X-Myco-Context: project:your-project,grove:your-grove" \
        http://localhost:20915/ready
   ```

2. **Compare buffer contents to daemon ingestion:**
   ```bash
   # Check for unbuffered events
   find .myco/buffer -name "*.json" -mmin -10

   # Check daemon logs for corresponding ingestion
   tail -n 50 .myco/logs/daemon.log | grep -E "(session|prompt|event)"
   ```

3. **Verify capture hook routing:**
   ```bash
   # Test a capture-critical endpoint
   curl -s -X POST -H "Content-Type: application/json" \
        -H "X-Myco-Context: project:your-project,grove:your-grove" \
        -d '{"test": true}' \
        http://localhost:20915/sessions/register
   ```

**Key insight:** A daemon can pass `/health` (raw liveness) while failing `/ready` (routed readiness). The split exists because `/health` bypasses routing middleware while capture endpoints traverse the full request stack.

## Procedure 2: Diagnosing Failure Modes with Three-Tier Daemon.lock Discovery

**Three-tier discovery pattern:**
The daemon discovery system uses three tiers to locate and validate daemon.lock:

1. **Tier 1 — Explicit Path Resolution:**
   - Check `MYCO_DAEMON_LOCK` environment variable (if set)
   - Check `.myco/daemon.lock` in current grove

2. **Tier 2 — Grove-Scoped Search:**
   - Walk up directory tree from current project
   - Match groove directory structure
   - Validate grove ownership and permissions

3. **Tier 3 — Global Machine Scan:**
   - Scan `~/.myco/daemons/` for all machine-registered daemons
   - Select daemon matching project context
   - Fall back to default if ambiguous

**Liveness vs Readiness failure patterns:**

1. **Process dead (both fail):**
   - `/health` → connection refused
   - `/ready` → connection refused
   - **Recovery:** Standard daemon restart

2. **Process alive, routing wedged (liveness passes, readiness fails):**
   - `/health` → 200 OK (responds immediately)
   - `/ready` → timeout/hang (never responds)
   - **Recovery:** Service manager restart required

3. **Context misconfiguration:**
   - `/health` → 200 OK
   - `/ready` → 401 unauthorized context switch
   - **Recovery:** Fix Grove/project context headers

**Diagnostic commands:**

```bash
# Check if daemon process is running
ps aux | grep myco-daemon

# Check daemon.lock location
cat .myco/daemon.lock  # or wherever Tier 1/2/3 resolves it

# Check port binding
lsof -i :20915

# Check managed service status
# macOS:
launchctl list | grep myco
# Linux:
systemctl status myco-daemon

# Check for routing stack wedge
timeout 5s curl -H "X-Myco-Context: project:test,grove:test" \
  http://localhost:20915/ready
```

## Procedure 3: Implementing Recovery Patterns with Decoupled Self-Reconcile

**For capture-critical hooks, always use `capturePost()` instead of raw `post()`:**

```typescript
// ❌ Fragile - no managed service recovery
await client.post('/events', {
  kind: 'prompt',
  data: promptData
});

// ✅ Resilient - triggers service restart on failure
await client.capturePost('/events', {
  kind: 'prompt',
  data: promptData
});
```

**Capture hooks that need `capturePost()`:**
- Session register (`/sessions/register`)
- Prompt submit (`/events` with `prompt` kind)
- Tool use (`/events` with `tool_use` kind)
- Generic event send (`/events` with other kinds)
- Session stop (`/events/stop`)

**Non-capture hooks keep ordinary `post()`:**
- Health checks, context switches, stats reads
- These get basic `spawnDaemon()` recovery, appropriate for unmanaged daemons

**Self-reconcile architecture:**
Self-reconciliation is now decoupled from PowerManager scheduling. It is started via `startSelfReconcileLoop` in `packages/myco/src/daemon/self-reconcile-wiring.ts` on a dedicated interval:

```typescript
// packages/myco/src/daemon/self-reconcile-wiring.ts
const SELF_RECONCILE_INTERVAL_MS = 30_000;

// started in daemon main.ts:
const selfReconcileLoop = startSelfReconcileLoop(logger, { ... });
// runs every SELF_RECONCILE_INTERVAL_MS — not co-scheduled with PowerManager
```

**Key differences from previous pattern:**
- **Not co-scheduled** with PowerManager tick events
- **Runs continuously** even when PowerManager tasks are disabled
- **Independent failure recovery** without PowerManager intervention
- **Configurable interval** per Grove (no longer fixed at daemon startup)

**Implementation in `packages/myco/src/hooks/client.ts`:**

`DaemonClient.capturePost()` wraps `postWithRecovery` with `{ captureCritical: true }`, which triggers service manager restart (not just `spawnDaemon()`) when the managed daemon is alive but wedged.

**Key pattern:** For managed services (launchd/systemd), `spawnDaemon()` is ineffective on a live-but-stuck daemon. Recovery must go through `ServiceManager.restart()` with coalescing to prevent restart storms.

## Procedure 4: Manual Recovery and Debugging

**When capture is stuck but daemon appears healthy:**

1. **Force service restart (preferred):**
   ```bash
   # macOS:
   launchctl kickstart -k system/com.myco.daemon

   # Linux:
   sudo systemctl restart myco-daemon
   ```

2. **Verify recovery:**
   ```bash
   # Should process buffered events after restart
   tail -f .myco/logs/daemon.log

   # Buffer should clear
   find .myco/buffer -name "*.json"
   ```

3. **Multi-daemon environment gotcha:**
   On machines with both dev and prod daemons, ensure you're targeting the correct service variant:
   ```bash
   # Check which daemon serves your Grove
   myco status | grep "served_by"

   # Verify port ownership
   lsof -i :19344  # dev daemon
   lsof -i :20915  # prod daemon
   ```

**MCP bridge recovery:**
If using MCP and the daemon restarts mid-session, the bridge loses connection and cannot auto-reconnect:

1. **Preferred:** Reconnect MCP server via symbiont UI (Claude Code "reconnect MCP server")
2. **Alternative:** Restart the agent session entirely
3. **Fallback:** Use CLI commands (`myco-dev tool call <tool>`)

## Procedure 5: Four-Layer Incident Diagnosis

When capture appears degraded (incomplete sessions, missing prompts, tool call failures), systematically diagnose using the four-layer model:

### Layer 1: Hook Diagnosis
**Question:** Did the hook fire and reach the daemon?

**Error semantics:**
- **transport-failure**: Network/socket level issue (daemon unreachable, connection reset, timeout)
- **http-error**: HTTP-level failure (4xx/5xx response, routing middleware rejected request)
- **daemon-ignored**: Daemon received but intentionally filtered (rule-based drops, phantom defense)

```bash
# Check buffer observability (post-v0.27.17)
grep -E "\[(transport-failure|http-error|daemon-ignored)\]" ~/.myco/daemon-*/logs/daemon.err.log | tail -20

# Interpret error types:
# - transport-failure → network/daemon connectivity issue
# - http-error → routing/authentication issue
# - daemon-ignored → rule-based filtering (expected behavior)
# - No entries but session active → hook not firing
```

**Recovery:** Check daemon health, restart daemon if unresponsive.

### Layer 2: Buffer Diagnosis
**Question:** Did events land in the on-disk buffer?

```bash
# Compare buffer growth vs transcript growth
ls -la .myco/buffer/
tail ~/.claude/projects/<project>/<session>.jsonl

# If transcript growing but buffer static → hook layer failure
# If both growing → check memory layer
```

**Recovery:** Buffer is the durable fallback. Events here can be replayed.

### Layer 3: Memory Diagnosis
**Question:** Is the session in daemon's in-memory registry?

**Important:** Memory is diagnostic only, never authoritative for writes. Use to understand state, not make decisions.

```bash
# Check daemon session registry
curl http://localhost:<daemon-port>/debug/sessions | jq '.sessions | keys'
```

### Layer 4: Database Diagnosis
**Question:** Did events persist to database?

```bash
# Check for FOREIGN KEY constraint failures
grep "FOREIGN KEY constraint failed" ~/.myco/daemon-*/logs/daemon.err.log

# If FK errors → session row missing (see recovery below)
# Verify session exists in vault
sqlite3 ~/.myco/vault/myco.db "SELECT id, title FROM sessions WHERE id = '<session-id>';"
```

**Recovery:** Session row missing requires transcript replay through stop route.

## Procedure 6: MCP Bridge Recovery

When tool calls hang or MCP connections fail, the issue is often stale stdio bridges or daemon restarts.

### Stale Child Detection
MCP bridges use stdio (JSON-RPC), not HTTP. Stale children persist with dead pipes.

```bash
# Find stale myco-run mcp processes
ps aux | grep "myco-run mcp" | grep -v grep

# Check process parent (should not be PID 1)
ps -o pid,ppid,cmd | grep "myco-run mcp"

# If ppid=1, process is orphaned → kill it
kill <stale-pid>
```

**Architecture:** A ppid watchdog auto-detects orphans. If seeing 21+ hour old processes, the watchdog isn't running.

### Daemon Restart Detection
After daemon restart, MCP bridges retain stdio to the old process.

```bash
# Check daemon uptime vs bridge connection age
curl http://localhost:<daemon-port>/health

# If tool calls hang after daemon restart:
# 1. Kill stale bridge processes
pkill -f "myco-run mcp"

# 2. Next agent tool call will respawn fresh bridge
# 3. Fresh bridge reads new daemon.json (new port)
```

**Expected recovery time:** ~60s from daemon restart once the bridge heartbeat notices the change.

### MCP Observability
Every state transition logs to stderr:

```bash
# Check MCP bridge state transitions
grep -E "(watchdog|heartbeat|bridge)" ~/.myco/agent/logs/mcp-stderr.log

# Look for: ppid changes, health check failures, clean exits
```

## Procedure 7: Stop Event Recovery

When sessions appear captured but prompt content is incomplete, the stop route likely wasn't invoked.

### Symptoms
- Session row exists in database
- Some prompt batches present
- Prompt content truncated or missing
- Screenshots/attachments not processed

### Root Cause
Stop events posted to wrong route (`POST /events` instead of `POST /events/stop`).

### Recovery Path
```bash
# Authoritative transcripts are always on-disk
ls ~/.claude/projects/<project>/<session>.jsonl

# Replay transcript through correct stop route
curl -X POST http://localhost:<daemon-port>/events/stop \
  -H "Content-Type: application/json" \
  -d @transcript-stop-payload.json

# This triggers transcript mining: screenshot extraction,
# full prompt content, attachment processing
```

**Key insight:** `/events` does lightweight registration, `/events/stop` does enriched processing.

## Procedure 8: Hook Double-Fire Deduplication

When seeing duplicate prompt_batch rows (e.g., prompt_number 47 and 48 for same physical prompt), hook double-fire is overwhelming dedup.

### Diagnosis
```bash
# Check for duplicate prompt numbers in same session
sqlite3 ~/.myco/vault/myco.db "
SELECT session_id, prompt_number, COUNT(*)
FROM prompt_batches
WHERE session_id = '<session-id>'
GROUP BY session_id, prompt_number
HAVING COUNT(*) > 1;"
```

### Architecture Context
Double-fire hooks are **normal and expected**. Symbionts and agents consume hook configuration from multiple sources. The system must accommodate this architecturally.

### Content-Keyed Convergence Model
Buffer replay was rebuilt from count-based divergence to **content-keyed convergence**: buffered events are matched against existing DB records using a stable fingerprint key. Replay is idempotent — replaying the same event twice produces one record, not two.

```typescript
// packages/myco/src/capture/dedup.ts
export const EVENT_DEDUP_WINDOW_MS = 10_000;

// eventDedupKey produces a stable fingerprint for both live dispatch and replay
export function eventDedupKey(event): string { ... }

// Both live dispatcher (packages/myco/src/daemon/event-dispatch.ts) and
// buffer replay (packages/myco/src/daemon/reconciliation.ts) use the same key.
// Replay = convergence, not appending: match-and-consume, not slice-and-insert.
const key = eventDedupKey(event);
```

**Key facts:**
- Both live dispatch and buffer replay paths use the same `eventDedupKey`
- The dedup window is `EVENT_DEDUP_WINDOW_MS = 10_000` (10 seconds)
- `TOMBSTONE_RETENTION_MS` (14 days, `packages/myco/src/constants.ts`) — deleted sessions produce tombstones; buffer files for tombstoned sessions are quarantined and pruned at tombstone expiry

## Cross-Cutting Gotchas

**Restart timing:** Daemon shutdown can take 87+ seconds due to sequential timeouts:
- `inflightRuns.drain(30s)` - waits for agent tasks
- `server.stop()` - waits for keep-alive connections (60s)
- During this window, port remains held and new daemon cannot bind

**Health vs ingestion:** The UI health dashboard is not sufficient evidence that capture ingestion is working. A 200 from `/health` only proves the process is alive, not that routed endpoints are functional.

**Service manager authority:** For managed daemons, the service manager (launchd/systemd) is the authority for process lifecycle. Recovery paths must route through the service manager, not raw process spawn.

**Coalesced recovery:** Multiple rapid capture failures trigger coalesced service restarts (30s window) to prevent restart storms. Don't interpret delayed recovery as evidence that the fix didn't work.

**Three-tier daemon.lock discovery:** The three-tier pattern allows daemon.lock to be discovered from explicit paths, grove directories, or global machine scan. Understand which tier applies to your setup when debugging location mismatches.

**Self-reconcile is independent:** Self-reconciliation no longer depends on PowerManager scheduling. It runs continuously on its own interval (`SELF_RECONCILE_INTERVAL_MS = 30_000`), even when PowerManager tasks are suspended.

**`closeSession` is the completion chokepoint:** `closeSession()` in `packages/myco/src/daemon/jobs/session-maintenance.ts` is the single gate that flips session status and records the completion timestamp. All session-finalizing code paths (stale session sweeper, stop route, reconciliation) must route through it — never set session status directly.

**Buffer tombstones prevent resurrection:** Deleted sessions produce tombstones (`TOMBSTONE_RETENTION_MS = 14 days` in `packages/myco/src/constants.ts`). Quarantined buffer files for deleted sessions are pruned at tombstone expiry. Do not attempt to replay buffer events for tombstoned sessions — the replay will be silently dropped.

**Three-tier recovery probe before forced restart:** `DaemonClient.daemonConfirmedAlive()` in `packages/myco/src/hooks/client.ts` probes `DAEMON_RECOVERY_PROBE_ATTEMPTS = 3` times across three tiers — daemon.json state file, daemon.lock lifecycle lock (alternate port check), and health-endpoint discovery — before concluding a service manager restart is needed. A genuinely dead daemon fails each probe with immediate connection refusal; `DAEMON_RECOVERY_PROBE_DELAY_MS` pauses absorb momentarily-busy daemons. Don't treat a delayed restart decision as evidence that recovery failed.

**No-protocol-skew contract:** Hook buffer-fallback logic in `packages/myco/src/hooks/send-event.ts` is vintage-blind — it does not inspect hook or daemon version numbers. This is safe because the update installer rewrites every hook and plugin file synchronously before restarting the daemon, ensuring hooks and daemon always co-ship at the same version. The only skew window is seconds-long during an in-flight update, and content-keyed convergence collapses any duplicate buffered events on replay.

**Dev daemon `symbiont-config` claim hijacks global Claude Code capture:** A dogfood `service-dev` daemon holding the `symbiont-config` subsystem claim can silently embed its own dev binary path into global agent hook config, causing ALL Claude Code capture machine-wide to be dropped for non-dogfood projects while Pi/MCP agents continue capturing normally. Root cause: `packages/myco/src/symbionts/installer.ts`'s `resolveManagedBinaryPath()` previously fell back to the daemon's own executable path, letting a dev daemon embed its binary path into shared global settings. Fix: `resolveManagedBinaryPath()` resolves in daemon-agnostic priority order — machine runtime pin → converged managed binary → daemon executable as absolute last resort — preventing this class of cross-daemon contamination. Recovery: re-run symbiont install on affected projects to regenerate hooks with the correct managed binary path.

**Windows bare-git ENOENT = P1 silent capture loss:** Windows GUI agents (Claude Desktop, Cursor) inherit a stripped PATH that excludes Git's installation directory. Any bare `git` spawn on the critical capture path — such as in the Pi plugin's commit-range detection or the release-provenance reconciler — throws `ENOENT` on Windows and silently drops the entire capture event. Fix: probe and cache the absolute path to the git binary at startup rather than relying on PATH, or guard git-dependent capture code with an explicit PATH expansion for Windows. Do not assume `git` is resolvable on PATH in Windows GUI agent environments.

**`KeepAlive` requires `SuccessfulExit=false` — bare `<true/>` creates restart storms:** Myco launchd plists generated by `packages/myco/src/service/launchd-plist.ts` use `KeepAlive` with `SuccessfulExit=false` to restart only on non-zero exits and signals. A bare `KeepAlive=<true/>` respawns the daemon on every clean `exit(0)` — including deliberate step-aside exits — creating ~10/s respawn loops under launchd throttle when a sibling daemon holds the lock. If you observe launchd throttle events on daemon startup, verify the plist was generated with the current `renderLaunchdPlist()` in `packages/myco/src/service/launchd-plist.ts`, not a legacy bare-KeepAlive plist.

**`pruneSupersededUnits` must be called after install/upgrade:** `packages/myco/src/service/launchd.ts`'s `pruneSupersededUnits()` removes stale launchd units whose target binary no longer exists (dead-target check). Without it, old service entries accumulate across version upgrades and consume launchd job slots. `packages/myco/src/service/self-install.ts` calls this automatically during self-install, but direct plist manipulations bypass it.

**Silent Failure Patterns:**
- **Multiple simultaneous bugs:** The May 15 incident had three independent failures. Fix one layer, then re-test the full pipeline.
- **Observability gaps:** Without codified health checks at each layer, diagnosis starts from scratch every incident.
- **Memory vs. Database authority:** Never use in-memory state for write decisions. Database is source of truth.

**Recovery Priorities:**
1. **Database layer** (session rows) → enables all other recovery
2. **Stop route processing** → completes incomplete sessions
3. **Hook/Buffer stability** → prevents new incidents
4. **MCP bridge health** → restores tool functionality

**Incident Documentation:**
Save diagnostic artifacts to Claude memory:
- Four-layer health check results
- Timeline of fixes applied
- Root cause analysis per layer
- Recovery procedures that worked

This creates searchable incident history for pattern recognition and faster future diagnosis.
