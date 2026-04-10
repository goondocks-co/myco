---
name: myco:harden-agent-harness
description: Apply this skill whenever you add a new agent task (src/agent/tasks/) or MCP tool (src/mcp/tools/) to the Myco project — even if the user doesn't explicitly ask about safety. Every new task and tool must be hardened with three interlocking controls before shipping: (1) readOnly MCP annotations on non-mutating tools, (2) global enable/disable toggle wiring at the daemon's registration and trigger boundaries, and (3) phase-level readOnly enforcement in task YAML. This skill covers the gap left by register-mcp-tool (which covers tool anatomy but not readOnly annotations) and author-and-debug-agent-pipeline-tasks (which covers task YAML but not harness safety controls). Also apply when auditing existing tasks for missing safety controls or debugging toggle-related test failures.
managed_by: myco
user-invocable: true
allowed-tools: [Read, Write, Edit, Bash]
version: 1
tags:
  - agent-harness
  - safety
  - readOnly
  - mcp
  - testing
  - agent-tasks
---

# Hardening a Myco Agent Task or MCP Tool

## When to Use

**Do apply this skill when:**
- Creating any new file under `src/agent/tasks/` (pipeline tasks)
- Creating any new file under `src/mcp/tools/` (MCP tools)
- Auditing an existing task or tool for missing safety controls
- Debugging failures related to `readOnly`, toggle flags, or phase enforcement

**Do NOT use for:**
- Debugging LLM behavior or hallucinations inside tasks → use `author-and-debug-agent-pipeline-tasks`
- Adding MCP tool anatomy (Zod schema, server.ts registration) → use `register-mcp-tool`
- Modifying the config write path → use `safe-config-updates`

---

## Control 1: MCP `readOnly` Annotation

**File:** The tool definition object in `src/mcp/tools/<tool-name>.ts`

Add `readOnly: true` to any tool that does not mutate vault state:

```typescript
// src/mcp/tools/vault-read-digest.ts
export const vaultReadDigestTool = {
  name: "vault_read_digest",
  description: "...",
  readOnly: true,          // ← required for read-only tools
  inputSchema: {
    type: "object",
    properties: { /* ... */ },
  },
};
```

**Classification rules:**
- `vault_read_*`, `vault_search_*`, `vault_spores`, `vault_entities`, `vault_edges` → add `readOnly: true`
- `vault_create_*`, `vault_update_*`, `vault_resolve_*`, `vault_write_*`, `vault_mark_*` → omit `readOnly`

The MCP host uses this annotation to decide whether to show a confirmation dialog. Tools marked `readOnly: true` skip the confirmation step.

**Gotcha:** Annotating a mutating tool as `readOnly: true` silently suppresses the MCP host's confirmation dialog. The host trusts your annotation. Before marking a tool read-only, trace the full call chain (including DB writes and FS operations) to confirm no state mutation occurs anywhere in the path.

---

## Control 2: Global Toggle Gate

**Config keys** in `myco.yaml`:

```yaml
agent:
  scheduled_tasks_enabled: true   # controls cron/interval task registration
  event_tasks_enabled: true       # controls hook-triggered task dispatch
```

**Enforcement lives at the daemon registration and trigger boundaries — not inside task execute functions.**

### Scheduled tasks — gate in `registerScheduledTasks()`

```typescript
// src/daemon/task-scheduler.ts
function registerScheduledTasks(config: MycoConfig) {
  if (!config.agent?.scheduled_tasks_enabled) {
    log.info("Scheduled tasks disabled — skipping all registration");
    return;  // nothing registered; no LLM work starts
  }
  // ... register tasks with PowerManager ...
}
```

When adding a new scheduled task, verify the `scheduled_tasks_enabled` check precedes all task registration in this function. The single registration-level gate covers all scheduled tasks — do not add per-task toggle checks inside each task's execute function.

### Event-triggered tasks — gate in the trigger function

```typescript
// wherever event tasks are dispatched, e.g. triggerTitleSummary
function triggerTitleSummary(sessionId: string, config: MycoConfig) {
  if (!config.agent?.event_tasks_enabled) {
    return;  // return early before any dispatch
  }
  // ... dispatch task ...
}
```

When adding a new event-triggered task, add the `event_tasks_enabled` check at the start of its trigger function — before any async work or logging that would imply the task ran.

### What NOT to do

