---
name: myco:power-management-scheduled-tasks
display_name: Power Management and Scheduled Task Development
description: >
  Comprehensive procedures for authoring, configuring, and maintaining Myco's PowerManager infrastructure and scheduled task system. Covers PowerManager job registration and lifecycle, task scheduler architecture and configuration, per-project power state tracking implementation, scheduled task fan-out across Groves, cold-project gating and threshold management, and fire-and-forget dispatch patterns for long-running tasks.
managed_by: myco
user-invocable: false
allowed-tools: [Read, Edit, Write, Bash, Grep, Glob]
---

# Power Management and Scheduled Task Development

Comprehensive procedures for authoring, configuring, and maintaining Myco's PowerManager infrastructure and scheduled task system within Grove multi-tenant architecture, including the new portable project identity model.

## PowerManager Job Registration and Lifecycle

### Registering New PowerManager Jobs

PowerManager jobs are registered through `registerPowerJobs()` in `packages/myco/src/daemon/power-jobs.ts`. The function signature takes a `JobRunner` instance (not `PowerManager`):

```typescript
import { registerPowerJobs } from './power-jobs.js';

// Register all power-managed jobs during daemon startup
const powerJobs = registerPowerJobs(jobRunner, {
  registry,
  logger,
  liveConfig,
  machineId,
  cache: runtimeCache,
  embeddingRuntimeFactory: buildGroveEmbeddingRuntime,
  onCanopyMassAdd: (groveId, projectId) =>
    scheduledTaskKicker.kick('canopy-describe', { groveId, projectId }),
  daemonVaultDir: vaultDir,
});
```

### Implementing New PowerManager Jobs

Add new job implementations to `packages/myco/src/daemon/power-jobs.ts` within the `registerPowerJobs()` function using the `JobRunner` API. The `kind` field controls two-lane fair scheduling — `'drain'` for time-sensitive jobs (embedding drain, outbox), `'housekeeping'` for background maintenance:

```typescript
export function registerPowerJobs(runner: JobRunner, deps: PowerJobDeps): PowerJobsResult {
  // Register existing jobs (embedding-reconcile, session-maintenance, etc.)
  
  // Add your new job
  runner.register({
    name: POWER_JOB_NAMES.YOUR_NEW_JOB,
    runIn: ['active', 'idle', 'sleep'], // States where job can run
    kind: 'housekeeping', // 'housekeeping' (maintenance) or 'drain' (time-sensitive)
    fn: () => yourNewJobImplementation(deps)
  });
  
  // Return job handles for external coordination
  return { canopy };
}
```

### Grove-Scoped Iteration Pattern

Use the `forEachGrove` primitive from `packages/myco/src/daemon/scope-iteration.ts` for jobs that need to iterate across all Groves:

```typescript
import { forEachGrove } from './scope-iteration.js';

async function yourNewJobImplementation(deps: PowerJobDeps): Promise<void> {
  await forEachGrove(deps.cache, deps.logger, async (scope) => {
    // Job logic scoped to this Grove
    // scope.db is the Grove's database connection
    // scope.grove contains Grove metadata
  });
}
```

### Grove Handle Pin/Unpin for Async Safety

When dispatching fire-and-forget tasks that may outlive the immediate Grove iteration, use the pin pattern:

```typescript
await forEachGrove(cache, logger, async (scope) => {
  return cache.withPinned(scope.grove.databasePath, async () => {
    // Start fire-and-forget task
    await runAgent(taskName, { projectId, databasePath: scope.grove.databasePath });
    // Grove DB handle stays alive during task startup
  });
});
```

## Task Scheduler Configuration and Architecture

### Task Scheduler Implementation

Scheduled tasks are registered via `registerScheduledTasks()` in `packages/myco/src/daemon/task-scheduling.ts`. It takes a `JobRunner` and returns a `ScheduledJobKicker`:

```typescript
import { registerScheduledTasks } from './task-scheduling.js';

// Register all scheduled tasks with the JobRunner during daemon startup
const scheduledTaskKicker = await registerScheduledTasks(jobRunner, {
  definitionsDir,
  vaultDir,
  logger,
  cache: runtimeCache,
  mycoHome,
  daemonStateDir,
  machineId,
  projectStateTracker,
});
```

