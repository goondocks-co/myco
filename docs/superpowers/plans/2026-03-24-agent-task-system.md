# Agent Task System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Myco's static agent pipeline into a full task system where users can create, configure, and run custom intelligence tasks with phased execution, per-phase model selection, and context-aware orchestration.

**Architecture:** Adopts OAK's template/task separation pattern. Built-in agent definition (`agent.yaml`) defines capabilities (tools, permissions). Tasks define what to do — with phases, tool scoping, model overrides, and context queries. A registry discovers both built-in tasks (from YAML) and user tasks (from vault directory). The executor resolves effective config by merging definition + DB overrides + task phases. API routes and CLI commands provide full CRUD.

**Tech Stack:** TypeScript, Zod validation, PGlite (SQLite dialect), Claude Agent SDK, YAML task definitions

**Prior work:** The phased executor is already built on branch `feat/phased-executor` — it supports `PhaseDefinition[]` in task YAML with per-phase tools, turn limits, and model overrides. This plan extends that foundation.

**Reference:** OAK's agent runtime at `~/Repos/open-agent-kit/src/open_agent_kit/features/agent_runtime/` — especially `models.py` (task schema), `registry.py` (discovery), `executor.py` (prompt composition), and `routes/agents.py` (API).

---

## Design Decisions

### DB storage: use existing `config` column

The `agent_tasks` table already has a `config TEXT` column (schema.ts:327) intended for extension data. Rather than adding new columns via a migration, we store `phases`, `execution`, and `contextQueries` as a JSON object in `config`. No schema migration needed.

```typescript
// config column stores:
interface TaskConfig {
  phases?: PhaseDefinition[];
  execution?: ExecutionConfig;
  contextQueries?: Record<string, ContextQuery[]>;
  schemaVersion?: number;
}
```

### `isDefault` vs `isBuiltin` are separate concepts

- `isDefault: boolean` — "this is the default task for the agent" (exactly one per agent)
- `isBuiltin: boolean` — "this task ships with the package" (many can be built-in)

Both coexist. A built-in task can be the default. A user task cannot be isDefault (the default is always the built-in full-intelligence task).

### Config override precedence

When multiple levels define the same field, highest priority wins:

```
execution.model > task.model > agentRow.model > agentDefinition.model
execution.maxTurns > task.maxTurns > agentRow.max_turns > agentDefinition.maxTurns
execution.timeoutSeconds > task.timeoutSeconds > agentRow.timeout_seconds > agentDefinition.timeoutSeconds
```

The `execution` block is for task-level overrides that are independent of the YAML top-level fields. This matches OAK's pattern where `AgentTask.execution` overrides `AgentDefinition.execution`.

### Registry: no cache, always load from disk

For simplicity and correctness, the registry loads all tasks from disk on every call to `loadAllTasks()`. With single-digit task file counts, this is fast enough. No module-level mutable cache. Mutations (create/copy/delete) write to disk; the next read picks up changes automatically. This satisfies CLAUDE.md's idempotence requirement.

### Context query execution deferred to Plan 2

This plan adds `contextQueries` to the schema and types but does NOT wire them into the executor. Context queries run before phases and require orchestrator intelligence to decide which queries are relevant. Plan 2 (Orchestrator Intelligence) implements the execution.

### Provider configuration deferred to Plan 2

This plan adds `ProviderConfig` to types and schemas. Actual environment variable injection (the OAK pattern: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) is deferred to Plan 2 where the orchestrator handles model routing.

---

## Subsystem Scope

This plan covers **Task Schema + User Task Registry + API** — the foundation layer. Two follow-up plans build on this:

