# Orchestrator Intelligence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an intelligent orchestration layer that plans phase execution based on vault state, executes context queries before phases, routes models per-phase/per-provider, and adapts the pipeline dynamically.

**Architecture:** Before running phases, the executor calls a planning model (orchestrator) that reviews vault state and produces a phase execution plan. Each phase can use a different model via provider configuration. Context queries gather data before the orchestrator decides. The orchestrator pattern is opt-in — tasks without an orchestrator config use the existing static phase loop.

**Tech Stack:** TypeScript, Claude Agent SDK, YAML task definitions, PGlite

**Depends on:** Plan 1 (Agent Task System) — requires registry, extended task schema, execution config

**Reference:** OAK executor at `~/Repos/open-agent-kit/src/open_agent_kit/features/agent_runtime/executor.py` — provider env var injection pattern. Phased executor spec at `docs/superpowers/specs/2026-03-24-phased-executor.md` — orchestrator section.

---

## Design Decisions

### Orchestrator is a planning call, not a persistent agent

The orchestrator is a single `query()` call that receives vault state + task definition and returns a structured phase plan. It does NOT run tools — it only plans. This keeps it cheap (few turns, small context) and separable from execution.

### Orchestrator output is a JSON phase plan

The orchestrator returns structured JSON, not free text. The executor parses this to determine:
- Which phases to run (skip phases with nothing to do)
- Phase order (may reorder if dependencies allow)
- Turn budget adjustments (more turns for extraction if many batches)
- Context notes for each phase (what to focus on)

```typescript
interface OrchestratorPlan {
  phases: OrchestratorPhaseDirective[];
  reasoning: string;
}

interface OrchestratorPhaseDirective {
  name: string;
  skip: boolean;
  skipReason?: string;
  maxTurns?: number;        // override from task definition
  contextNotes?: string;    // additional guidance for this phase
}
```

### Provider env vars follow OAK's pattern

Provider configuration sets environment variables before each `query()` call:
- **Cloud** (default): no env changes needed
- **Ollama**: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY=""`
- **LM Studio**: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=lmstudio`, `ANTHROPIC_API_KEY=""`

Env vars are set before and restored after each phase's `query()` call.

### Context queries run before the orchestrator