Internally, `registerScheduledTasks` uses `buildScheduledJobs` from `packages/myco/src/daemon/task-scheduler.ts` to register each agent task as a `JobRunner` job. The `ScheduledJobKicker` interface is returned for manual kicks (e.g., `kick('canopy-describe', { groveId, projectId })`).

### Understanding Scheduler Dispatch Patterns

The task scheduler implements:

- **Per-project dispatch**: Each project gets independent task throttling and execution
- **Broadcast snapshot semantics**: Kick sets captured once per cycle, preventing thundering herd
- **Idempotent kicks**: Multiple kicks to same project in one cycle execute only once

### Configuring Agent Task Parameters

Agent tasks are configured through the agent task registry with these key parameters:

```yaml
# In agent task definitions
run_in: 60s         # Minimum interval between executions per project  
timeout: 300s       # Maximum execution time before task is considered failed
per_project: true   # Boolean flag enabling per-project fan-out vs daemon-wide execution
```

The scheduler reads these from `loadAllTasks()` in the agent registry and builds `ScheduledJob` objects accordingly.

## Per-Project Power State Tracking Implementation

### ProjectPowerStateTracker Usage Patterns

Import and use the tracker from `packages/myco/src/daemon/project-power-state.ts`:

```typescript
import { ProjectPowerStateTracker } from './project-power-state.js';

const tracker = new ProjectPowerStateTracker();

// Get current state using portable project identity
const state = tracker.getState(groveId, bindingId);
// Returns: 'active' | 'idle' | 'sleep' | 'deep_sleep'

// Get state with hold information  
const { state, hold } = tracker.getStateWithHold(groveId, bindingId);

// Record activity to bump to active state
tracker.recordActivity(groveId, bindingId);
```

### Project Identity Resolution via binding_id

Power state tracking now uses stable `binding_id` from `.myco/project.toml` rather than transient project identifiers:

```typescript
// Read binding_id from project.toml for stable project identity
import { readProjectConfig } from '../grove/project-config.js';

async function resolveProjectIdentity(projectPath: string): Promise<string> {
  const projectConfig = await readProjectConfig(projectPath);
  return projectConfig.binding_id; // Stable across machines and clones
}

// Use binding_id in power state operations
const bindingId = await resolveProjectIdentity(projectScope.projectVaultDir);
tracker.recordActivity(groveScope.grove.id, bindingId);
```

### Active/Idle/Sleep/Deep-Sleep State Management

Power states transition based on inactivity thresholds defined in `ProjectPowerStateConfig`:

```typescript
interface ProjectPowerStateConfig {
  idleThresholdMs: number;      // ms without activity before transitioning to idle
  sleepThresholdMs: number;     // ms without activity before transitioning to sleep  
  deepSleepThresholdMs: number; // ms without activity before transitioning to deep_sleep
}
```

State machine is per `(groveId, bindingId)` tuple for portable project tracking across machine boundaries.

### Activity Recording at Key Lifecycle Events

Wire activity recording at daemon event dispatch points:

1. **Session registration** when new sessions are established
2. **User prompt dispatch** in `packages/myco/src/daemon/event-dispatch.ts`:
```typescript
if (event.type === 'user_prompt') {
  const bindingId = await resolveProjectIdentity(event.projectPath);
  tracker.recordActivity(groveId, bindingId);
}
```

### Boot-Time Power State Clock Maintenance

Initialize tracker state from existing database records using `readProjectActivitySeed()`:

```typescript
const seedMap = await tracker.readProjectActivitySeed(bootDb);
// Prevents projects from starting as deep_sleep after daemon restart
// when they were recently active
```

## Scheduled Task Fan-Out Across Groves and Projects

### Three-Tier Scope Iteration Pattern

Use the three-tier pattern from `packages/myco/src/daemon/scope-iteration.ts` for comprehensive task dispatch:

