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
  runIn: ["active", "idle"]    # power states that permit this job
  preventsDeepSleep: false     # true only if job MUST flush before deep sleep
```

- **`intervalSeconds`**: PowerManager may delay if the daemon is mid-transition.
- **`runIn`**: Valid states are `"active"`, `"idle"`, `"sleep"`. Omit `"deep_sleep"` unless absolutely necessary.
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

Use when you need live status or progress surfaced in the Myco UI during a daemon operation. This is a **4-step procedure** — partial wiring silently fails with no errors. Apply this procedure whenever you're wiring a new domain into Myco's notification system — even if the request is as simple as "make the digest task emit a notification when it's done." All five domains (agents, sessions, skills, mycelium, daemon) are now wired; use this procedure when adding a sixth domain or a new emission point within an existing domain.

### Step 1: Register the Notification Type at Domain Startup

In the domain's initialization code (wherever it runs at daemon startup), call `notificationRegistry.register()` once per notification type:

```typescript
notificationRegistry.register({
  type: 'myco.digest.completed',   // namespace: myco.<domain>.<event>
  defaultDisplay: 'banner',         // 'banner' or 'summary' — do not use 'toast'
  label: 'Digest Completed',        // human-readable name shown in the settings UI
  description: 'Fired when the digest task finishes writing a tier.',
});
```

**Naming convention:** Always `myco.<domain>.<event>` — e.g., `myco.skill.generated`, `myco.sync.conflict`, `myco.digest.completed`.

**Gotcha: `register()` must precede any `emit()` call.** The registry lookup inside `emit()` throws if the type was never registered. Daemon initialization order matters — register in the module's startup function, not lazily on first emit.

**Idempotent:** Safe to call on every daemon restart. The registry is in-memory and rebuilt each time, so duplicate calls after restart are not a concern.

There are 10 types registered across 5 domains: agents (2), sessions (2), skills (3), mycelium (2), daemon (1). All use the same `register()` pattern.

---

### Step 2: Emit at the Event Point

After the meaningful work completes, call `notificationService.emit()`:

```typescript
// Inside the function that completes the domain work:
await notificationService.emit({
  type: 'myco.digest.completed',
  payload: {
    tier: tierId,
    wordCount: result.wordCount,
  },
  // Omit `display` unless you have a specific reason to override the registry default
});
```

**Do not hardcode `display` in the emit call.** The three-tier priority chain resolves the display mode automatically (see Step 3). Hardcoding `display: 'banner'` bypasses the chain and prevents users from configuring notification behavior.

**Only set `display` at emit time if the notification must always be silent:**

```typescript
await notificationService.emit({
  type: 'myco.digest.heartbeat',
  payload: { ... },
  display: 'silent',  // Suppress banners for high-frequency background events
});
```

**Payload shape is flexible.** The `payload` field is untyped — pass whatever context the notification consumer needs. Keep it small; it's persisted to the `notifications` SQLite table with 30-day auto-pruning.

---

### Step 3: Verify Three-Tier Display Resolution

The notification system resolves the final display mode using this priority chain:

| Priority | Source | When it applies |
|----------|--------|-----------------|
| **1 (highest)** | Global UI setting | User has set a global override in Settings → Notifications |
| **2** | Registry `defaultDisplay` | The value you set in `register()` in Step 1 |
| **3 (lowest)** | Per-emit `display` override | Value passed in `notificationService.emit()` in Step 2 |

Higher priority wins. For most domains: set `defaultDisplay` in the registry (Step 1) and omit `display` in the emit (Step 2). The user's global setting will override your registry default.

**Valid display values:**
- `'banner'` — top-right stacked cards, max 3 visible, 8s auto-dismiss, slide-in animation
- `'summary'` — persistent right panel drawer (w-96, up to 50 items, bulk actions, escape-to-close)
- `'silent'` — no UI output; stored to the notifications table but not surfaced

**Note:** Banner notifications also appear in the summary panel. `summary` is a superset — all banner events are also stored and visible in the panel. If `defaultDisplay` is `'banner'`, users will see it in both places.

---

### Step 4: Confirm React Hook Wiring on the UI Side

The React notification layer uses three distinct hooks — each serves a different purpose and they are intentionally kept separate:

| Hook | Purpose | Notes |
|------|---------|-------|
| `useNotifications()` | Fetch the full notification list for the panel | Called when the notification drawer opens |
| `useUnreadCount()` | Poll the unread count for the header bell badge | Lightweight — polls `/api/notifications/unread-count` on an interval; does NOT fetch notification records |
| `useNotificationRegistry()` | Read declared notification types for the settings UI | Read-once; the registry is static after daemon startup |

**Why the split?** `useUnreadCount()` uses a lightweight count endpoint so the badge stays fresh without fetching 50+ notification records on every poll tick. `useNotificationRegistry()` reads declared types — it auto-generates per-domain toggles in Settings without requiring any hardcoded config sections.

For a new domain, verify:
1. The new notification type appears in the `useNotifications()` stream when `notificationService.emit()` is called
2. The unread badge count increments via `useUnreadCount()`
3. The type appears as a configurable option in Settings → Notifications (via `useNotificationRegistry()`)

---

### Common Pitfalls for Notification Wiring

**Reference implementation available.** The skills domain (`vault_finalize_skill`) is the reference wired emitter — search the codebase for `vault_finalize_skill` to see a working `notificationService.emit()` call.

**`register()` is not lazy.** The registry lookup on `emit()` throws if the type was never registered. Do not call `register()` inside the `emit()` path as a lazy fallback — declare all types at daemon startup.

**Partial wiring silently fails.** The two most common failure modes:
- *Emit without registry entry* — notification dropped at the registry gate, no error.
- *Missing React handler* — notification received by WebSocket, discarded by UI layer, no error.

**"toast" is not a valid display mode.** The two rendering modes are `'banner'` and `'summary'`. Using `'toast'` will fail silently with an unknown mode default — use the documented values.

**Emit at boundaries, not in loops.** Emitting inside a tight loop creates WebSocket backpressure and floods the notification sidebar. Batch progress updates (every N items or on completion).

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
