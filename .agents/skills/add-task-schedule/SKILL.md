---
name: myco:add-task-schedule
description: |
  Use this skill when you need to add automatic scheduling to a Myco agent pipeline task —
  making it run on a cron interval or sweep continuously without manual invocation. Activates
  whenever a task currently requires manual triggering and needs to run automatically, when
  adding a new task that should fire on a schedule, or when debugging why a scheduled task
  isn't firing, is running too frequently, or silently skipping. Apply this skill even if
  the user doesn't explicitly say "add schedule" — any time they ask "make this task run
  automatically," "run this every hour," "set up a sweep," or "wire up the scheduler," this
  procedure applies. Covers schedule block syntax in task YAML files under src/agent/tasks/,
  the task-scheduler wiring in src/daemon/task-scheduler.ts, preCondition-based early exit,
  concurrency guard behavior, sweep design patterns, and the dependsOn interaction with
  scheduled roots.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Adding Per-Task Scheduling to the Myco Agent Pipeline

Every Myco agent task lives as a YAML file in `src/agent/tasks/`. By default, tasks run only
when triggered manually through the Daemon UI or pulled in via another task's `dependsOn` chain.
Adding a `schedule` block makes the task fire automatically — `src/daemon/task-scheduler.ts`
polls all task definitions and enqueues runs when their schedule comes due.

## Prerequisites

- The task YAML already exists at `src/agent/tasks/<task-name>.yaml` and runs cleanly when triggered manually.
- You know the task's typical run duration — scheduling a slow task too aggressively causes silent skips from the concurrency guard.
- The daemon is running; it hosts the scheduler and reloads task definitions without restart.

## Steps

### 1. Add a `schedule` block to the task YAML

Open `src/agent/tasks/<task-name>.yaml` and add a top-level `schedule` field alongside `name`,
`description`, and `phases`:

```yaml
name: my-task
description: What this task does.
schedule:
  cron: "0 * * * *"    # fires every hour at :00
```

Or use `interval` (seconds) instead of `cron` when backpressure matters more than clock alignment:

```yaml
schedule:
  interval: 300         # 5 minutes between scheduled fires
```

**Cron vs. interval:** Use `cron` when you want wall-clock anchoring ("always at the top of
the hour"). Use `interval` for drain/sweep tasks where a fixed gap after the previous run
completes is more appropriate than a fixed clock tick — it naturally absorbs variable run times.

### 2. Add a `preCondition` for sweep tasks

If the task is meant to continuously drain a queue (e.g., processing unprocessed prompt batches,
advancing skill candidates), it will fire even when there is nothing to do. A `preCondition`
lets the executor exit cleanly before spinning up the full agent:

```yaml
schedule:
  interval: 300
preCondition: |
  Check whether there are unprocessed items or pending work. If the vault is
  current and there is nothing to process, respond with exactly: SKIP
```

The executor checks `preCondition` on every scheduled fire. If the response is exactly `SKIP`
(case-sensitive), the run is aborted before any phase runs, consuming no LLM turns. Any other
response — including `"skip"`, `"Nothing to do"`, or an empty string — is treated as a green
light to proceed. Be precise in the preCondition wording.

### 3. Confirm the scheduler picked it up

`src/daemon/task-scheduler.ts` loads task definitions at daemon start and on config reload. After
saving the YAML you do **not** need to restart the daemon. Open the Daemon UI → **Tasks** page
and confirm the task shows a "Next run" timestamp. A blank "Next run" indicates the `schedule`
block has a YAML syntax error or the field name is wrong — validate the file is well-formed.

### 4. Understand concurrency guard behavior

The scheduler will not enqueue a new run if the same task is already running. This protects
against pile-up when a run takes longer than its interval. The guard is universal — there is no
per-task YAML override. Watch the audit log for `"skipped (already running)"` entries if a task
seems to fire less often than expected; this means the interval is shorter than the task's
actual runtime.

For long-running tasks, widen the interval to be comfortably longer than the typical run. For
fast tasks with tight intervals (e.g., `interval: 60`), verify that the task consistently
finishes within the window before deploying to production.

### 5. Place the schedule on the chain root only

If your task kicks off a `dependsOn` chain (e.g., `skill-survey` → `skill-generate`), only
the **root** task needs a `schedule`. Downstream tasks are fired by the executor when their
dependency completes — they must not have their own `schedule` block unless they are also
designed to run independently.

Giving a downstream task both a `schedule` and a `dependsOn` creates a race: the task may
self-fire before its dependency has run, arriving without the prior-phase context it expects.

```yaml
# ✅ Correct: only the root is scheduled
# skill-survey.yaml
schedule:
  interval: 300
preCondition: |
  Check if there are new spores worth surveying for skill candidates.
  If nothing qualifies, respond with exactly: SKIP

# skill-generate.yaml  (no schedule — triggered via dependsOn chain)
dependsOn: skill-survey
```

### 6. Test before relying on the schedule

Trigger the task manually from the Daemon UI once to confirm it completes correctly. Manual runs
go through the same executor path as scheduled runs, so a clean manual run means the schedule
will behave identically.

To force a scheduled fire sooner for testing, temporarily shorten the `interval` (e.g., to `60`
seconds), watch the Tasks page for the run to appear, then restore the production value before
committing.

## Common Pitfalls

**`preCondition` must return exactly `SKIP`.** The check is case-sensitive and whitespace-sensitive.
Instruct the preCondition prompt to output `SKIP` with no surrounding prose. Adding hedging language
like "The vault appears current — SKIP" will cause every scheduled fire to run the full task.

**Don't schedule phase-only tasks.** Tasks that exist purely to be called as phases within another
task (via `dependsOn`) should not carry their own `schedule`. They're designed to receive context
from a parent run; firing them independently skips that context and can produce empty or hallucinated
output.

**Audit log interleaving.** When two scheduled tasks fire close together, their audit log entries
interleave. If you're reading the log to debug a specific task, filter by `task_id` — don't try
to read interleaved output from two concurrent tasks as a single coherent trace.

**Skill lifecycle tasks need their `preCondition` preserved.** `skill-survey`, `skill-generate`,
and `skill-evolve` all run on short intervals and rely on `preCondition` to exit early when idle.
If you adjust their schedules, keep the preCondition intact. Removing it causes the agent to spin
on every tick even when there are no candidates to process, burning LLM quota.