Do not add toggle checks inside a task's `execute()` function. By the time `execute()` is called, the task has already been dispatched — the gate must live at the outermost boundary (registration or trigger), not inside the task body.

### Manual runs always work

The **Run now** button in the Operations page UI bypasses both toggle flags and always executes the task immediately. This is intentional — developers retain an escape hatch to run tasks manually even when automatic execution is disabled.

---

## Control 3: Phase-Level `readOnly` Enforcement

**File:** `src/agent/tasks/<task-name>.yaml`

For pipeline tasks with multiple phases, mark each read-only phase explicitly:

```yaml
# src/agent/tasks/skill-generate.yaml
phases:
  - name: gather
    readOnly: true          # this phase only reads; no writes allowed
    description: Gather source material for the skill
    tools:
      - vault_spores
      - vault_search_fts
      - vault_skill_candidates
      # list ONLY read-only tools here

  - name: draft
    readOnly: false         # this phase writes (vault_stage_skill)
    description: Stage the skill content
    tools:
      - vault_stage_skill
      - vault_skill_candidates
```

The executor enforces this contract: if a phase is marked `readOnly: true` and the LLM calls a write tool, the executor rejects the call with a gate error before the tool executes.

**Why enforcement is in the tool layer, not the prompt:** Prompts are suggestions. A confused or token-pressured LLM might attempt a write despite instructions. The executor gate is deterministic and cannot be bypassed by the LLM's reasoning.

**Gotcha — audit the tool list:** After setting `readOnly: true` on a phase, review its `tools:` list and remove any tool with write capability. A phase marked `readOnly: true` with a write tool in its `tools:` list is self-contradictory and will produce spurious gate errors when the LLM legitimately tries to use that tool.

---

## Control 4: Test Coverage

Add at minimum three tests before shipping. Place them in `tests/` alongside the relevant file.

### Test A — Toggle-off rejection

```typescript
it("does not register new task when scheduled_tasks_enabled is false", async () => {
  const config = buildTestConfig({
    agent: { scheduled_tasks_enabled: false, event_tasks_enabled: true },
  });

  const jobs = registerScheduledTasks(config);

  expect(jobs).toHaveLength(0);
  // or verify the specific task name is absent from jobs
});
```

### Test B — Write rejected during readOnly phase

```typescript
it("rejects write tool call during readOnly phase", async () => {
  const phase = { name: "gather", readOnly: true };

  const result = await executor.callTool(
    "vault_create_spore",
    { observation_type: "gotcha", content: "test" },
    { phase }
  );

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("readOnly");
});
```

### Test C — Happy-path enabled state

```typescript
it("registers new task when scheduled_tasks_enabled is true", async () => {
  const config = buildTestConfig({
    agent: { scheduled_tasks_enabled: true, event_tasks_enabled: true },
  });

  const jobs = registerScheduledTasks(config);

  const taskNames = jobs.map((j) => j.name);
  expect(taskNames).toContain("<your-new-task-name>");
});
```

Use `buildTestConfig()` from `tests/helpers/` — do not construct config objects inline across multiple tests.

---

## Smoke Test

```bash
make build    # full quality gate: tsc + vitest + tsup + vite
myco doctor   # confirm daemon sees the new task/tool cleanly
```

Then in the daemon UI (Operations → Agent Tasks):
1. Toggle `scheduled_tasks_enabled` **OFF**
2. Wait for the next scheduled tick — confirm the new task does **not** run
3. Toggle **ON** — confirm the task runs on the next tick
4. Hit **Run now** — confirm it executes immediately regardless of toggle state

**Why live checks matter:** The toggle check reads config at registration time. If the daemon was not restarted after a `myco.yaml` change, the config cache may be stale and the toggle will behave unexpectedly in production despite passing unit tests. The live smoke test catches stale-cache failures that unit tests cannot.

---

## Pre-Ship Checklist

- [ ] Read-only MCP tools have `readOnly: true` in their tool definition
- [ ] Mutating tools do **not** have `readOnly: true`
- [ ] `registerScheduledTasks()` checks `config.agent?.scheduled_tasks_enabled` before registering the new task
- [ ] New event trigger function checks `config.agent?.event_tasks_enabled` before dispatching
- [ ] Phase-level `readOnly: true` set in task YAML for all read-only phases
- [ ] No write tools listed under `readOnly: true` phases
- [ ] Tests A, B, and C passing
- [ ] `make build` passes clean
- [ ] Live smoke test with daemon UI toggle completed
