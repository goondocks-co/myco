---
name: myco:extend-myco-daemon
description: |
  Use this skill when adding any new capability to the Myco daemon — even if
  the user doesn't explicitly ask about extension points. Covers four distinct
  daemon extension procedures: (1) registering a recurring background job via
  PowerManager, (2) registering a new MCP tool in server.ts, (3) wiring a new
  notification domain end-to-end (registry → emission → display → React hook),
  and (4) working with daemon auto-update logic (version checking, release
  channels, detached restart flow). Also provides a routing table for choosing
  which extension point(s) to use when adding a new daemon-resident feature —
  background work, agent-callable actions, live UI feedback, and self-upgrade
  all use different mechanisms that frequently compose together.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Extending the Myco Daemon

The Myco daemon is a long-running Node.js process that hosts MCP tools, background jobs, notification delivery, and self-update logic. Every major feature that needs to run inside the daemon uses one or more of four extension points. New features routinely need two or three in combination — a new sync domain typically requires a PowerManager job (polling), a notification domain (progress feedback), and an MCP tool (agent query interface). Start with the routing table, mark which points apply, then work through each procedure in order.

## Routing Table: Choosing the Right Extension Point

| What you need | Use |
|---|---|
| Background work that recurs on a schedule (polling, drain, sync) | Procedure 1: PowerManager Job |
| An action the AI agent or MCP client should be able to call | Procedure 2: MCP Tool |
| Live feedback surfaced in the UI while something is happening | Procedure 3: Notification Domain |
| Checking for or applying daemon self-upgrades | Procedure 4: Auto-Update |
| A stateful query endpoint serving the UI directly | Daemon API route (separate skill) |

## Prerequisites

- Daemon source checked out; dev server starts with `npm run dev`
- Core daemon entrypoint: `src/daemon/main.ts`
- PowerManager: `src/daemon/power-manager.ts`
- MCP server: `src/mcp/server.ts`; individual tools: `src/mcp/tools/`
- Notification registry and types: `src/notifications/`
- Auto-update logic: `src/daemon/update-checker.ts`, `src/daemon/update-installer.ts`, `src/api/update.ts`

---

## Procedure 1: PowerManager Recurring Job

Use when you need background work on a schedule — interval polling, outbox drain, sync heartbeat. **Never use `setInterval` directly**; PowerManager owns all scheduling to support sleep/wake lifecycle.

### Step 1 — Declare the schedule in task config

```yaml
# In .myco/tasks/<task-name>.yaml or equivalent task config:
schedule:
  intervalSeconds: 60          # minimum interval between runs
  runIn: [\"active\", \"idle\"]    # power states that permit this job
  preventsDeepSleep: false     # true only if job MUST flush before deep sleep
```

- **`intervalSeconds`**: PowerManager may delay if the daemon is mid-transition.
- **`runIn`**: Valid states are `\"active\"`, `\"idle\"`, `\"sleep\"`. Omit `\"deep_sleep\"` unless absolutely necessary.
- **`preventsDeepSleep`**: Set `true` only for outbox-flush or sync-critical jobs; it delays deep sleep until the current run finishes.

### Step 2 — Register the job callback

