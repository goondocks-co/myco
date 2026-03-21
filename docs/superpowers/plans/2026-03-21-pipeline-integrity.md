# Pipeline Integrity System ("Mycelium") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable pipeline system that tracks every piece of content through processing stages, retries transient failures, halts on config errors via circuit breakers, and surfaces pipeline health through API and dashboard.

**Architecture:** A dedicated `pipeline.db` (SQLite, WAL mode) alongside existing `index.db` and `vectors.db` tracks work items through 5 stages (capture, extraction, embedding, consolidation, digest). A `PipelineManager` class owns the database and exposes methods for registration, advancement, circuit breakers, and health queries. A 30-second pipeline tick timer in the daemon processes pending items stage-by-stage, replacing the current fire-and-forget processing model.

**Tech Stack:** better-sqlite3 (already a dependency), Vitest (tests), React + Tailwind (UI), Zod (config schema)

**Spec:** `docs/superpowers/specs/2026-03-21-pipeline-integrity-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/daemon/pipeline.ts` | PipelineManager class: DB schema, work items, stage transitions, circuit breakers, health, compaction, recovery |
| `src/daemon/pipeline-classify.ts` | Error classification function: transient vs config vs parse |
| `src/daemon/api/pipeline.ts` | API route handlers for pipeline health, items, circuits, retry |
| `tests/daemon/pipeline.test.ts` | PipelineManager unit tests (real SQLite in tmpdir) |
| `tests/daemon/pipeline-classify.test.ts` | Error classification tests |
| `tests/daemon/api/pipeline.test.ts` | API handler tests |
| `tests/daemon/pipeline-integration.test.ts` | End-to-end pipeline processing tests |
| `ui/src/pages/Mycelium.tsx` | Mycelium page (pipeline control room) |
| `ui/src/components/pipeline/` | Pipeline UI components (health bar, work item list, circuit panel) |

### Modified Files
| File | Changes |
|------|---------|
| `src/constants.ts` | Add pipeline constants (tick interval, retry limits, backoff, circuit thresholds) |
| `src/config/schema.ts` | Add `PipelineSchema` section to `MycoConfigSchema` |
| `src/daemon/main.ts` | Initialize PipelineManager, pipeline tick timer, replace inline processing with pipeline registration, register API routes |
| `src/daemon/processor.ts` | Return error classification from failed LLM calls (not just degraded flag) |
| `src/daemon/consolidation.ts` | Expose as standalone callable (remove digest pre-pass coupling) |
| `src/daemon/digest.ts` | Gate digest on upstream pipeline stage completion |
| `src/services/vault-ops.ts` | CLI operations enqueue via pipeline instead of processing inline |
| `src/daemon/api/operations.ts` | Add pipeline dependency to handler deps |
| `ui/src/layout/Layout.tsx` | Add Mycelium to `NAV_ITEMS` array for sidebar navigation |

---

## Phase 1: Foundation (no behavior change)

