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

**Three-Tier Discovery Pattern (v0.27.17+):**
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

**For capture-critical hooks, always use `capturePost()` instead of raw `DaemonClient.post()`:**

```typescript
// ❌ Fragile - no managed service recovery
await client.post('/events', {
  kind: 'prompt',
  data: promptData
});

// ✅ Resilient - triggers service restart on failure
await capturePost('/events', {
  kind: 'prompt',
  data: promptData
});
```

**Capture hooks that need `capturePost()`:**
- Session register (`/sessions/register`)
- Prompt submit (`/events` with `prompt` kind)
- Tool use (`/events` with `tool_use` kind)
- Generic event send (`/events` with other kinds)
- Session stop (`/events` with `stop` kind)

**Non-capture hooks keep ordinary `post()`:**
- Health checks, context switches, stats reads
- These get basic `spawnDaemon()` recovery, appropriate for unmanaged daemons

**Self-Reconcile Architecture (v0.27.17+):**
Self-reconciliation is now decoupled from PowerManager scheduling and runs on a dedicated interval:

```typescript
// Self-reconcile runs independently every N minutes
setInterval(async () => {
  // Compare buffer state to database state
  // Recover any orphaned sessions or incomplete batches
  await daemon.selfReconcile();
}, SELF_RECONCILE_INTERVAL);  // No longer co-scheduled with PowerManager
```

**Key differences from previous pattern:**
- **Not co-scheduled** with PowerManager tick events
- **Runs continuously** even when PowerManager tasks are disabled
- **Independent failure recovery** without PowerManager intervention
- **Configurable interval** per Grove (no longer fixed at daemon startup)

**Implementation in `packages/myco/src/hooks/client.ts`:**

```typescript
async function capturePost(endpoint: string, data: any) {
  return DaemonClient.post(endpoint, data, {
    recoverDaemonOnFailure: true
  });
}
```

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

**Error Semantics (v0.27.17+):**
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

**Architecture:** Post-PR #286, a 10s ppid watchdog auto-detects orphans. If seeing 21+ hour old processes, the watchdog isn't running.

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

**Expected recovery time:** ~60s from daemon restart (post-PR #286 heartbeat).

### MCP Observability
Post-PR #286, every state transition logs to stderr:

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

### Solution Pattern (Post-v0.27.17)
```typescript
// Shared fingerprint in packages/myco/src/capture/dedup.ts
// 10-second dedup window
// Both live dispatcher and buffer reconciler use same key

const fingerprint = eventDedupKey(event); // 10s window built-in
if (isProcessedRecently(fingerprint)) {
  return { status: 'duplicate', reason: 'within-window' };
}
```

**Test coverage:** See `tests/daemon/reconciliation-dedup.test.ts` for regression tests covering session 019e2bc0.

## Cross-Cutting Gotchas

**Restart timing:** Daemon shutdown can take 87+ seconds due to sequential timeouts:
- `inflightRuns.drain(30s)` - waits for agent tasks
- `server.stop()` - waits for keep-alive connections (60s)
- During this window, port remains held and new daemon cannot bind

**Health vs ingestion:** The UI health dashboard is not sufficient evidence that capture ingestion is working. A 200 from `/health` only proves the process is alive, not that routed endpoints are functional.

**Service manager authority:** For managed daemons, the service manager (launchd/systemd) is the authority for process lifecycle. Recovery paths must route through the service manager, not raw process spawn.

**Coalesced recovery:** Multiple rapid capture failures trigger coalesced service restarts (30s window) to prevent restart storms. Don't interpret delayed recovery as evidence that the fix didn't work.

**Three-tier daemon.lock discovery:** The three-tier pattern allows daemon.lock to be discovered from explicit paths, grove directories, or global machine scan. Understand which tier applies to your setup when debugging location mismatches.

**Self-reconcile is independent:** Self-reconciliation no longer depends on PowerManager scheduling. It runs continuously on its own interval, even when PowerManager tasks are suspended.

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