```typescript
import { forEachGrove, forEachRegisteredProject, isProjectActive } from './scope-iteration.js';

// Level 1: All Groves
await forEachGrove(cache, logger, async (groveScope) => {
  
  // Level 2: All registered projects in this Grove  
  await forEachRegisteredProject(cache, logger, async (projectScope) => {
    
    // Level 3: Check if project is active via binding_id
    const bindingId = await resolveProjectIdentity(projectScope.projectVaultDir);
    if (isProjectActive(projectScope.project)) {
      // Dispatch task for this (grove, binding_id) combination
      await dispatchTask(groveScope.grove.id, bindingId, projectScope);
    }
  });
});
```

### Grove Handle Pin/Unpin Across Async Boundaries

Critical pattern for fire-and-forget dispatch safety:

```typescript
await forEachRegisteredProject(cache, logger, async (projectScope) => {
  return cache.withPinned(projectScope.grove.databasePath, async () => {
    // Task starts with pinned handle
    const bindingId = await resolveProjectIdentity(projectScope.projectVaultDir);
    await runAgent(task.name, { 
      projectId: bindingId,  // Use binding_id for portable identity
      databasePath: projectScope.grove.databasePath 
    });
    // Handle stays open during async startup
  });
});
```

### ProjectScope Structure

The `ProjectScope` object provides all necessary context for task dispatch:

```typescript
interface ProjectScope {
  grove: GroveDetails;        // Grove metadata and paths
  project: ProjectDetails;    // Project configuration with binding_id
  db: Database;              // Open database connection
  projectVaultDir: string;   // Resolved vault directory path
}
```

## Cold-Project Gating and Threshold Management

### Cold Project Gating Implementation

Use the `decideColdProjectGate()` function from `packages/myco/src/daemon/task-scheduling.ts`:

```typescript
import type { ColdProjectGateDecision, ColdProjectGateInput } from './task-scheduling.js';
import { decideColdProjectGate } from './task-scheduling.js';

// Resolve binding_id for stable project identity
const bindingId = await resolveProjectIdentity(projectScope.projectVaultDir);

const gateResult: ColdProjectGateDecision = decideColdProjectGate({
  db: projectScope.db,
  projectId: bindingId,  // Use binding_id for consistent gating across machines
  thresholdDays: config.maintenance.agent.cold_project_threshold_days,
  now: Date.now()
});

if (!gateResult.should_run) {
  logger.info('Skipping cold project', {
    projectId: bindingId,
    state: gateResult.state
  });
  return;
}
```

### Threshold Configuration

Configure cold project threshold in `.myco/config.yaml`:

```yaml
maintenance:
  agent:
    cold_project_threshold_days: 14  # default; 0 to disable; range 0-365
```

### Cost Discipline Enforcement

Cold gating saves ~$2-5/month per inactive project by preventing:
- Skill survey execution on dormant projects via `skill-survey` task throttling
- Vault evolution tasks on unused codebases via `vault-evolve` task throttling
- Canopy describe operations on stale projects via `canopy-describe` task throttling

### Configurable 0-365 Day Ranges

Threshold validation in `decideColdProjectGate()` enforces reasonable ranges:
- `0`: Disables cold gating (lenient case for experimental/dogfood installs)
- `1-365`: Valid threshold range for production use
- Default `14`: Balances cost savings with reactivation responsiveness

## Fire-and-Forget Dispatch Patterns for Long-Running Tasks

### Task Execution Isolation

Tasks execute in isolated processes via the agent harness system:

```typescript
// Fire-and-forget - returns immediately
const bindingId = await resolveProjectIdentity(projectScope.projectVaultDir);
await runAgent(taskName, {
  projectId: bindingId,  // Use binding_id for portable project identity
  databasePath: projectScope.grove.databasePath,
  ...taskConfig
});
```

### Parallel Grove Sweeps Optimization

Optimized fan-out pattern reduces wall-clock time through parallel Grove iteration:

