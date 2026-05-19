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

The Myco capture pipeline can fail silently while the daemon appears healthy—sessions buffer durably but aren't ingested until manual restart. This skill covers detecting these failure modes, diagnosing root causes, and implementing resilient recovery patterns for managed daemon services.

## Prerequisites

- Myco daemon running as a managed service (launchd/systemd)
- Understanding of capture hook flow: client → daemon → ingestion → DB
- Access to daemon logs and buffer directories (`.myco/buffer/`)

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

## Procedure 2: Diagnosing Failure Modes

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

## Procedure 3: Implementing Recovery Patterns

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

## Cross-Cutting Gotchas

**Restart timing:** Daemon shutdown can take 87+ seconds due to sequential timeouts:
- `inflightRuns.drain(30s)` - waits for agent tasks  
- `server.stop()` - waits for keep-alive connections (60s)
- During this window, port remains held and new daemon cannot bind

**Health vs ingestion:** The UI health dashboard is not sufficient evidence that capture ingestion is working. A 200 from `/health` only proves the process is alive, not that routed endpoints are functional.

**Service manager authority:** For managed daemons, the service manager (launchd/systemd) is the authority for process lifecycle. Recovery paths must route through the service manager, not raw process spawn.

**Coalesced recovery:** Multiple rapid capture failures trigger coalesced service restarts (30s window) to prevent restart storms. Don't interpret delayed recovery as evidence that the fix didn't work.