- **Plan 2: Orchestrator Intelligence** — dynamic phase planning, vault-state-aware dispatch, context query execution, provider routing
- **Plan 3: Dashboard Task Management** — UI for creating, editing, and running tasks

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/agent/registry.ts` | Discover and load built-in + user tasks, validate, write/delete user tasks |
| `src/agent/schemas.ts` | Zod schemas for task YAML validation (extracted from loader.ts) |
| `src/daemon/api/agent-tasks.ts` | API route handlers for task CRUD |
| `src/cli/agent-tasks.ts` | CLI commands: `myco task list`, `myco task create`, `myco task copy` |
| `tests/agent/registry.test.ts` | Registry tests |
| `tests/agent/schemas.test.ts` | Schema validation tests |
| `tests/daemon/api/agent-tasks.test.ts` | API route tests |

### Modified Files

| File | Changes |
|------|---------|
| `src/agent/types.ts` | Add ContextQuery, ExecutionConfig, ProviderConfig, TaskConfig; extend AgentTask |
| `src/agent/loader.ts` | Import schemas from `schemas.ts` instead of inline; persist config JSON on upsert |
| `src/agent/executor.ts` | Use registry instead of direct loader calls; apply execution overrides |
| `src/db/queries/tasks.ts` | Parse/serialize config column; add `deleteTask` |
| `src/daemon/main.ts` | Register new API routes; replace existing GET /api/agent/tasks (line 933) |
| `src/cli.ts` | Add `task` to subcommand dispatch |
| `src/constants.ts` | Add USER_TASKS_DIR, USER_TASK_SOURCE, TASK_NAME_PATTERN, MAX_TASK_NAME_LENGTH |

---

## Task 1: Extract Schemas and Extend Task Types

**Files:**
- Create: `src/agent/schemas.ts`
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loader.ts`
- Create: `tests/agent/schemas.test.ts`

- [ ] **Step 1: Define extended types in `src/agent/types.ts`**

Add new interfaces after the existing `PhaseResult` interface:

```typescript
/** Context query that runs before task execution to gather vault state. */
export interface ContextQuery {
  tool: string;
  queryTemplate: string;
  limit: number;
  purpose: string;
  required: boolean;
}

/** API provider configuration for task execution. */
export interface ProviderConfig {
  type: 'cloud' | 'ollama' | 'lmstudio';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** Execution configuration overrides for a task. */
export interface ExecutionConfig {
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
  provider?: ProviderConfig;
}

/**
 * Extended config stored as JSON in the agent_tasks.config column.
 * Structural data that doesn't fit in flat columns.
 */
export interface TaskConfig {
  phases?: PhaseDefinition[];
  execution?: ExecutionConfig;
  contextQueries?: Record<string, ContextQuery[]>;
  schemaVersion?: number;
}
```

Add `source` and `isBuiltin` to `AgentTask`:

```typescript
export interface AgentTask {
  // ... existing fields (name, displayName, description, agent, prompt,
  //     isDefault, toolOverrides?, model?, maxTurns?, timeoutSeconds?, phases?) ...
  execution?: ExecutionConfig;
  contextQueries?: Record<string, ContextQuery[]>;
  isBuiltin: boolean;
  source?: 'built-in' | 'user';
  schemaVersion?: number;
}
```

- [ ] **Step 2: Create `src/agent/schemas.ts`**

Move Zod schemas from `loader.ts` (lines 42-76) into this new file:

```typescript
import { z } from 'zod/v4';

export const CURRENT_TASK_SCHEMA_VERSION = 1;

export const ProviderConfigSchema = z.object({
  type: z.enum(['cloud', 'ollama', 'lmstudio']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

export const ExecutionConfigSchema = z.object({
  model: z.string().optional(),
  maxTurns: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  provider: ProviderConfigSchema.optional(),
});

export const ContextQuerySchema = z.object({
  tool: z.string(),
  queryTemplate: z.string(),
  limit: z.number().default(10),
  purpose: z.string(),
  required: z.boolean().default(false),
});

export const PhaseDefinitionSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()),
  maxTurns: z.number(),
  model: z.string().optional(),
  required: z.boolean(),
});

export const AgentDefinitionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  model: z.string(),
  maxTurns: z.number(),
  timeoutSeconds: z.number(),
  systemPromptPath: z.string(),
  tools: z.array(z.string()),
});

export const AgentTaskSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  agent: z.string(),
  prompt: z.string(),
  isDefault: z.boolean(),
  toolOverrides: z.array(z.string()).optional(),
  model: z.string().optional(),
  maxTurns: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  phases: z.array(PhaseDefinitionSchema).optional(),
  execution: ExecutionConfigSchema.optional(),
  contextQueries: z.record(z.string(), z.array(ContextQuerySchema)).optional(),
  schemaVersion: z.number().optional(),
});
```

- [ ] **Step 3: Update `loader.ts` — replace inline schemas with imports**

In `src/agent/loader.ts`, replace lines 42-76 (the inline Zod schemas) with:

```typescript
import {
  AgentDefinitionSchema,
  AgentTaskSchema,
  PhaseDefinitionSchema,
} from './schemas.js';
```