Context queries are defined per-task (from Plan 1's `contextQueries` field). They run before the orchestrator planning call using the vault's existing tool infrastructure. Results are injected into the orchestrator's prompt as structured data.

### Fallback: code-only orchestration when no planning model available

If the orchestrator model is unavailable (local-only setup, no API key), fall back to code-only orchestration:
- Run all phases sequentially (current behavior)
- Skip phases with `required: false` if the prior phase reported nothing to do
- No turn budget adjustments

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/agent/orchestrator.ts` | Planning call, phase plan parsing, directive application |
| `src/agent/context-queries.ts` | Execute context queries using vault tool handlers |
| `src/agent/provider.ts` | Provider env var management (set/restore) |
| `src/agent/prompts/orchestrator.md` | Orchestrator system prompt template |
| `tests/agent/orchestrator.test.ts` | Orchestrator planning tests |
| `tests/agent/context-queries.test.ts` | Context query execution tests |
| `tests/agent/provider.test.ts` | Provider env var tests |

### Modified Files

| File | Changes |
|------|---------|
| `src/agent/executor.ts` | Integrate orchestrator planning, provider routing, context queries |
| `src/agent/types.ts` | Add OrchestratorPlan, OrchestratorPhaseDirective types |
| `src/agent/definitions/tasks/full-intelligence.yaml` | Add orchestrator config and context queries |

---

## Task 1: Orchestrator Types and Prompt

**Files:**
- Modify: `src/agent/types.ts`
- Create: `src/agent/prompts/orchestrator.md`

- [ ] **Step 1: Add orchestrator types to `types.ts`**

```typescript
/** Directive for a single phase from the orchestrator's plan. */
export interface OrchestratorPhaseDirective {
  name: string;
  skip: boolean;
  skipReason?: string;
  maxTurns?: number;
  contextNotes?: string;
}

/** The orchestrator's output — a plan for phase execution. */
export interface OrchestratorPlan {
  phases: OrchestratorPhaseDirective[];
  reasoning: string;
}

/** Orchestrator configuration on a task definition. */
export interface OrchestratorConfig {
  enabled: boolean;
  model?: string;           // orchestrator model (defaults to task model)
  maxTurns?: number;        // turn budget for planning call (default: 3)
}
```

Add `orchestrator` to `AgentTask`:

```typescript
export interface AgentTask {
  // ... existing fields ...
  orchestrator?: OrchestratorConfig;
}
```

And to `EffectiveConfig`:

```typescript
export interface EffectiveConfig {
  // ... existing fields ...
  orchestrator?: OrchestratorConfig;
}
```

- [ ] **Step 2: Create orchestrator prompt template**

Create `src/agent/prompts/orchestrator.md`:

```markdown
You are a vault intelligence orchestrator. Your job is to plan which phases
of the intelligence pipeline should run, based on the current vault state.

## Vault State
{{vault_state}}

## Available Phases
{{phase_definitions}}

## Context Query Results
{{context_results}}

## Instructions

Analyze the vault state and decide:
1. Which phases should run (skip phases with nothing to do)
2. Whether any phases need adjusted turn budgets
3. What each phase should focus on

Return a JSON object with this exact structure:
```json
{
  "phases": [
    {
      "name": "phase-name",
      "skip": false,
      "maxTurns": 15,
      "contextNotes": "Focus on the 5 unprocessed batches from session X"
    }
  ],
  "reasoning": "Brief explanation of planning decisions"
}
```

Rules:
- Include ALL phases from Available Phases, marking skipped ones with `skip: true`
- Required phases (`required: true`) should almost never be skipped
- If there are no unprocessed batches, skip extract but still run consolidate/graph/digest
- Adjust maxTurns based on workload (more batches = more extract turns)
```

- [ ] **Step 3: Commit**

```bash
git add src/agent/types.ts src/agent/prompts/orchestrator.md
git commit -m "feat(agent): add orchestrator types and prompt template"
```

---

## Task 2: Context Query Execution

**Files:**
- Create: `src/agent/context-queries.ts`
- Create: `tests/agent/context-queries.test.ts`

- [ ] **Step 1: Create context query executor**

Context queries use the same vault tool handlers from `tools.ts` but run them directly (no Agent SDK). This is a lightweight pre-flight data gather.

```typescript
import type { ContextQuery } from './types.js';
import { getUnprocessedBatches } from '@myco/db/queries/batches.js';
import { listSpores } from '@myco/db/queries/spores.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { getStatesForAgent } from '@myco/db/queries/agent-state.js';

/** Result of a single context query execution. */
export interface ContextQueryResult {
  tool: string;
  purpose: string;
  data: unknown;
  error?: string;
}

/** Default limit for context query results. */
const DEFAULT_CONTEXT_QUERY_LIMIT = 10;

/**
 * Execute a set of context queries and return structured results.
 * Queries that fail are included with an error field — never throws.
 */
export async function executeContextQueries(
  agentId: string,
  queries: ContextQuery[],
): Promise<ContextQueryResult[]> {
  const results: ContextQueryResult[] = [];

  for (const query of queries) {
    try {
      const data = await executeQuery(agentId, query);
      results.push({ tool: query.tool, purpose: query.purpose, data });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      results.push({ tool: query.tool, purpose: query.purpose, data: null, error });
      if (query.required) {
        throw new Error(`Required context query failed: ${query.tool} — ${error}`);
      }
    }
  }

  return results;
}

/** Route a single query to the appropriate DB function. */
async function executeQuery(agentId: string, query: ContextQuery): Promise<unknown> {
  const limit = query.limit ?? DEFAULT_CONTEXT_QUERY_LIMIT;

  switch (query.tool) {
    case 'vault_unprocessed':
      return getUnprocessedBatches({ limit });
    case 'vault_spores':
      return listSpores({ agent_id: agentId, limit });
    case 'vault_sessions':
      return listSessions({ limit });
    case 'vault_state':
      return getStatesForAgent(agentId);
    default:
      throw new Error(`Unknown context query tool: ${query.tool}`);
  }
}
```

- [ ] **Step 2: Write context query tests**

```typescript
describe('executeContextQueries', () => {
  it('executes vault_unprocessed query and returns results');
  it('executes vault_spores query with agent_id filter');
  it('executes vault_state query');
  it('returns error field for failed non-required query');
  it('throws on failed required query');
  it('rejects unknown tool name');
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/agent/context-queries.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/agent/context-queries.ts tests/agent/context-queries.test.ts
git commit -m "feat(agent): add context query executor for pre-phase data gathering"
```

---

## Task 3: Provider Environment Management

**Files:**
- Create: `src/agent/provider.ts`
- Create: `tests/agent/provider.test.ts`

- [ ] **Step 1: Create provider env manager**

Following OAK's pattern from `executor.py:_apply_provider_env`:

```typescript
import type { ProviderConfig } from './types.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** Environment variable for Anthropic API base URL. */
const ENV_ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL';

/** Environment variable for Anthropic auth token. */
const ENV_ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';

/** Environment variable for Anthropic API key. */
const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';

/** Default Ollama base URL. */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Default LM Studio base URL. */
const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234';

/** Auth token value for Ollama provider. */
const OLLAMA_AUTH_TOKEN = 'ollama';

/** Auth token value for LM Studio provider. */
const LMSTUDIO_AUTH_TOKEN = 'lmstudio';

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

/** Saved environment state for restoration after a query. */
export interface SavedEnv {
  vars: Record<string, string | undefined>;
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * Apply provider environment variables for a query() call.
 * Returns saved state for restoration via restoreProviderEnv().
 */
export function applyProviderEnv(provider: ProviderConfig): SavedEnv {
  const saved: Record<string, string | undefined> = {};

  const envVars = getProviderEnvVars(provider);
  for (const [key, value] of Object.entries(envVars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }

  return { vars: saved };
}

/**
 * Restore environment variables after a query() call.
 */
export function restoreProviderEnv(saved: SavedEnv): void {
  for (const [key, value] of Object.entries(saved.vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Get the environment variables for a provider configuration.
 */
export function getProviderEnvVars(provider: ProviderConfig): Record<string, string> {
  switch (provider.type) {
    case 'cloud':
      return {};
    case 'ollama':
      return {
        [ENV_ANTHROPIC_BASE_URL]: provider.baseUrl ?? DEFAULT_OLLAMA_URL,
        [ENV_ANTHROPIC_AUTH_TOKEN]: OLLAMA_AUTH_TOKEN,
        [ENV_ANTHROPIC_API_KEY]: '',
      };
    case 'lmstudio':
      return {
        [ENV_ANTHROPIC_BASE_URL]: provider.baseUrl ?? DEFAULT_LMSTUDIO_URL,
        [ENV_ANTHROPIC_AUTH_TOKEN]: provider.apiKey ?? LMSTUDIO_AUTH_TOKEN,
        [ENV_ANTHROPIC_API_KEY]: '',
      };
    default:
      return {};
  }
}
```

- [ ] **Step 2: Write provider tests**

```typescript
describe('applyProviderEnv / restoreProviderEnv', () => {
  it('sets Ollama env vars and restores originals');
  it('sets LM Studio env vars and restores originals');
  it('cloud provider sets no env vars');
  it('restores undefined vars by deleting them');
});

describe('getProviderEnvVars', () => {
  it('returns correct vars for ollama with default URL');
  it('returns correct vars for ollama with custom URL');
  it('returns correct vars for lmstudio');
  it('returns empty for cloud');
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/agent/provider.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/agent/provider.ts tests/agent/provider.test.ts
git commit -m "feat(agent): add provider env management for Ollama/LM Studio/cloud"
```

---

## Task 4: Orchestrator Planning Call

**Files:**
- Create: `src/agent/orchestrator.ts`
- Create: `tests/agent/orchestrator.test.ts`

- [ ] **Step 1: Create orchestrator module**

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  OrchestratorPlan,
  OrchestratorPhaseDirective,
  OrchestratorConfig,
  PhaseDefinition,
  ContextQueryResult,
} from './types.js';

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

/** Default max turns for the orchestrator planning call. */
const DEFAULT_ORCHESTRATOR_MAX_TURNS = 3;

/** Orchestrator prompt template filename. */
const ORCHESTRATOR_PROMPT_FILE = 'orchestrator.md';

// -------------------------------------------------------------------------
// Prompt Composition
// -------------------------------------------------------------------------

/**
 * Load the orchestrator prompt template and substitute variables.
 */
export function composeOrchestratorPrompt(
  vaultState: string,
  phases: PhaseDefinition[],
  contextResults: ContextQueryResult[],
): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const templatePath = path.join(dir, 'prompts', ORCHESTRATOR_PROMPT_FILE);
  let template = fs.readFileSync(templatePath, 'utf-8');

  const phaseList = phases.map(p =>
    `- **${p.name}** (maxTurns: ${p.maxTurns}, required: ${p.required}): ${p.prompt.slice(0, 100)}...`
  ).join('\n');

  const contextStr = contextResults.length > 0
    ? contextResults.map(r =>
        `### ${r.tool} — ${r.purpose}\n${r.error ? `Error: ${r.error}` : JSON.stringify(r.data, null, 2)}`
      ).join('\n\n')
    : 'No context queries configured.';

  template = template.replace('{{vault_state}}', vaultState);
  template = template.replace('{{phase_definitions}}', phaseList);
  template = template.replace('{{context_results}}', contextStr);

  return template;
}

// -------------------------------------------------------------------------
// Plan Parsing
// -------------------------------------------------------------------------

/**
 * Parse the orchestrator's response into a structured plan.
 * Falls back to "run all phases" if parsing fails.
 */
export function parseOrchestratorPlan(
  response: string,
  phases: PhaseDefinition[],
): OrchestratorPlan {
  try {
    // Extract JSON from response (may be wrapped in markdown code block)
    const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) ?? response.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) throw new Error('No JSON found in orchestrator response');

    const parsed = JSON.parse(jsonMatch[1]) as OrchestratorPlan;
    if (!Array.isArray(parsed.phases)) throw new Error('phases must be an array');

    return parsed;
  } catch {
    // Fallback: run all phases with default config
    return {
      phases: phases.map(p => ({ name: p.name, skip: false })),
      reasoning: 'Orchestrator response could not be parsed — running all phases.',
    };
  }
}

// -------------------------------------------------------------------------
// Directive Application
// -------------------------------------------------------------------------

/**
 * Apply orchestrator directives to phase definitions.
 * Returns the modified phases list (filtered, reordered, turn-adjusted).
 */
export function applyDirectives(
  phases: PhaseDefinition[],
  directives: OrchestratorPhaseDirective[],
): PhaseDefinition[] {
  const directiveMap = new Map(directives.map(d => [d.name, d]));
  const result: PhaseDefinition[] = [];

  for (const phase of phases) {
    const directive = directiveMap.get(phase.name);

    if (directive?.skip) {
      // Skip this phase — but never skip required phases
      if (phase.required) {
        console.warn(`[orchestrator] Cannot skip required phase "${phase.name}"`);
      } else {
        continue;
      }
    }

    result.push({
      ...phase,
      // Apply turn budget override
      maxTurns: directive?.maxTurns ?? phase.maxTurns,
      // Append context notes to phase prompt
      prompt: directive?.contextNotes
        ? `${phase.prompt}\n\n## Orchestrator Guidance\n${directive.contextNotes}`
        : phase.prompt,
    });
  }

  return result;
}
```

- [ ] **Step 2: Write orchestrator tests**

```typescript
describe('composeOrchestratorPrompt', () => {
  it('substitutes vault state, phase definitions, and context results');
  it('handles empty context results');
});

describe('parseOrchestratorPlan', () => {
  it('parses valid JSON response');
  it('extracts JSON from markdown code block');
  it('falls back to run-all on malformed response');
  it('falls back to run-all on missing phases array');
});

describe('applyDirectives', () => {
  it('skips non-required phases marked skip: true');
  it('refuses to skip required phases (logs warning)');
  it('applies maxTurns override from directive');
  it('appends contextNotes to phase prompt');
  it('preserves phase order when no reordering');
  it('runs all phases when no directives match');
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/agent/orchestrator.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/agent/orchestrator.ts tests/agent/orchestrator.test.ts
git commit -m "feat(agent): add orchestrator planning, parsing, and directive application"
```

---

## Task 5: Integrate Orchestrator into Executor

**Files:**
- Modify: `src/agent/executor.ts`
- Test: `tests/agent/executor.test.ts` (extend)

- [ ] **Step 1: Add orchestrator call before phased execution**

In `executePhasedQuery`, add an orchestrator step before the phase loop:

```typescript
import { composeOrchestratorPrompt, parseOrchestratorPlan, applyDirectives } from './orchestrator.js';
import { executeContextQueries } from './context-queries.js';
import { applyProviderEnv, restoreProviderEnv } from './provider.js';

// Inside executePhasedQuery, before the phase loop:
let effectivePhases = phases;

if (config.orchestrator?.enabled) {
  // 1. Run context queries
  const contextResults = config.contextQueries
    ? await executeContextQueries(agentId, Object.values(config.contextQueries).flat())
    : [];

  // 2. Call orchestrator
  const orchestratorPrompt = composeOrchestratorPrompt(vaultContext, phases, contextResults);
  const orchestratorModel = config.orchestrator.model ?? config.model;
  const orchestratorTurns = config.orchestrator.maxTurns ?? DEFAULT_ORCHESTRATOR_MAX_TURNS;

  let planResponse = '';
  for await (const message of query({
    prompt: orchestratorPrompt,
    options: {
      model: orchestratorModel,
      maxTurns: orchestratorTurns,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: false,
      tools: [],
    },
  })) {
    if (message.type === 'result' && 'result' in message) {
      planResponse = message.result as string;
    }
  }

  // 3. Parse and apply plan
  const plan = parseOrchestratorPlan(planResponse, phases);
  effectivePhases = applyDirectives(phases, plan.phases);
}

// Then iterate effectivePhases instead of phases
```

- [ ] **Step 2: Add provider routing per phase**

In the phase loop, apply/restore provider env for each phase:

```typescript
for (const phase of effectivePhases) {
  const phaseProvider = phase.model
    ? config.execution?.provider  // use task-level provider for non-default models
    : undefined;

  const savedEnv = phaseProvider ? applyProviderEnv(phaseProvider) : null;
  try {
    // ... existing phase query() call ...
  } finally {
    if (savedEnv) restoreProviderEnv(savedEnv);
  }
}
```

- [ ] **Step 3: Update executor tests**

Add tests:
- "orchestrator enabled: runs planning call before phases"
- "orchestrator skips non-required phase when directed"
- "orchestrator cannot skip required phase"
- "orchestrator adjusts turn budget per directive"
- "orchestrator disabled (default): runs all phases statically"
- "orchestrator fallback on parse failure: runs all phases"

- [ ] **Step 4: Run all tests**

Run: `make check`

- [ ] **Step 5: Commit**

```bash
git add src/agent/executor.ts tests/agent/executor.test.ts
git commit -m "feat(agent): integrate orchestrator planning and provider routing into executor"
```

---

## Task 6: Update full-intelligence Task with Orchestrator Config

**Files:**
- Modify: `src/agent/definitions/tasks/full-intelligence.yaml`
- Modify: `src/agent/schemas.ts` (add orchestrator to schema)

- [ ] **Step 1: Add orchestrator schema**

In `src/agent/schemas.ts`:

```typescript
export const OrchestratorConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string().optional(),
  maxTurns: z.number().optional(),
});
```

Add to `AgentTaskSchema`:
```typescript
orchestrator: OrchestratorConfigSchema.optional(),
```

- [ ] **Step 2: Add orchestrator config and context queries to full-intelligence.yaml**

```yaml
orchestrator:
  enabled: true
  model: claude-sonnet-4-6
  maxTurns: 3

contextQueries:
  pre-planning:
    - tool: vault_unprocessed
      queryTemplate: ""
      limit: 5
      purpose: "Check if there are unprocessed batches"
      required: false
    - tool: vault_state
      queryTemplate: ""
      limit: 10
      purpose: "Get agent cursor state"
      required: false
    - tool: vault_spores
      queryTemplate: ""
      limit: 20
      purpose: "Review recent spores for consolidation candidates"
      required: false
```

- [ ] **Step 3: Run loader tests to verify YAML still parses**

Run: `npx vitest run tests/agent/loader.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/agent/schemas.ts src/agent/definitions/tasks/full-intelligence.yaml
git commit -m "feat(agent): enable orchestrator on full-intelligence task with context queries"
```

---

## Task 7: Full Quality Gate

- [ ] **Step 1: Run `make check`**

Expected: All tests pass

- [ ] **Step 2: Run `make build`**

Expected: Bundle succeeds

- [ ] **Step 3: Integration test**

```bash
myco-dev restart
myco-dev agent run                     # verify orchestrator planning runs
myco-dev agent run --task extract-only  # verify non-orchestrated task still works
```

Check daemon logs for orchestrator planning output.

- [ ] **Step 4: Commit any fixes**

---

## Summary

| Task | What it delivers | Depends on |
|------|-----------------|------------|
| 1. Types + Prompt | OrchestratorPlan types, prompt template | Plan 1 |
| 2. Context Queries | Pre-phase data gathering from vault | Plan 1 |
| 3. Provider Env | Ollama/LM Studio/cloud env var management | — |
| 4. Orchestrator | Planning call, parsing, directive application | Tasks 1, 2 |
| 5. Executor Integration | Wire orchestrator + provider into phase loop | Tasks 2, 3, 4 |
| 6. Task Config | Enable orchestrator on full-intelligence | Task 5 |
| 7. Quality Gate | Verification | All |

**After this plan:** The agent intelligently plans its execution — skipping phases with nothing to do, adjusting turn budgets based on workload, and routing models per provider. Combined with Plan 1's user tasks, users can create custom tasks with custom orchestrator behavior.