```typescript
// Collect Grove promises for parallel execution
const grovePromises: Promise<void>[] = [];

await forEachGrove(cache, logger, async (groveScope) => {
  const grovePromise = forEachRegisteredProject(cache, logger, async (projectScope) => {
    // Per-project dispatch in parallel within each Grove
    await dispatchTaskForProject(projectScope);
  });
  
  grovePromises.push(grovePromise);
});

// Wait for all Grove sweeps to complete
await Promise.all(grovePromises);
```

### Fair-Share Scheduler Coordination

The `JobRunner` prevents resource contention through two-lane fair scheduling:

- **Two-lane scheduling**: `kind: 'drain'` (time-sensitive: embedding, outbox) and `kind: 'housekeeping'` (background maintenance). When both lanes have work, neither holds more than `concurrency-1` slots — each lane is always guaranteed at least one slot.
- **Per-project running flags**: Prevents concurrent task execution per project
- **Independent throttle timers**: Each project maintains separate `lastRun` timestamp using binding_id
- **Broadcast semantics**: Multiple events for same project coalesce into single dispatch via kick deduplication

## Gotchas

### Power State vs Cold Gating Distinction

- **Power state** (`active`/`idle`/`sleep`/`deep_sleep`): Real-time activity tracking via `ProjectPowerStateTracker` for immediate dispatch decisions
- **Cold gating**: Historical analysis of session/prompt activity over days/weeks via `decideColdProjectGate` for cost discipline

Both systems are independent - a project can be power-state `active` but still cold-gated if it hasn't had activity in the threshold period.

### Grove Handle Lifetime Management

Always use the pin pattern for fire-and-forget dispatch:

```typescript
// WRONG - handle may close before async task starts
await runAgent(taskName, config);

// RIGHT - pinned handle survives async boundary  
return cache.withPinned(grove.databasePath, async () => {
  await runAgent(taskName, config);
});
```

### Activity Recording Double-Writes

Only record activity at the two designated points (session registration and user prompt dispatch). Additional recording points create false warmth signals and skew power state transitions.

### Power Job Registration vs Task Scheduler

- **Power jobs** (`packages/myco/src/daemon/power-jobs.ts`, `registerPowerJobs(runner, deps)`): Background and drain jobs registered directly with `runner.register({..., kind: 'housekeeping' | 'drain'})`. Two-lane fair scheduling ensures drain jobs (time-sensitive) are never starved by housekeeping jobs.
- **Scheduled tasks** (`packages/myco/src/daemon/task-scheduling.ts`, `registerScheduledTasks(runner, deps)`): Agent tasks (skill-survey, vault-evolve) dispatched per-project with throttling via `run_in` intervals.

These are separate systems with different lifecycle patterns and configuration mechanisms.

### Scope Iteration Safety

Grove context automatically propagates through `forEachGrove` and `forEachRegisteredProject`. Manually passing Grove metadata breaks the context chain and causes dispatch failures:

```typescript
// Wrong - manual Grove metadata passing
await manualGroveIteration(groveId, projectId);

// Right - use scope iteration primitives
await forEachRegisteredProject(cache, logger, async (projectScope) => {
  // projectScope contains all necessary context
});
```

### Project Identity Migration from Legacy IDs

When migrating from legacy project identifiers to `binding_id`:

```typescript
// Migration pattern for existing power state data
async function migrateProjectPowerState(
  tracker: ProjectPowerStateTracker,
  legacyProjectId: string,
  bindingId: string
): Promise<void> {
  const legacyState = tracker.getState(groveId, legacyProjectId);
  
  if (legacyState !== 'deep_sleep') {
    // Preserve active/idle/sleep state for binding_id
    tracker.recordActivity(groveId, bindingId);
    
    // Clean up legacy entry
    tracker.clearState(groveId, legacyProjectId);
  }
}
```

### Portable Project Identity Consistency

Always use `binding_id` from `.myco/project.toml` for project identification rather than derived identifiers:

```typescript
// WRONG - derived project identifier
const projectId = path.basename(projectPath);

// RIGHT - stable binding_id from project.toml
const projectConfig = await readProjectConfig(projectPath);
const projectId = projectConfig.binding_id;
```