Delete the `PhaseDefinitionSchema`, `AgentDefinitionSchema`, and `AgentTaskSchema` definitions from `loader.ts`. Keep all other code unchanged.

- [ ] **Step 4: Run existing tests to verify no regressions**

Run: `npx vitest run tests/agent/loader.test.ts tests/agent/executor.test.ts`
Expected: All existing tests pass (schema extraction is a pure refactor).

- [ ] **Step 5: Write schema validation tests**

Create `tests/agent/schemas.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { AgentTaskSchema, AgentDefinitionSchema } from '@myco/agent/schemas.js';

describe('AgentTaskSchema', () => {
  it('validates minimal task (no optional fields)', () => { /* ... */ });
  it('validates task with phases array', () => { /* ... */ });
  it('validates task with execution overrides', () => { /* ... */ });
  it('validates task with contextQueries', () => { /* ... */ });
  it('rejects task missing required fields', () => { /* ... */ });
  it('rejects task with invalid phase (missing tools)', () => { /* ... */ });
  it('rejects invalid provider type', () => { /* ... */ });
});
```

- [ ] **Step 6: Run schema tests**

Run: `npx vitest run tests/agent/schemas.test.ts`

- [ ] **Step 7: Commit**

```bash
git add src/agent/schemas.ts src/agent/types.ts src/agent/loader.ts tests/agent/schemas.test.ts
git commit -m "refactor(agent): extract Zod schemas, extend task types with execution/provider/contextQueries"
```

---

## Task 2: Persist Task Config in DB

**Files:**
- Modify: `src/db/queries/tasks.ts`
- Modify: `src/agent/loader.ts`
- Test: `tests/db/queries/tasks.test.ts` (extend)

No schema migration — we use the existing `config TEXT` column on `agent_tasks`.

- [ ] **Step 1: Add config serialization helpers to `tasks.ts`**

In `src/db/queries/tasks.ts`, add helpers to serialize/deserialize the `config` column:

```typescript
import type { TaskConfig, PhaseDefinition, ExecutionConfig, ContextQuery } from '@myco/agent/types.js';

/** Serialize TaskConfig to JSON for the config column. */
function serializeConfig(config: TaskConfig | null): string | null {
  if (!config) return null;
  return JSON.stringify(config);
}

/** Deserialize config column JSON to TaskConfig. */
function deserializeConfig(raw: string | null): TaskConfig | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as TaskConfig; } catch { return null; }
}
```

- [ ] **Step 2: Update `upsertTask` to accept and persist config**

Update `TaskInsert` to include a `config` field (it already exists as a column). When upserting, serialize the `TaskConfig` into the `config` column.

- [ ] **Step 3: Update `getTask` and `listTasks` to return parsed config**

After fetching a `TaskRow`, parse the `config` column and attach `phases`, `execution`, `contextQueries` to the returned object for API consumers.

- [ ] **Step 4: Add `deleteTask` query**

```typescript
export async function deleteTask(id: string): Promise<boolean> {
  const db = getDatabase();
  const result = await db.query(
    `DELETE FROM agent_tasks WHERE id = $1 AND source != $2 RETURNING id`,
    [id, BUILT_IN_SOURCE],
  );
  return result.rows.length > 0;
}
```

Import `BUILT_IN_SOURCE` from `loader.ts` or define in constants. Built-in tasks (where `source = 'built-in'`, set by `registerBuiltInAgentsAndTasks`) cannot be deleted.

- [ ] **Step 5: Update `registerBuiltInAgentsAndTasks` in `loader.ts`**

When upserting built-in tasks, serialize `phases` and `execution` into the `config` column:

```typescript
await upsertTask({
  // ... existing fields ...
  config: JSON.stringify({
    phases: task.phases ?? null,
    execution: task.execution ?? null,
    contextQueries: task.contextQueries ?? null,
    schemaVersion: task.schemaVersion ?? 1,
  }),
});
```

- [ ] **Step 6: Extend existing task tests**

