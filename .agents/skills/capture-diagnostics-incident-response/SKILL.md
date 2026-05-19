---
name: myco:capture-diagnostics-incident-response
description: |
  Diagnose and respond to capture infrastructure failures using Myco's four-layer 
  diagnostic architecture (Hook/Buffer/Memory/DB). Covers incident diagnosis procedures, 
  MCP bridge recovery, observability contract implementation, and systematic recovery 
  paths for capture pipeline failures. Use when capture appears degraded, sessions 
  show incomplete data, tool calls hang, or when implementing diagnostic observability 
  for the capture system.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Capture Infrastructure Diagnostics and Incident Response

This skill covers systematic diagnosis and response for Myco capture infrastructure failures. Based on the May 15, 2026 incident that revealed three independent bugs causing silent capture degradation, these procedures prevent expensive multi-layer investigations by codifying observability contracts and recovery paths across the four-layer capture architecture.

## Prerequisites

- Access to daemon logs and process monitoring
- Understanding of the capture pipeline: Hook → Buffer → Memory → Database
- Access to `~/.claude/projects/<project>/<session>.jsonl` transcript files
- Familiarity with MCP bridge architecture (agent→MCP→daemon via stdio)

## Procedure 1: Four-Layer Incident Diagnosis

When capture appears degraded (incomplete sessions, missing prompts, tool call failures), systematically diagnose using the four-layer model:

### Layer 1: Hook Diagnosis
**Question:** Did the hook fire and reach the daemon?

```bash
# Check buffer observability (post-PR #285)
grep "\[myco\].*buffered" ~/.myco/daemon-*/logs/daemon.err.log | tail -20

# Look for reasons: transport-failure, http-error, daemon-ignored:<reason>
# If buffer writes show transport-failure → network/daemon connectivity issue
# If no buffer entries but session active → hook not firing
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

## Procedure 2: MCP Bridge Recovery

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

## Procedure 3: Stop Event Recovery

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

## Procedure 4: Hook Double-Fire Deduplication

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

### Solution Pattern (Post-PR #285)
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

### Silent Failure Patterns
- **Multiple simultaneous bugs:** The May 15 incident had three independent failures. Fix one layer, then re-test the full pipeline.
- **Observability gaps:** Without codified health checks at each layer, diagnosis starts from scratch every incident.
- **Memory vs. Database authority:** Never use in-memory state for write decisions. Database is source of truth.

### Recovery Priorities
1. **Database layer** (session rows) → enables all other recovery
2. **Stop route processing** → completes incomplete sessions  
3. **Hook/Buffer stability** → prevents new incidents
4. **MCP bridge health** → restores tool functionality

### Incident Documentation
Save diagnostic artifacts to Claude memory:
- Four-layer health check results
- Timeline of fixes applied  
- Root cause analysis per layer
- Recovery procedures that worked

This creates searchable incident history for pattern recognition and faster future diagnosis.