In `src/daemon/main.ts` (or your feature's init module):

```typescript
import { powerManager } from './power-manager';

powerManager.registerJob({
  name: 'my-feature-sync',           // unique, kebab-case
  intervalSeconds: config.intervalSeconds,
  runIn: config.runIn ?? ['active', 'idle'],
  preventsDeepSleep: config.preventsDeepSleep ?? false,
  run: async () => {
    await myFeatureSync();
  },
});
```

### Step 3 — Implement the job function

```typescript
async function myFeatureSync(): Promise<void> {
  try {
    const items = await fetchPendingItems();
    for (const item of items) {
      await processItem(item);
    }
  } catch (err) {
    logger.error('myFeatureSync failed', err);
    // Never rethrow — an uncaught exception stops future runs of this job.
  }
}
```

The `run` callback must be:
- **Async** — PowerManager awaits completion before scheduling the next run.
- **Idempotent** — may be called multiple times for the same logical window after a sleep/wake cycle.
- **Non-throwing** — wrap with try/catch; exceptions stop future scheduling for that job.

### Gotchas

**The sleep/deep_sleep drain gap**: Jobs with `runIn: ['active', 'idle']` pause during `sleep`/`deep_sleep`. Outbox-adjacent jobs (those flushing data to a remote service) should set `preventsDeepSleep: true` or add a wake-handler check. Without this, outbox items accumulate until the daemon returns to `active` — acceptable for non-critical data, not for sync-critical flows.

**`setInterval` is forbidden**: Bypasses the PowerManager state machine, fires during deep sleep, races with daemon shutdown, and ignores `preventsDeepSleep` semantics.

**Cold start ordering**: PowerManager starts jobs after all services initialize. If your job depends on an async-init service, add a readiness guard inside `run` rather than at registration time.

---

## Procedure 2: MCP Tool Registration

Use when you need to expose a new action that the AI agent (or any MCP client) can call.

### Step 1 — Create the tool file

Create `src/mcp/tools/<your-tool-name>.ts`. Every tool file exports a single `ToolDefinition`:

```typescript
// src/mcp/tools/get-skill-candidates.ts
import { z } from 'zod';
import type { ToolDefinition } from '../types';

const InputSchema = z.object({
  status: z.enum(['pending', 'approved', 'dismissed']).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const getSkillCandidates: ToolDefinition = {
  name: 'vault_skill_candidates',
  description: 'List skill candidates, optionally filtered by status.',
  annotations: { readOnly: true },   // add for any tool that never mutates state
  inputSchema: InputSchema,
  handler: async (input) => {
    const parsed = InputSchema.parse(input);  // always validate inside the handler
    const candidates = await db.listSkillCandidates(parsed);
    return {
      content: [{ type: 'text', text: JSON.stringify(candidates, null, 2) }],
    };
  },
};
```

Key anatomy:
- **`name`**: The MCP tool name the agent calls. Use the `vault_` prefix for vault-resident tools.
- **`description`**: Natural-language description used by the LLM to decide when to invoke.
- **`annotations.readOnly: true`**: Signals to the agent harness that this tool is safe in read-only phases. Omitting it on a read-path tool causes unnecessary phase restrictions.
- **`inputSchema`**: Zod schema — the MCP server converts it to JSON Schema automatically.
- **`handler`**: Always validate with `InputSchema.parse(input)` for TypeScript narrowing and runtime safety.
- **Return format**: Always `{ content: [{ type: 'text', text: string }] }`. Use `JSON.stringify` for structured data.

### Step 2 — Register in `server.ts` (two-step)

Registration requires both an import and an array entry in `src/mcp/server.ts`:

```typescript
// Step 2a — import near the top, with other tool imports:
import { getSkillCandidates } from './tools/get-skill-candidates';

// Step 2b — add to the tools registry:
const tools = [
  // ... existing tools ...
  getSkillCandidates,
];
```

Verify the tool appears in `list_tools`:
```bash
curl -s http://localhost:<MCP_PORT>/mcp/tools | jq '.tools[].name'
```

### Cloud vs. local MCP capability split

Some tools are only valid when the daemon runs locally (SQLite access, local file paths, PowerManager). Others are safe in cloud/remote contexts.

- **Local-only**: Anything reading `~/.myco/` paths, querying the local vault, or calling PowerManager.
- **Cloud-safe**: Tools proxying to a remote API or returning stateless computed results.

Gate local-only tools:
```typescript
if (!runtimeContext.isLocal) {
  return { content: [{ type: 'text', text: 'This tool requires a local daemon.' }] };
}
```

### Gotchas

**Two-step registration is required**: Importing the tool file alone is not enough — it must also be added to the tools array. Missing either step means the tool silently doesn't appear in `list_tools`.

**Validate in the handler, not just the schema**: The MCP framework may pass raw JSON. `inputSchema` feeds the LLM's parameter hints; `InputSchema.parse(input)` is your actual runtime guard.

---

## Procedure 3: Notification Domain Wiring

Use when you need live status or progress surfaced in the Myco UI during a daemon operation. This is a **4-step procedure** — partial wiring silently fails with no errors.

### Step 1 — Register the type in the notification registry

```typescript
// src/notifications/registry.ts
export const NotificationRegistry = {
  // ... existing types ...
  MY_FEATURE_PROGRESS: {
    type: 'MY_FEATURE_PROGRESS',
    label: 'My Feature',
    description: 'Progress updates from my feature',
    defaultEnabled: true,
  },
} as const;

export type NotificationType = keyof typeof NotificationRegistry;
```

If the type is not registered here, emitting it produces no error but the notification is silently dropped — the hardest failure mode to diagnose.

### Step 2 — Emit at the event point

```typescript
import { notificationService } from '../notifications/service';

await notificationService.emit({
  type: 'MY_FEATURE_PROGRESS',
  title: 'My Feature',
  message: `Processed ${count} items`,
  severity: 'info',   // 'info' | 'success' | 'warning' | 'error'
  metadata: { count, sessionId },
});
```

Emit at meaningful boundaries — job completion, error recovery, milestone thresholds — not on every item processed.

### Step 3 — Verify three-tier display resolution

Myco resolves notifications through three display tiers:

| Tier | Trigger | Behavior |
|---|---|---|
| Toast | `severity: 'info'` or `'success'` | Transient, auto-dismisses |
| Banner | `severity: 'warning'` or `'error'` | Persistent, requires user dismiss |
| Sidebar | All notifications | Always logged to notification history |

Test manually: trigger your emit path and confirm the notification appears in the correct tier. If nothing appears, re-check Step 1 (type registered?) and Step 4 (React hook wired?).

### Step 4 — Wire the React hook

The notification type must be handled in the UI layer. In `src/ui/hooks/useNotifications.ts` (or equivalent):

```typescript
const NOTIFICATION_HANDLERS: Record<NotificationType, (n: Notification) => void> = {
  // ... existing handlers ...
  MY_FEATURE_PROGRESS: (n) => {
    dispatch({ type: 'ADD_NOTIFICATION', payload: n });
  },
};
```

Without this handler, notifications reach the WebSocket but are silently discarded by the React layer.

### Reference implementations

As of 2026-04-03 all four production domains are fully wired: `team-sync`, `skill-lifecycle`, `session-capture`, `agent-pipeline`. Copy one as a template when adding a new domain — all four steps are visible in each.

### Gotchas

**Partial wiring silently fails**: The two most common failure modes:
- *Emit without registry entry* — notification dropped at the registry gate, no error.
- *Missing React handler* — notification received by WebSocket, discarded by UI layer, no error.

**Emit at boundaries, not in loops**: Emitting inside a tight loop creates WebSocket backpressure and floods the notification sidebar. Batch progress updates (every N items or on completion).

---

## Procedure 4: Daemon Auto-Update

Use when working on version checking, release channel management, update state caching, or the detached restart flow.

### How auto-update works

1. **Multi-package version check**: The updater detects all installed `@goondocks/*` packages in the npm global prefix, then polls npm for the latest version of each matching the configured release channel (`stable` or `beta`).
2. **State caching**: The result is cached in memory (and optionally on disk) to avoid registry hammering on each daemon wake.
3. **User notification**: When newer versions are available, a notification is emitted via the notification domain.
4. **Detached restart**: If the user approves (or auto-update is enabled), a detached child process installs the new versions and restarts the daemon.

### Working with the updater

The updater is split into two modules: `src/daemon/update-checker.ts` (detecting installed packages and polling npm) and `src/daemon/update-installer.ts` (applying updates).

```typescript
// Check for updates (returns cached result if still fresh):
// Pass the array of installed package names (e.g., ['@goondocks/myco', '@goondocks/myco-team'])
const updateInfo = await checkPackages(installedPackages, channel);
// Returns: { '@goondocks/myco': '0.19.0', '@goondocks/myco-team': '0.1.1' } 
// (only packages with newer versions available)

// Apply updates (triggers detached restart):
await installUpdates(updateInfo);
```

The return value from `checkPackages` is a map of `{ packageName: newVersion }` — only packages with newer versions are included. Empty object `{}` means all installed packages are up-to-date.

### Null guards on cold cache reads

The update cache is `null` on first daemon start — no check has run yet. Always null-guard before reading:

```typescript
const cached = getUpdateCache();
if (cached === null) {
  // First run — schedule async check, don't block startup
  scheduleUpdateCheck();
  return;
}
if (Object.keys(cached).length > 0) {
  // At least one package has a newer version available
  // Surface update notification
}
```

Failing to null-guard causes `TypeError: Cannot read properties of null` on fresh installs.

### Release channels

```typescript
// stable → npm 'latest' tag; beta → npm 'beta' tag
const distTag = channel === 'beta' ? 'beta' : 'latest';
// checkPackages internally maps over all detected @goondocks/* packages
// and fetches latestVersion for each using the distTag
const updateInfo = await checkPackages(installedPackages, channel);
```

**Beta channel can downgrade**: If a user is on `@goondocks/myco@1.2.0-beta.3` and switches to `stable`, the npm `latest` tag for that package may be `1.1.5`. Compare semver per package and warn before applying a downgrade.

### Race condition on restart

If the user triggers a manual restart via the Operations page at the same moment the auto-updater fires, two restart processes can race. Guard with a restart lock:

```typescript
let restartInProgress = false;

async function triggerRestart() {
  if (restartInProgress) {
    logger.warn('Restart already in progress — ignoring duplicate trigger');
    return;
  }
  restartInProgress = true;
  await spawnDetachedRestart();
}
```

### Operations page surface

The Operations page surfaces: current installed versions (from `update-checker.ts`), available updates (from cached state), release channel selector, "Check for updates" button, and "Apply update" button. The page polls `/daemon/update-status` — ensure that endpoint returns the latest cached state after a check completes. Files involved: `src/ui/UpdateCard.tsx`, `src/ui/hooks/use-update-status.ts`, `src/api/update.ts`.

### Gotchas

**Detached restart loses in-flight work**: Any in-flight PowerManager jobs, pending notifications, or open MCP connections are dropped on restart. If your feature has critical in-flight state, flush it before calling `installUpdates`.

**Null cache on cold start**: Always null-guard. The cache is populated on first check, not on daemon init.

---

## Cross-Cutting Gotchas

**Initialization order in `main.ts`**: All extension points must be registered after core services (DB, logger, config) are initialized but before the daemon signals readiness. Too early → dependencies not ready. Too late → connections accepted before extension is available.

**The four extension points compose**: Design all required extension points before implementing any one — their interfaces affect each other. A new sync domain needs a job (poll loop), a notification domain (progress), and a tool (agent query interface); plan all three upfront.

**Daemon restart clears in-memory state**: Job timers, notification subscriptions, and update caches are all in-memory. All registered jobs are re-registered automatically on restart only if registration happens in `main.ts` — lazy registration is lost.

**`preventsDeepSleep` vs. `runIn` are orthogonal**: `runIn` controls which power states allow a job to start. `preventsDeepSleep` controls whether an already-running job blocks the transition to deep sleep. A job can have `runIn: ['active', 'idle']` (only starts in those states) AND `preventsDeepSleep: true` (if it starts before a deep-sleep transition, deep sleep waits for it to finish).