Add tests to `tests/db/queries/tasks.test.ts`:
- Upsert task with config containing phases, read back and verify phases parsed
- Upsert task with config containing execution overrides, read back and verify
- Config column null when no extended config provided
- Delete user task (source='user') succeeds
- Delete built-in task (source='built-in') returns false

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/db/queries/tasks.test.ts`

- [ ] **Step 8: Commit**

```bash
git add src/db/queries/tasks.ts src/agent/loader.ts tests/db/queries/tasks.test.ts
git commit -m "feat(db): persist phases/execution in agent_tasks.config column, add deleteTask"
```

---

## Task 3: User Task Registry

**Files:**
- Create: `src/agent/registry.ts`
- Modify: `src/constants.ts`
- Create: `tests/agent/registry.test.ts`

- [ ] **Step 1: Add constants**

In `src/constants.ts`:

```typescript
/** Subdirectory within the vault for user-created task YAML files. */
export const USER_TASKS_DIR = 'tasks';

/** Source label for user-created tasks. */
export const USER_TASK_SOURCE = 'user';

/** Task name validation pattern (lowercase, hyphens, digits). */
export const TASK_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

/** Maximum length for task names. */
export const MAX_TASK_NAME_LENGTH = 50;
```

- [ ] **Step 2: Create `src/agent/registry.ts`**

No module-level cache — always load from disk. Simple and correct.

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AgentTaskSchema } from './schemas.js';
import { loadAgentTasks } from './loader.js';
import {
  USER_TASKS_DIR,
  USER_TASK_SOURCE,
  TASK_NAME_PATTERN,
  MAX_TASK_NAME_LENGTH,
} from '@myco/constants.js';
import type { AgentTask } from './types.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** Source label for built-in tasks (matches loader.ts BUILT_IN_SOURCE). */
const BUILT_IN_SOURCE = 'built-in';

// -------------------------------------------------------------------------
// Discovery
// -------------------------------------------------------------------------

/**
 * Load all tasks from built-in definitions and user vault directory.
 * User tasks with the same name as built-in tasks override them.
 * Always reads from disk — no caching.
 */
export function loadAllTasks(
  definitionsDir: string,
  vaultDir?: string,
): Map<string, AgentTask> {
  const tasks = new Map<string, AgentTask>();

  // 1. Built-in tasks from definitions/tasks/
  for (const task of loadAgentTasks(definitionsDir)) {
    tasks.set(task.name, { ...task, source: BUILT_IN_SOURCE, isBuiltin: true });
  }

  // 2. User tasks from vault/tasks/
  if (vaultDir) {
    const userTasksDir = path.join(vaultDir, USER_TASKS_DIR);
    if (fs.existsSync(userTasksDir)) {
      for (const file of fs.readdirSync(userTasksDir).filter(f => f.endsWith('.yaml'))) {
        try {
          const raw = fs.readFileSync(path.join(userTasksDir, file), 'utf-8');
          const parsed = AgentTaskSchema.parse(parseYaml(raw));
          tasks.set(parsed.name, {
            ...parsed,
            source: USER_TASK_SOURCE,
            isBuiltin: false,
          });
        } catch {
          // Skip malformed user task files — log but don't crash
          console.warn(`[registry] Failed to parse user task: ${file}`);
        }
      }
    }
  }

  return tasks;
}

// -------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------

/** Validate a task name (lowercase, hyphens, digits, max length). */
export function validateTaskName(name: string): boolean {
  return name.length <= MAX_TASK_NAME_LENGTH && TASK_NAME_PATTERN.test(name);
}

// -------------------------------------------------------------------------
// Write operations
// -------------------------------------------------------------------------

/**
 * Write a user task YAML file to the vault tasks directory.
 * Validates the task through AgentTaskSchema before writing.
 */
export function writeUserTask(vaultDir: string, task: AgentTask): string {
  const tasksDir = path.join(vaultDir, USER_TASKS_DIR);
  fs.mkdirSync(tasksDir, { recursive: true });

  // Strip internal fields before serializing to YAML
  const { source: _source, isBuiltin: _isBuiltin, ...yamlFields } = task;

  // Validate before writing — prevents malformed files on disk
  AgentTaskSchema.parse(yamlFields);

  const filePath = path.join(tasksDir, `${task.name}.yaml`);
  fs.writeFileSync(filePath, stringifyYaml(yamlFields), 'utf-8');
  return filePath;
}

/** Delete a user task YAML file. Returns true if deleted. */
export function deleteUserTask(vaultDir: string, taskName: string): boolean {
  const filePath = path.join(vaultDir, USER_TASKS_DIR, `${taskName}.yaml`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

/**
 * Copy a task to the user tasks directory for customization.
 * Returns the new user task.
 */
export function copyTaskToUser(
  definitionsDir: string,
  vaultDir: string,
  sourceName: string,
  newName?: string,
): AgentTask {
  const allTasks = loadAllTasks(definitionsDir, vaultDir);
  const sourceTask = allTasks.get(sourceName);
  if (!sourceTask) throw new Error(`Task "${sourceName}" not found`);

  const name = newName ?? `${sourceName}-custom`;
  if (!validateTaskName(name)) {
    throw new Error(`Invalid task name "${name}" — use lowercase, hyphens, digits, max ${MAX_TASK_NAME_LENGTH} chars`);
  }

  const userTask: AgentTask = {
    ...sourceTask,
    name,
    displayName: `${sourceTask.displayName} (Custom)`,
    isDefault: false,
    isBuiltin: false,
    source: USER_TASK_SOURCE,
  };

  writeUserTask(vaultDir, userTask);
  return userTask;
}
```