### Task 1: Pipeline Config Schema and Constants

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/constants.ts`
- Test: `tests/config/schema.test.ts` (existing, extend)

- [ ] **Step 1: Write failing test for pipeline config**

In `tests/config/schema.test.ts`, add a test that expects `pipeline` section to exist with defaults:

```typescript
it('provides pipeline defaults', () => {
  const config = MycoConfigSchema.parse({ version: 2 });
  expect(config.pipeline).toEqual({
    retention_days: 30,
    batch_size: 5,
    tick_interval_seconds: 30,
    retry: {
      transient_max: 3,
      backoff_base_seconds: 30,
    },
    circuit_breaker: {
      failure_threshold: 3,
      cooldown_seconds: 300,
      max_cooldown_seconds: 3600,
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/schema.test.ts -t "pipeline defaults"`
Expected: FAIL (pipeline property does not exist on config type)

- [ ] **Step 3: Add PipelineSchema to config/schema.ts**

Add the schema after `ConsolidationSchema`:

```typescript
const PipelineRetrySchema = z.object({
  transient_max: z.number().int().positive().default(3),
  backoff_base_seconds: z.number().int().positive().default(30),
});

const PipelineCircuitBreakerSchema = z.object({
  failure_threshold: z.number().int().positive().default(3),
  cooldown_seconds: z.number().int().positive().default(300),
  max_cooldown_seconds: z.number().int().positive().default(3600),
});

const PipelineSchema = z.object({
  retention_days: z.number().int().positive().default(30),
  batch_size: z.number().int().positive().default(5),
  tick_interval_seconds: z.number().int().positive().default(30),
  retry: PipelineRetrySchema.default(() => PipelineRetrySchema.parse({})),
  circuit_breaker: PipelineCircuitBreakerSchema.default(() => PipelineCircuitBreakerSchema.parse({})),
});
```

Add `pipeline` to `MycoConfigSchema`:

```typescript
pipeline: PipelineSchema.default(() => PipelineSchema.parse({})),
```

Export the type:

```typescript
export type PipelineConfig = z.infer<typeof PipelineSchema>;
```

- [ ] **Step 4: Add pipeline constants to constants.ts**

```typescript
// Pipeline processing
export const PIPELINE_TICK_INTERVAL_MS = 30_000;
export const PIPELINE_BATCH_SIZE = 5;
export const PIPELINE_RETENTION_DAYS = 30;

// Pipeline retry
export const PIPELINE_TRANSIENT_MAX_RETRIES = 3;
export const PIPELINE_PARSE_MAX_RETRIES = 1;
export const PIPELINE_BACKOFF_BASE_MS = 30_000;
export const PIPELINE_BACKOFF_MULTIPLIER = 4;

// Pipeline circuit breaker
export const PIPELINE_CIRCUIT_FAILURE_THRESHOLD = 3;
export const PIPELINE_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1000;
export const PIPELINE_CIRCUIT_MAX_COOLDOWN_MS = 60 * 60 * 1000;

// Pipeline stages (ordered)
export const PIPELINE_STAGES = ['capture', 'extraction', 'embedding', 'consolidation', 'digest'] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];

// Pipeline statuses
export const PIPELINE_STATUSES = ['pending', 'processing', 'succeeded', 'failed', 'blocked', 'skipped', 'poisoned'] as const;
export type PipelineStatus = typeof PIPELINE_STATUSES[number];

// Provider roles for circuit breakers
export const PIPELINE_PROVIDER_ROLES = ['llm', 'embedding', 'digest-llm'] as const;
export type PipelineProviderRole = typeof PIPELINE_PROVIDER_ROLES[number];

// Stage to provider role mapping
export const STAGE_PROVIDER_MAP: Record<PipelineStage, PipelineProviderRole | null> = {
  capture: null,
  extraction: 'llm',
  embedding: 'embedding',
  consolidation: 'digest-llm',
  digest: 'digest-llm',
};

// Item type to applicable stages
// Note: sessions skip consolidation — consolidation applies to the spores
// extracted FROM sessions, not the session work item itself. Those spores
// are registered as separate work items with their own pipeline entries.
// Lineage detection stays outside the pipeline (fire-and-forget, non-critical).
export const ITEM_STAGE_MAP: Record<string, PipelineStage[]> = {
  session: ['capture', 'extraction', 'embedding', 'digest'],
  spore: ['capture', 'embedding', 'consolidation', 'digest'],
  artifact: ['capture', 'embedding', 'digest'],
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config/schema.test.ts`
Expected: PASS

- [ ] **Step 6: Run full check**

Run: `make check`
Expected: All tests pass, types clean

- [ ] **Step 7: Commit**

Stage `src/config/schema.ts`, `src/constants.ts`, and `tests/config/schema.test.ts`, then commit with message: "feat(pipeline): add config schema and constants for pipeline integrity system"

---

### Task 2: Error Classification Function

**Files:**
- Create: `src/daemon/pipeline-classify.ts`
- Create: `tests/daemon/pipeline-classify.test.ts`

- [ ] **Step 1: Write failing tests for error classification**

Create `tests/daemon/pipeline-classify.test.ts` with tests for every classification case:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyError } from '@myco/daemon/pipeline-classify';

describe('classifyError', () => {
  describe('config errors', () => {
    it('classifies model not found as config', () => {
      const err = new Error('LM Studio summarize failed: 404 {"error":{"message":"model not found"}}');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies resource exhaustion as config', () => {
      const err = new Error('model load failed: 500 {"error":{"type":"model_load_failed","message":"insufficient system resources"}}');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies ECONNREFUSED as config', () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' });
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies 401 as config', () => {
      const err = new Error('Anthropic summarize failed: 401 unauthorized');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies 403 as config', () => {
      const err = new Error('API call failed: 403 forbidden');
      expect(classifyError(err).type).toBe('config');
    });

    it('classifies ENOTFOUND for configured host as config', () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND my-custom-host'), { code: 'ENOTFOUND' });
      expect(classifyError(err, { configuredHost: 'my-custom-host' }).type).toBe('config');
    });
  });

  describe('transient errors', () => {
    it('classifies timeout as transient', () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies ETIMEDOUT as transient', () => {
      const err = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies 429 as transient', () => {
      const err = new Error('API call failed: 429 rate limited');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies 503 as transient', () => {
      const err = new Error('API call failed: 503 service unavailable');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies ECONNRESET as transient', () => {
      const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies generic 500 as transient', () => {
      const err = new Error('API call failed: 500 internal server error');
      expect(classifyError(err).type).toBe('transient');
    });

    it('classifies ENOTFOUND for well-known host as transient', () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' });
      expect(classifyError(err).type).toBe('transient');
    });
  });

  describe('parse errors', () => {
    it('classifies JSON parse failure as parse', () => {
      const err = new SyntaxError('Unexpected token < in JSON at position 0');
      expect(classifyError(err).type).toBe('parse');
    });

    it('classifies empty response as parse', () => {
      const err = new Error('LLM returned empty content');
      err.name = 'ParseError';
      expect(classifyError(err).type).toBe('parse');
    });
  });

  describe('defaults', () => {
    it('defaults unknown errors to transient', () => {
      const err = new Error('something unexpected happened');
      expect(classifyError(err).type).toBe('transient');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/pipeline-classify.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement classifyError**

Create `src/daemon/pipeline-classify.ts`:

```typescript
export type ErrorType = 'transient' | 'config' | 'parse';

export interface ClassifyResult {
  type: ErrorType;
  suggestedAction?: string;
}

interface ClassifyContext {
  configuredHost?: string;
  providerName?: string;
  modelName?: string;
  baseUrl?: string;
}

const WELL_KNOWN_HOSTS = ['api.anthropic.com', 'api.openai.com'];

/**
 * Classify an LLM/embedding error and generate a user-facing suggested action.
 * Returns both the error type (for retry/circuit logic) and a human-readable
 * action message (for dashboard display).
 */
export function classifyError(error: Error, context?: ClassifyContext): ClassifyResult {
  const msg = error.message.toLowerCase();
  const code = (error as NodeJS.ErrnoException).code;

  const provider = context?.providerName ?? 'LLM provider';
  const model = context?.modelName ?? 'the configured model';
  const url = context?.baseUrl ?? 'the configured URL';

  // Parse errors
  if (error instanceof SyntaxError) return { type: 'parse', suggestedAction: `LLM returned invalid output. Try a different model or manually reprocess.` };
  if (error.name === 'ParseError') return { type: 'parse', suggestedAction: `LLM returned invalid output. Try a different model or manually reprocess.` };
  if (msg.includes('empty content') || msg.includes('schema validation')) return { type: 'parse', suggestedAction: `LLM returned invalid output. Try a different model or manually reprocess.` };

  // Config errors
  if (code === 'ECONNREFUSED') return { type: 'config', suggestedAction: `Cannot connect to ${provider} at ${url}. Check that it's running.` };
  if (msg.includes('401') || msg.includes('403')) return { type: 'config', suggestedAction: `Invalid API key for ${provider}. Update in Configuration.` };
  if (msg.includes('model') && (msg.includes('not found') || msg.includes('not loaded'))) return { type: 'config', suggestedAction: `Load ${model} in ${provider}, or change the model in Configuration.` };
  if (msg.includes('insufficient') && msg.includes('resource')) return { type: 'config', suggestedAction: `Not enough resources to load ${model}. Free memory or choose a smaller model.` };
  if (msg.includes('model_load_failed')) return { type: 'config', suggestedAction: `Failed to load ${model}. Check ${provider} logs for details.` };
  if (msg.includes('unsupported') || msg.includes('not compatible')) return { type: 'config', suggestedAction: `${model} is not compatible. Choose a different model in Configuration.` };

  // ENOTFOUND: config if configured host, transient if well-known
  if (code === 'ENOTFOUND') {
    if (context?.configuredHost && msg.includes(context.configuredHost.toLowerCase())) return { type: 'config', suggestedAction: `Cannot resolve ${context.configuredHost}. Check the base_url in Configuration.` };
    if (WELL_KNOWN_HOSTS.some((h) => msg.includes(h))) return { type: 'transient' };
    return { type: 'config', suggestedAction: `Cannot resolve hostname. Check the base_url in Configuration.` };
  }

  // Transient errors
  if (error.name === 'AbortError' || msg.includes('aborted')) return { type: 'transient' };
  if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return { type: 'transient' };
  if (msg.includes('500')) return { type: 'transient' };
  if (msg.includes('429') || msg.includes('503')) return { type: 'transient' };
  if (msg.includes('socket hang up')) return { type: 'transient' };

  return { type: 'transient' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon/pipeline-classify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Stage `src/daemon/pipeline-classify.ts` and `tests/daemon/pipeline-classify.test.ts`, then commit with message: "feat(pipeline): add error classification function for retry and circuit-breaker decisions"

---

### Task 3: PipelineManager Database and Schema

**Files:**
- Create: `src/daemon/pipeline.ts`
- Create: `tests/daemon/pipeline.test.ts`

- [ ] **Step 1: Write failing tests for schema initialization**

Create `tests/daemon/pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PipelineManager } from '@myco/daemon/pipeline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('PipelineManager', () => {
  let tmpDir: string;
  let manager: PipelineManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pipeline-'));
    manager = new PipelineManager(tmpDir);
  });

  afterEach(() => {
    manager.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('creates pipeline.db with correct tables', () => {
      const dbPath = path.join(tmpDir, 'pipeline.db');
      expect(fs.existsSync(dbPath)).toBe(true);
      const health = manager.health();
      expect(health).toBeDefined();
    });

    it('is idempotent', () => {
      manager.close();
      const manager2 = new PipelineManager(tmpDir);
      const health = manager2.health();
      expect(health).toBeDefined();
      manager2.close();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/pipeline.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement PipelineManager with schema**

Create `src/daemon/pipeline.ts` with:
- Database initialization (better-sqlite3, WAL mode, foreign keys)
- Schema SQL (work_items, stage_transitions, stage_history, circuit_breakers tables)
- pipeline_status view using `ROW_NUMBER()` window function
- `health()` method querying pipeline_status aggregate counts
- `close()` method

Reference the spec's SQL schema section for exact table definitions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

Stage `src/daemon/pipeline.ts` and `tests/daemon/pipeline.test.ts`, then commit with message: "feat(pipeline): add PipelineManager with SQLite schema initialization"

---

### Task 4: PipelineManager Work Items and Stage Transitions

**Files:**
- Modify: `src/daemon/pipeline.ts`
- Modify: `tests/daemon/pipeline.test.ts`

- [ ] **Step 1: Write failing tests for register, advance, getItemStatus, nextBatch**

Add test suites covering:
- `register()`: creates work item with correct initial stages per item type (session=4 applicable stages, skips consolidation; spore skips extraction; artifact skips extraction+consolidation). Idempotent on re-register.
- `advance()`: records transitions, increments attempts on retry, blocks downstream on failure.
- `getItemStatus()`: returns current status per stage for a work item.
- `nextBatch()`: returns pending items ordered by creation time, respects batch limit, excludes items in backoff window, only returns items whose upstream stage succeeded.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement register, advance, getItemStatus, nextBatch**

Key implementation details:
- `register()`: `INSERT OR IGNORE` for work_items. Insert initial stage_transitions (pending or skipped per `ITEM_STAGE_MAP`).
- `advance()`: Append new transition row. Calculate attempt from count of prior transitions for same item+stage. When a stage fails with config error, mark downstream stages as blocked. When `attempt` exceeds the retry limit for the error type (`PIPELINE_TRANSIENT_MAX_RETRIES` for transient, `PIPELINE_PARSE_MAX_RETRIES` for parse), set status to `poisoned` instead of `failed`.
- `getItemStatus()`: Query `pipeline_status` view filtered by work_item_id and item_type.
- `nextBatch()`: Query for items where the requested stage is pending, the previous stage (per `PIPELINE_STAGES` order) is succeeded or skipped, and backoff has elapsed. Backoff calculated as `PIPELINE_BACKOFF_BASE_MS * PIPELINE_BACKOFF_MULTIPLIER^(attempt-1)`. Order by `work_items.created_at ASC`, limit by batch size.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

Stage modified files, commit with message: "feat(pipeline): add work item registration, stage transitions, and batch queries"

---

### Task 5: PipelineManager Circuit Breakers

**Files:**
- Modify: `src/daemon/pipeline.ts`
- Modify: `tests/daemon/pipeline.test.ts`

- [ ] **Step 1: Write failing tests for circuit breaker state machine**

Test: starts closed, opens after threshold consecutive failures, does not open before threshold, resets on manual reset, blocks pending items at affected stages when circuit opens, unblocks when circuit resets.

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement circuitState, tripCircuit, resetCircuit, probeCircuit, blockItemsForCircuit, unblockItemsForCircuit**

- `circuitState(role)`: Query or create default (closed) circuit_breakers row.
- `tripCircuit(role, error)`: Increment failure_count, set last_error. If >= threshold: set state=open, calculate opens_at.
- `resetCircuit(role)`: Set state=closed, failure_count=0.
- `probeCircuit(role)`: Check if circuit is open and cooldown has expired. If so, set state=half-open and return true (allow one probe request). Called by the tick handler before processing a stage with an open circuit.
- `blockItemsForCircuit(role)`: Find stages using this role (via `STAGE_PROVIDER_MAP`), insert new `blocked` transitions for all `pending` items at those stages.
- `unblockItemsForCircuit(role)`: Insert new `pending` transitions for all `blocked` items at stages using this role.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

Commit with message: "feat(pipeline): add circuit breaker state machine with blocking and unblocking"

---

### Task 6: PipelineManager Health, Compaction, Recovery

**Files:**
- Modify: `src/daemon/pipeline.ts`
- Modify: `tests/daemon/pipeline.test.ts`

- [ ] **Step 1: Write failing tests for compact, recoverStuck**

Test: compaction moves old transitions to stage_history, preserves recent ones, stores error_types JSON. Recovery moves `processing` items back to `pending` on startup.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/daemon/pipeline.test.ts -t "compaction|recoverStuck"`
Expected: FAIL (methods not found)

- [ ] **Step 3: Implement compact and recoverStuck**

- `compact(retentionDays)`: Find transitions older than cutoff. For each (work_item, stage) group: INSERT OR REPLACE into stage_history with total_attempts, final_status, error_types JSON aggregation. Delete original rows.
- `recoverStuck()`: For all items in `processing` status, insert new `pending` transition.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/daemon/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: Run full check**

Run: `make check`

- [ ] **Step 6: Commit**

Commit with message: "feat(pipeline): add compaction, stuck recovery, and health aggregation"

---

## Phase 2: API and Daemon Wiring

### Task 7: Pipeline API Routes

**Files:**
- Create: `src/daemon/api/pipeline.ts`
- Create: `tests/daemon/api/pipeline.test.ts`
- Modify: `src/daemon/main.ts` (register routes)

- [ ] **Step 1: Write failing tests for API handlers**

Test: GET /api/pipeline/health returns aggregate health. GET /api/pipeline/items returns paginated items. GET /api/pipeline/items/:id returns item with history. GET /api/pipeline/circuits returns circuit states. POST /api/pipeline/retry/:id moves poisoned to pending. POST /api/pipeline/retry-all moves all poisoned to pending. POST /api/pipeline/circuit/:provider/reset resets circuit.

- [ ] **Step 2: Implement API handlers in src/daemon/api/pipeline.ts**

Follow pattern from `operations.ts`: thin handlers, delegate to PipelineManager, return RouteResponse.

- [ ] **Step 3: Register routes in main.ts**

Add route registrations after existing API routes.

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

Commit with message: "feat(pipeline): add REST API routes for pipeline health, items, and circuits"

---

### Task 8: Pipeline Tick Timer and Daemon Startup

**Files:**
- Modify: `src/daemon/main.ts`
- Modify: `src/daemon/pipeline.ts`

- [ ] **Step 1: Add tick method to PipelineManager**

`tick()` is the processing loop core. It uses a stage handler interface:

```typescript
interface StageHandlers {
  extraction: (itemId: string, itemType: string) => Promise<void>;
  embedding: (itemId: string, itemType: string) => Promise<void>;
  consolidation: (itemId: string, itemType: string) => Promise<void>;
  digest: (itemId: string, itemType: string) => Promise<void>;
}
```

The tick method: checks circuits, processes nextBatch per stage (extraction, embedding, consolidation), does NOT process digest (gated by metabolism). Serialized via `tickInProgress` guard.

- [ ] **Step 2: Initialize PipelineManager in main.ts**

After index initialization. Call `recoverStuck()` on startup. Add `close()` to shutdown.

- [ ] **Step 3: Set up pipeline tick timer**

Use `setInterval` with `tickInProgress` guard. Separate from metabolism timer.

- [ ] **Step 4: Run full check**

Run: `make check`
Expected: All pass (handlers are stubs that advance to succeeded)

- [ ] **Step 5: Commit**

Commit with message: "feat(pipeline): initialize PipelineManager in daemon with tick timer"

---

## Phase 3: Stage Integration (behavior changes)

> **Note for implementers:** Phase 3 tasks modify core daemon behavior. Before starting each task, read the relevant source files completely to understand the current processing flow:
> - `src/daemon/main.ts` — stop event handler (line ~577), batch callback (line ~419), consolidation pre-pass (line ~373), indexAndEmbed helper (line ~59)
> - `src/daemon/processor.ts` — BufferProcessor.process(), summarizeSession(), classifyArtifacts()
> - `src/daemon/consolidation.ts` — ConsolidationEngine.runPass(), how it's registered as a pre-pass hook
> - `src/daemon/digest.ts` — Metabolism class, runCycle(), substrate discovery, cycleInProgress guard

### Task 9: Session Stop to Pipeline Registration

**Files:**
- Modify: `src/daemon/main.ts`
- Create: `tests/daemon/pipeline-integration.test.ts`

- [ ] **Step 1: Write integration test**

Test that a stop event registers a work item with capture:succeeded and extraction:pending.

- [ ] **Step 2: Modify stop event handler**

Replace inline `processStopEvent()` chain with: write session note (capture), register in pipeline, advance capture:succeeded. Extraction happens on next pipeline tick.

- [ ] **Step 3: Run full check and fix any broken tests**

Existing tests may need updating for the new processing model.

- [ ] **Step 4: Commit**

Commit with message: "feat(pipeline): session stop registers work item instead of processing inline"

---

### Task 10: Extraction Stage Handler

**Files:**
- Modify: `src/daemon/main.ts`
- Modify: `src/daemon/processor.ts`

- [ ] **Step 1: Modify processor to throw typed errors**

Replace degraded flag pattern with thrown errors that include enough context for classification.

- [ ] **Step 2: Implement extraction stage handler**

Gets buffer events and transcript, calls processor.process() and summarizeSession(). All-or-nothing: any failure marks extraction:failed with classified error. Success writes observations and session note, advances extraction:succeeded.

- [ ] **Step 3: Wire handler into pipeline tick**

- [ ] **Step 4: Test extraction success and failure paths**

- [ ] **Step 5: Commit**

Commit with message: "feat(pipeline): implement extraction stage with error classification"

---

### Task 11: Embedding Stage Handler

**Files:**
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Implement embedding handler**

Reads work item content, calls embeddingProvider.embed(), stores in vectorIndex. For sessions: embed narrative AND each extracted observation. On failure: classify error, advance embedding:failed.

- [ ] **Step 2: Wire handler and test**

- [ ] **Step 3: Commit**

Commit with message: "feat(pipeline): implement embedding stage handler"

---

### Task 12: Consolidation Stage Handler

**Files:**
- Modify: `src/daemon/main.ts`
- Modify: `src/daemon/consolidation.ts`

- [ ] **Step 1: Decouple consolidation from digest pre-pass**

Remove `digestEngine.registerPrePass('consolidation', ...)`. Expose `evaluateSpore(sporeId)` method.

- [ ] **Step 2: Implement consolidation stage handler**

Calls consolidation for each pending spore. Sessions and artifacts skip this stage.

- [ ] **Step 3: Wire handler and test**

- [ ] **Step 4: Commit**

Commit with message: "feat(pipeline): implement consolidation as independent pipeline stage"

---

### Task 13: Digest Stage Gating

**Files:**
- Modify: `src/daemon/digest.ts`
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Gate digest on upstream completion**

Modify metabolism callback: check pipeline for any pending/failed/blocked items at upstream stages. If found, skip digest. If clear, run digest. After cycle, advance substrate items to digest:succeeded.

- [ ] **Step 2: Modify substrate discovery to use pipeline**

Discover substrate from pipeline (items with upstream:succeeded, digest:pending) instead of timestamp-based index query.

- [ ] **Step 3: Test digest blocked and unblocked scenarios**

- [ ] **Step 4: Commit**

Commit with message: "feat(pipeline): gate digest on upstream stage completion"

---

## Phase 4: CLI, Rebuild, and Circuit Breaker Integration

### Task 14: CLI Command Integration

**Files:**
- Modify: `src/services/vault-ops.ts`

- [ ] **Step 1: Modify runReprocess to enqueue via pipeline**

Register sessions at extraction:pending instead of processing inline.

- [ ] **Step 2: Modify runDigest and runCuration similarly**

runDigest with --full resets all to digest:pending. runCuration registers spores at consolidation:pending.

- [ ] **Step 3: Test CLI operations create pipeline work items**

- [ ] **Step 4: Commit**

Commit with message: "feat(pipeline): CLI operations enqueue via pipeline instead of inline processing"

---

### Task 15: Rebuild from Vault

**Files:**
- Modify: `src/daemon/pipeline.ts`

- [ ] **Step 1: Write test for rebuild algorithm**

Test: walks vault, registers items, infers stage status from vectors.db and digest trace.

- [ ] **Step 2: Implement rebuild method**

Walk vault directories. For each note: register, infer stages (file exists=capture:succeeded, has vector=embedding:succeeded, in digest trace=digest:succeeded, consolidation=always pending). Mark unknowns as pending.

- [ ] **Step 3: Add first-run migration to daemon startup**

If pipeline.db missing on startup, run rebuild after schema creation.

- [ ] **Step 4: Test and commit**

Commit with message: "feat(pipeline): add rebuild-from-vault algorithm and first-run migration"

---

### Task 16: Circuit Breaker Integration in Pipeline Tick

**Files:**
- Modify: `src/daemon/pipeline.ts`
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Check circuits before processing each stage**

Before processing a stage: lookup provider role, check circuit state. If open: skip, ensure items blocked. If half-open and cooldown expired: probe one item. On probe success: reset, unblock. On probe fail: re-open with doubled cooldown.

- [ ] **Step 2: Trip circuit on config errors**

When stage handler fails with error_type config, call tripCircuit. If threshold reached, block items.

- [ ] **Step 3: Test circuit integration end-to-end**

- [ ] **Step 4: Commit**

Commit with message: "feat(pipeline): integrate circuit breakers into pipeline tick processing"

---

## Phase 5: Dashboard UI

### Task 17: Dashboard Health Indicator

**Files:**
- Modify: `ui/src/pages/Dashboard.tsx` or topology component
- Create: `ui/src/hooks/use-pipeline.ts`

- [ ] **Step 1: Create usePipeline hook**

Fetch from GET /api/pipeline/health on interval. Return health data.

- [ ] **Step 2: Add pipeline health to dashboard topology**

Color-code pipeline stages: green (all succeeded), yellow (pending/retrying), red (failed/blocked/poisoned). Show circuit breaker indicators. Make stages clickable to navigate to Mycelium.

- [ ] **Step 3: Commit**

Commit with message: "feat(pipeline): add pipeline health indicator to dashboard topology"

---

### Task 18: Mycelium Page Skeleton and Navigation

**Files:**
- Create: `ui/src/pages/Mycelium.tsx`
- Create: `ui/src/components/pipeline/PipelineVisualization.tsx`
- Modify: `ui/src/layout/Layout.tsx` (add to `NAV_ITEMS` array)

- [ ] **Step 1: Create Mycelium page layout**

Page skeleton with: pipeline visualization placeholder, circuit breaker panel placeholder, work item list placeholder. Wire into router.

- [ ] **Step 2: Implement PipelineVisualization component**

Horizontal stage boxes showing counts per status from `usePipeline` hook. Color coding: green (all succeeded), yellow (pending/retrying), red (failed/blocked/poisoned). Circuit breaker warning banners. Backlog indicator showing count of pending items and estimated drain time.

- [ ] **Step 3: Add Mycelium to sidebar navigation**

Add entry to `NAV_ITEMS` in `ui/src/layout/Layout.tsx`. Replace "Operations" with "Mycelium". Preserve existing operation utility buttons (rebuild, digest) as secondary actions on the Mycelium page.

- [ ] **Step 4: Build and verify**

Run: `make build`
Verify Mycelium page accessible and pipeline visualization renders.

- [ ] **Step 5: Commit**

Commit with message: "feat(pipeline): add Mycelium page skeleton with pipeline visualization"

---

### Task 19: Mycelium Page Components

**Files:**
- Create: `ui/src/components/pipeline/WorkItemList.tsx`
- Create: `ui/src/components/pipeline/WorkItemDetail.tsx`
- Create: `ui/src/components/pipeline/CircuitBreakerPanel.tsx`
- Modify: `ui/src/pages/Mycelium.tsx`

- [ ] **Step 1: Implement WorkItemList component**

Filterable by stage, status, type. Sortable by date. Paginated via /api/pipeline/items. Click to expand WorkItemDetail.

- [ ] **Step 2: Implement WorkItemDetail component**

Full transition timeline with timestamps. Error details per attempt. Retry button (calls POST /api/pipeline/retry/:id for poisoned items). Skip button (force advance past failed stage).

- [ ] **Step 3: Implement CircuitBreakerPanel component**

Per-provider-role cards showing state, failure count, last error, cooldown remaining. Reset button calls POST /api/pipeline/circuit/:provider/reset. Suggested action messages displayed per error type.

- [ ] **Step 4: Wire components into Mycelium page**

- [ ] **Step 5: Build and verify**

Run: `make build`
Verify all components render and interact correctly.

- [ ] **Step 6: Commit**

Commit with message: "feat(pipeline): add work item list, detail, and circuit breaker components to Mycelium"

---

## Phase 6: Cleanup and Verification

### Task 20: Remove Legacy Processing Code

**Files:**
- Modify: `src/daemon/main.ts`
- Modify: `src/daemon/processor.ts`
- Modify: `src/constants.ts`

- [ ] **Step 1: Remove SUMMARIZATION_FAILED_MARKER**

Remove the constant and all references. Pipeline tracks failures explicitly.

- [ ] **Step 2: Remove fire-and-forget embedding calls**

Remove `.then()/.catch()` embedding patterns from writeObservations and other sites.

- [ ] **Step 3: Verify digest pre-pass cleanup**

Confirm consolidation pre-pass registration fully removed.

- [ ] **Step 4: Run full check and build**

Run: `make check && make build`

- [ ] **Step 5: Commit**

Commit with message: "refactor(pipeline): remove legacy fire-and-forget processing code"

---

### Task 21: End-to-End Verification

- [ ] **Step 1: Build and restart daemon**

Run: `make build` then restart daemon via CLI.

- [ ] **Step 2: Verify first-run migration**

Check daemon logs for pipeline rebuild. Verify pipeline.db exists in vault.

- [ ] **Step 3: Trigger session stop and verify pipeline processing**

Create test session, stop it, verify work item flows through all stages.

- [ ] **Step 4: Verify circuit breaker by stopping LM Studio**

Stop LM Studio, trigger processing, verify circuit opens, items blocked, dashboard shows red. Restart, verify circuit closes, backlog drains.

- [ ] **Step 5: Verify Mycelium page**

Open dashboard, check pipeline visualization, circuit panel, work item list, retry button.

- [ ] **Step 6: Final commit**

Commit with message: "feat(pipeline): pipeline integrity system complete"
