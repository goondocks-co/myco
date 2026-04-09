---
name: myco:register-powermanager-job
description: |
  Use this skill whenever you need to add a recurring or periodic job to the Myco daemon — even if the user doesn't explicitly ask about PowerManager. Applies when: creating a new agent task that needs a schedule, wiring up a background flush/poll loop, changing polling intervals, debugging why a job never fires, or adding preventsDeepSleep behavior. Keywords: PowerManager, task-scheduler, schedule block, runIn, intervalSeconds, setInterval (which is forbidden), recurring job, polling, deep sleep, background work.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Register a Recurring Job with the Myco Daemon PowerManager

The Myco daemon uses a central `PowerManager` (`src/daemon/power.ts`) as the single hub for all periodic work. It tracks four power states (Active → Idle → Sleep → Deep Sleep) and throttles job cadence accordingly. Any background polling, flush loop, or scheduled task must register here — bypassing it with raw `setInterval` would make the job run at full speed even when the user hasn't touched the UI in hours.

## Prerequisites

- You know which power states the job should run in (see state table below)
- If the job is an agent task, its YAML file exists in `src/agent/tasks/`
- If the job is a non-task daemon service, you have a reference to `powerManager` in scope

## PowerManager State Reference

| State | When | Default job interval |
|-------|------|---------------------|
| Active | < 5 min since last HTTP request | 60 s |
| Idle | 5–30 min | 60 s |
| Sleep | 30–90 min | 5 min |
| Deep Sleep | > 90 min | All jobs paused |

Jobs do not fire at all during Deep Sleep — that is enforced by the PowerManager, not your code.

## Path A — Agent Task (Recommended)

If the recurring work is an agent task, add a `schedule:` block to its YAML. `task-scheduler.ts` reads every task YAML at daemon startup and registers the PowerManager jobs automatically — no code change needed.

**1. Open or create the task YAML** at `src/agent/tasks/<task-name>.yaml`.

**2. Add the `schedule:` block:**

```yaml
name: my-task
description: What this task does
model: claude-3-5-sonnet-latest   # Always set explicitly — see gotcha below
schedule:
  enabled: true
  intervalSeconds: 300
  runIn:
    - active
    - idle
    - sleep
```

**`runIn` gotcha:** Be deliberate about which states to include. A common mistake is listing only `active`, which silences the job during Sleep — the state where background maintenance is often most needed. The `team-sync-flush` task hit this exact bug; the fix was adding `'sleep'`. When in doubt, include `active`, `idle`, and `sleep`.

**`model` gotcha:** Always set `model` explicitly in the task YAML. Omitting it inherits the global provider default, which may point to a stale model version and cause silent task failures.

**3. Confirm `task-scheduler.ts` will pick it up** — no code change is needed if the YAML is in `src/agent/tasks/`. At daemon startup, `task-scheduler.ts` reads all task YAMLs and calls `powerManager.register()` for each entry with `schedule.enabled: true`.

**Fire-and-forget dispatch for long-running tasks:** The PowerManager tick loop calls each job's `fn` synchronously in a `for` loop. If a task's `fn` `await`s the full task execution, the tick loop is blocked until that task completes — starving every subsequent job in the same tick. Any task expected to run longer than ~1 minute **must** dispatch as fire-and-forget:

```typescript
// In task-scheduler.ts — the registered job fn for each task:
fn: () => {
  if (!context) return;
  if (context.isTaskRunning(task.name)) return;
  // Stamp lastRun and mark running synchronously, THEN dispatch without await:
  task.lastRun = Date.now();
  void context.runTask(task.name).catch((err) => {
    logger.error(`Task ${task.name} failed`, err);
  }).finally(() => {
    context.markTaskDone(task.name);
  });
}
```

The `full-intelligence` task (18–23 min) hit this bug — every job scheduled after it in the same tick was silently delayed by the full task duration. The fix was removing the `await` and dispatching fire-and-forget. Short-lived tasks (< 1 min) may `await` safely, but fire-and-forget is the safer default for all tasks.

**User overrides:** Users can override `enabled` and `intervalSeconds` in `myco.yaml`:

```yaml
agent:
  tasks:
    my-task:
      schedule:
        enabled: false        # disable entirely
        intervalSeconds: 600  # or adjust cadence
```

**Global task toggle:** `agent.scheduled_tasks_enabled: false` in `myco.yaml` suppresses ALL scheduled-task registration globally — `registerScheduledTasks()` skips every task with `schedule.enabled: true` when this flag is off. When debugging a task that never fires, check this flag first before inspecting the task YAML or the per-task `enabled` field. Default is `true`; the flag is independent of per-task `schedule.enabled` (spore `3575f686`).

**After any YAML or config change, restart the daemon.** Schedule configuration is read once at startup; there is no hot-reload. Writing `enabled: true` via the Settings UI has no immediate effect until the daemon restarts.

## Path B — Direct Registration (Non-Task Jobs)

For daemon services that are not agent tasks (e.g., a background outbox drain), call `powerManager.register()` directly during daemon initialization:

```typescript
import { powerManager } from './power';

powerManager.register({
  name: 'my-flush-loop',
  intervalSeconds: 60,
  runIn: ['active', 'idle', 'sleep'],
  callback: async () => {
    await flushPendingItems();
  },
});
```

Call this before the PowerManager starts ticking so the job is registered for the first cycle.

## Adding `preventsDeepSleep`

If the job holds work that must not be abandoned when the daemon enters Deep Sleep, add a `preventsDeepSleep` predicate to the `PowerJob`:

```typescript
powerManager.register({
  name: 'outbox-drain',
  intervalSeconds: 30,
  runIn: ['active', 'idle', 'sleep'],
  preventsDeepSleep: () => outbox.hasPendingItems(),
  callback: async () => { await drainOutbox(); },
});
```

The predicate is evaluated before each Deep Sleep transition. If it returns `true`, the daemon stays in Sleep instead of transitioning deeper.

**Infinite-hold gotcha:** If a record can never succeed (e.g., a permanent network error), `preventsDeepSleep` will return `true` forever and the daemon never enters Deep Sleep. Always pair this pattern with a dead-letter ceiling — after N retries (typically 10), mark the record as dead-lettered and stop retrying. The predicate must exclude dead-lettered records from its count.

## Config Migration Context

The old top-level keys `agent.auto_run` and `agent.interval_seconds` were migrated to `agent.tasks.full-intelligence.schedule.*` in config schema v3. The migration lives in `src/config/migrations.ts` and runs automatically on daemon start. If you encounter old-style keys in a user's `myco.yaml`, leave them — the daemon will migrate them.

## Checklist

- [ ] No raw `setInterval` or `setTimeout` anywhere in `src/daemon/`
- [ ] `runIn` includes all states where the job should actually fire — double-check Sleep
- [ ] `model` is explicitly set in any new task YAML
- [ ] Tasks expected to run > ~1 minute use fire-and-forget dispatch (no `await` in the tick loop `fn`)
- [ ] If `preventsDeepSleep` is used, a dead-letter ceiling (≤ 10 retries) is in place
- [ ] If a scheduled task is not firing, check `agent.scheduled_tasks_enabled` in `myco.yaml` first (global kill-switch, default `true`) before inspecting the task YAML
- [ ] Daemon restarted after any YAML or `myco.yaml` schedule changes