- [ ] **Step 3: Write registry tests**

Create `tests/agent/registry.test.ts` using `fs.mkdtempSync` for test isolation:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAllTasks, validateTaskName, writeUserTask, deleteUserTask, copyTaskToUser } from '@myco/agent/registry.js';

describe('loadAllTasks', () => {
  it('discovers built-in tasks from definitions dir');
  it('discovers user tasks from vault tasks dir');
  it('user task with same name overrides built-in');
  it('skips malformed user task YAML without crashing');
});

describe('validateTaskName', () => {
  it('accepts valid names: my-task, a, task-123');
  it('rejects invalid names: My-Task, task_name, -leading, trailing-');
  it('rejects names longer than MAX_TASK_NAME_LENGTH');
});

describe('writeUserTask', () => {
  it('creates YAML file in vault tasks dir');
  it('validates task before writing (rejects malformed)');
  it('creates tasks dir if it does not exist');
});

describe('deleteUserTask', () => {
  it('removes file from disk and returns true');
  it('returns false for non-existent file');
});

describe('copyTaskToUser', () => {
  it('creates user copy with -custom suffix');
  it('uses custom name when provided');
  it('throws on invalid task name');
  it('throws on non-existent source task');
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/agent/registry.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/agent/registry.ts src/constants.ts tests/agent/registry.test.ts
git commit -m "feat(agent): add user task registry with built-in + user task discovery"
```

---

## Task 4: Task CRUD API Routes

**Files:**
- Create: `src/daemon/api/agent-tasks.ts`
- Modify: `src/daemon/main.ts`
- Create: `tests/daemon/api/agent-tasks.test.ts`

- [ ] **Step 1: Create `src/daemon/api/agent-tasks.ts`**

Import types from `../router.js` (not `../types.js` — that file doesn't exist):

```typescript
import type { RouteRequest, RouteResponse } from '../router.js';
import { loadAllTasks, writeUserTask, deleteUserTask, copyTaskToUser, validateTaskName } from '@myco/agent/registry.js';
import { resolveDefinitionsDir } from '@myco/agent/loader.js';
import { AgentTaskSchema } from '@myco/agent/schemas.js';

export async function handleListTasks(req: RouteRequest, vaultDir: string): Promise<RouteResponse> {
  const definitionsDir = resolveDefinitionsDir();
  const tasks = loadAllTasks(definitionsDir, vaultDir);
  const source = req.query?.source as 'built-in' | 'user' | undefined;
  const all = Array.from(tasks.values());
  const filtered = source ? all.filter(t => t.source === source) : all;
  return { status: 200, body: { tasks: filtered } };
}

export async function handleGetTask(req: RouteRequest, vaultDir: string): Promise<RouteResponse> {
  const taskId = req.params?.id;
  if (!taskId) return { status: 400, body: { error: 'Missing task ID' } };
  const definitionsDir = resolveDefinitionsDir();
  const tasks = loadAllTasks(definitionsDir, vaultDir);
  const task = tasks.get(taskId);
  if (!task) return { status: 404, body: { error: `Task "${taskId}" not found` } };
  return { status: 200, body: { task } };
}

export async function handleCreateTask(req: RouteRequest, vaultDir: string): Promise<RouteResponse> {
  const body = AgentTaskSchema.parse(req.body);
  if (!validateTaskName(body.name)) {
    return { status: 400, body: { error: 'Invalid task name — use lowercase, hyphens, digits' } };
  }
  const definitionsDir = resolveDefinitionsDir();
  const existing = loadAllTasks(definitionsDir, vaultDir).get(body.name);
  if (existing?.source === 'user') {
    return { status: 409, body: { error: `User task "${body.name}" already exists` } };
  }
  const task = { ...body, source: 'user' as const, isBuiltin: false };
  writeUserTask(vaultDir, task);
  return { status: 201, body: { task } };
}

export async function handleCopyTask(req: RouteRequest, vaultDir: string): Promise<RouteResponse> {
  const taskId = req.params?.id;
  if (!taskId) return { status: 400, body: { error: 'Missing task ID' } };
  const newName = typeof req.body?.name === 'string' ? req.body.name : undefined;
  const definitionsDir = resolveDefinitionsDir();
  const task = copyTaskToUser(definitionsDir, vaultDir, taskId, newName);
  return { status: 201, body: { task } };
}

export async function handleDeleteTask(req: RouteRequest, vaultDir: string): Promise<RouteResponse> {
  const taskId = req.params?.id;
  if (!taskId) return { status: 400, body: { error: 'Missing task ID' } };
  const definitionsDir = resolveDefinitionsDir();
  const tasks = loadAllTasks(definitionsDir, vaultDir);
  const task = tasks.get(taskId);
  if (!task) return { status: 404, body: { error: `Task "${taskId}" not found` } };
  if (task.source === 'built-in') {
    return { status: 403, body: { error: 'Cannot delete built-in tasks' } };
  }
  deleteUserTask(vaultDir, taskId);
  return { status: 200, body: { ok: true } };
}
```

- [ ] **Step 2: Register routes in `src/daemon/main.ts`**

Replace the existing `GET /api/agent/tasks` route (line 933 of main.ts) with the new handler. Add the remaining CRUD routes:

```typescript
// Replace existing GET /api/agent/tasks (line 933)
server.registerRoute('GET', '/api/agent/tasks', async (req) => handleListTasks(req, vaultDir));
server.registerRoute('GET', '/api/agent/tasks/:id', async (req) => handleGetTask(req, vaultDir));
server.registerRoute('POST', '/api/agent/tasks', async (req) => handleCreateTask(req, vaultDir));
server.registerRoute('POST', '/api/agent/tasks/:id/copy', async (req) => handleCopyTask(req, vaultDir));
server.registerRoute('DELETE', '/api/agent/tasks/:id', async (req) => handleDeleteTask(req, vaultDir));
```

Import the handlers at the top of main.ts.

- [ ] **Step 3: Write API route tests**

Create `tests/daemon/api/agent-tasks.test.ts`:
- GET /api/agent/tasks returns both built-in and user tasks
- GET /api/agent/tasks?source=user returns only user tasks
- GET /api/agent/tasks/:id returns task with phases in response
- POST /api/agent/tasks creates user task YAML file in vault
- POST /api/agent/tasks rejects invalid task name (400)
- POST /api/agent/tasks/:id/copy creates user copy of built-in (201)
- DELETE /api/agent/tasks/:id deletes user task (200)
- DELETE /api/agent/tasks/:id rejects built-in task deletion (403)
- GET /api/agent/tasks/:id returns 404 for unknown task

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/daemon/api/agent-tasks.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/daemon/api/agent-tasks.ts src/daemon/main.ts tests/daemon/api/agent-tasks.test.ts
git commit -m "feat(api): add task CRUD routes — list, get, create, copy, delete"
```

---

## Task 5: CLI Task Commands

**Files:**
- Create: `src/cli/agent-tasks.ts`
- Modify: `src/cli.ts`

Note: CLI commands delegate to daemon API (same pattern as `src/cli/agent-run.ts`). The API tests in Task 4 cover the backend logic. CLI testing is manual — this matches the existing pattern where no CLI modules have automated tests.

- [ ] **Step 1: Create `src/cli/agent-tasks.ts`**

Commands delegate to daemon API via `connectToDaemon()`:
- `myco task list [--source built-in|user]` — GET /api/agent/tasks
- `myco task show <name>` — GET /api/agent/tasks/:name
- `myco task create <name> --from <template>` — POST /api/agent/tasks/:template/copy
- `myco task delete <name>` — DELETE /api/agent/tasks/:name
- `myco task run <name> [--instruction TEXT]` — POST /api/agent/run with task param

Follow the pattern in `src/cli/agent-run.ts` for daemon connection.

- [ ] **Step 2: Add `task` to CLI dispatch in `src/cli.ts`**

Add `task` to the `SUBCOMMAND_DISPATCH` map, delegating to the new module.

- [ ] **Step 3: Verify CLI manually**

```bash
myco-dev task list
myco-dev task show full-intelligence
myco-dev task create my-extract --from extract-only
myco-dev task list --source user
myco-dev task delete my-extract
```

- [ ] **Step 4: Commit**

```bash
git add src/cli/agent-tasks.ts src/cli.ts
git commit -m "feat(cli): add task list/show/create/delete/run commands"
```

---

## Task 6: Update Executor to Use Registry

**Files:**
- Modify: `src/agent/executor.ts`
- Test: `tests/agent/executor.test.ts` (extend)

- [ ] **Step 1: Replace direct YAML loading with registry call**

In `src/agent/executor.ts`, replace the current YAML task loading (lines ~351-366):

```typescript
// Before:
const yamlTasks = loadAgentTasks(definitionsDir);
const yamlTask = taskName ? yamlTasks.find((t) => t.name === taskName) : undefined;

// After:
import { loadAllTasks } from './registry.js';
const allTasks = loadAllTasks(definitionsDir, vaultDir);
const yamlTask = taskName ? allTasks.get(taskName) : undefined;
```

This means `runAgent` now needs `vaultDir` passed through (it already receives it as the first argument).

- [ ] **Step 2: Apply execution config overrides in `resolveEffectiveConfig`**

Update `resolveEffectiveConfig` in `loader.ts` to handle the `execution` field from task config. Add after the existing task override block:

```typescript
// Apply execution config overrides (highest priority)
if (taskOverrides?.execution) {
  if (taskOverrides.execution.model) model = taskOverrides.execution.model;
  if (taskOverrides.execution.maxTurns) maxTurns = taskOverrides.execution.maxTurns;
  if (taskOverrides.execution.timeoutSeconds) timeoutSeconds = taskOverrides.execution.timeoutSeconds;
}
```

This implements the documented precedence: `execution.model > task.model > agent.model`.

- [ ] **Step 3: Update executor tests**

Add tests to `tests/agent/executor.test.ts`:
- "user task with custom phases executes all phases" — set `mockYamlPhases` via registry mock and verify phased execution
- "execution.model overrides task.model" — verify the SDK receives the execution model, not the task model
- "execution.maxTurns overrides task.maxTurns" — verify turn limits

- [ ] **Step 4: Run all tests**

Run: `make check`

- [ ] **Step 5: Commit**

```bash
git add src/agent/executor.ts src/agent/loader.ts tests/agent/executor.test.ts
git commit -m "feat(agent): executor uses registry for task resolution, supports execution config overrides"
```

---

## Task 7: Full Quality Gate + Integration Verification

- [ ] **Step 1: Run `make check`**

Run: `make check`
Expected: lint + all tests pass

- [ ] **Step 2: Build**

Run: `make build`
Expected: tsup bundle succeeds

- [ ] **Step 3: Integration test with daemon**

```bash
myco-dev restart
myco-dev task list
myco-dev task show full-intelligence
myco-dev task create test-task --from extract-only
myco-dev task list --source user
myco-dev task delete test-task
```

- [ ] **Step 4: Commit any fixes**

---

## Summary

| Task | What it delivers | Depends on |
|------|-----------------|------------|
| 1. Schema + Types | Rich task type system, Zod validation extracted | — |
| 2. DB Config Persistence | Phases/execution stored in config column | Task 1 |
| 3. Registry | Built-in + user task discovery, write/delete | Task 1 |
| 4. API Routes | Task CRUD over HTTP | Tasks 2, 3 |
| 5. CLI Commands | `myco task` subcommands | Task 4 |
| 6. Executor Update | Registry-backed execution, execution overrides | Tasks 2, 3 |
| 7. Quality Gate | Verification | All |

**After this plan:** Users can create custom intelligence tasks via YAML, configure phases/models/tools, and run them via CLI or API. The dashboard (Plan 3) and orchestrator intelligence (Plan 2) build on this foundation.

**Deferred to Plan 2:**
- Context query execution (queries run before phases to gather vault state)
- Provider environment injection (ANTHROPIC_BASE_URL, etc.)
- Orchestrator planning model (dynamic phase selection/reordering)
- Per-phase model routing with fallback detection
