# Digest: Continuous Reasoning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add continuous reasoning (Digest) to the Myco daemon that synthesizes vault knowledge into tiered context extracts, and rename memories → spores across the codebase.

**Architecture:** Two phases — (1) rename memory/memories to spore/spores throughout types, vault, tools, and tests, with a runtime vault migration; (2) build the Digest engine as a daemon task with adaptive timer, tiered prompt pipeline, MCP tool, and session-start injection.

**Tech Stack:** TypeScript, Zod schemas, SQLite FTS5/sqlite-vec, Vitest, Ollama/LM Studio/Anthropic LLM backends.

**Spec:** `docs/superpowers/specs/2026-03-19-digest-continuous-reasoning-design.md`

---

## Phase 1: Spore Migration (memories → spores)

### Task 1: Rename Core Types

**Files:**
- Modify: `src/vault/types.ts`
- Test: `tests/vault/types.test.ts`

- [ ] **Step 1: Update the schema and type exports in types.ts**

Rename in `src/vault/types.ts`:
- `MemoryFrontmatterSchema` → `SporeFrontmatterSchema`
- `type: z.literal('memory')` → `type: z.literal('spore')`
- `MemoryFrontmatter` → `SporeFrontmatter`
- `MEMORY_STATUSES` → `SPORE_STATUSES`
- `MemoryStatus` → `SporeStatus`

Keep `OBSERVATION_TYPES` unchanged (those describe the observation, not the container).

Also update `schemasByType` map (line ~92):
- `memory: MemoryFrontmatterSchema` → `spore: SporeFrontmatterSchema`

This map is used by `parseNoteFrontmatter()` — if not updated, all spore note parsing will fail with `Unknown note type: spore`.

- [ ] **Step 2: Update tests in types.test.ts**

Find all references to `Memory`/`memory` in test descriptions and assertions. Update schema names and `type: 'memory'` → `type: 'spore'` in test fixtures.

- [ ] **Step 3: Run tests to verify**

Run: `npx vitest run tests/vault/types.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/vault/types.ts tests/vault/types.test.ts
git commit -m "refactor: rename MemoryFrontmatterSchema to SporeFrontmatterSchema"
```

---

### Task 2: Rename Writer and Frontmatter Helpers

**Files:**
- Modify: `src/vault/writer.ts`
- Modify: `src/vault/frontmatter.ts`
- Test: `tests/vault/writer.test.ts`

- [ ] **Step 1: Update writer.ts**

Rename in `src/vault/writer.ts`:
- `WriteMemoryInput` → `WriteSporeInput`
- `writeMemory(input: WriteMemoryInput)` → `writeSpore(input: WriteSporeInput)`
- Path: `memories/${normalizedType}` → `spores/${normalizedType}`
- `buildTags('memory', ...)` → `buildTags('spore', ...)`
- Update import from types.ts to use new names

- [ ] **Step 2: Update frontmatter.ts**

Rename in `src/vault/frontmatter.ts`:
- `memoryFm()` → `sporeFm()`
- Import `SporeFrontmatter` instead of `MemoryFrontmatter`
- Return type: `SporeFrontmatter`

- [ ] **Step 3: Update writer tests**

In `tests/vault/writer.test.ts`:
- Rename `writeMemory` → `writeSpore` in all calls and descriptions
- Update expected paths from `memories/` → `spores/`
- Update expected frontmatter `type: 'memory'` → `type: 'spore'`

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/vault/writer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/vault/writer.ts src/vault/frontmatter.ts tests/vault/writer.test.ts
git commit -m "refactor: rename writeMemory to writeSpore, memoryFm to sporeFm"
```

---

### Task 3: Rename Formatter and Observations

**Files:**
- Modify: `src/obsidian/formatter.ts`
- Modify: `src/vault/observations.ts`
- Test: `tests/obsidian/formatter.test.ts` (if exists)
- Test: `tests/vault/observations.test.ts` (if exists)

- [ ] **Step 1: Update formatter.ts**

Rename in `src/obsidian/formatter.ts`:
- `MemoryBodyInput` → `SporeBodyInput`
- `formatMemoryBody()` → `formatSporeBody()`
- `buildTags()`: update `'memory'` references to `'spore'` if present in tag generation

- [ ] **Step 2: Update observations.ts**

Rename in `src/vault/observations.ts`:
- `formatMemoryBody()` → `formatSporeBody()` calls
- `writer.writeMemory()` → `writer.writeSpore()` calls
- Update imports

- [ ] **Step 3: Update tests for formatter and observations**

Update any test files that reference `MemoryBodyInput`, `formatMemoryBody`, or `writeMemory` in observation context.

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: PASS (catch any remaining import breakage across all tests)

- [ ] **Step 5: Commit**

```bash
git add src/obsidian/formatter.ts src/vault/observations.ts
git add -A tests/
git commit -m "refactor: rename formatMemoryBody to formatSporeBody, update observations"
```

---

### Task 4: Rename Constants and Config Schema

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/config/schema.ts`

- [ ] **Step 1: Update constants.ts**

Rename in `src/constants.ts`:
- `CONTEXT_MEMORY_PREVIEW_CHARS` → `CONTEXT_SPORE_PREVIEW_CHARS`
- `RELATED_MEMORIES_LIMIT` → `RELATED_SPORES_LIMIT`
- `PROMPT_CONTEXT_MAX_MEMORIES` → `PROMPT_CONTEXT_MAX_SPORES`
- Grep for any other `MEMORY`/`MEMORIES` constants and rename

- [ ] **Step 2: Update config schema**

In `src/config/schema.ts`, rename the `ContextLayersSchema` key:
```typescript
const ContextLayersSchema = z.object({
  plans: z.number().int().nonnegative().default(200),
  sessions: z.number().int().nonnegative().default(500),
  spores: z.number().int().nonnegative().default(300),  // was: memories
  team: z.number().int().nonnegative().default(200),
});
```

Update the `ContextSchema` default to match:
```typescript
layers: ContextLayersSchema.default({ plans: 200, sessions: 500, spores: 300, team: 200 }),
```

- [ ] **Step 3: Fix all importers of renamed constants**

Grep for old constant names across the codebase and update imports. Key files: `src/context/injector.ts`, `src/hooks/user-prompt-submit.ts`, `src/daemon/main.ts`.

- [ ] **Step 4: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors (catches all broken references)

- [ ] **Step 5: Commit**

```bash
git add src/constants.ts src/config/schema.ts
git add -A src/
git commit -m "refactor: rename memory constants and config keys to spore"
```

---

### Task 5: Update Context Injector

**Files:**
- Modify: `src/context/injector.ts`
- Test: `tests/context/injector.test.ts`

- [ ] **Step 1: Update injector.ts**

In `src/context/injector.ts`:
- `InjectedContext.layers.memories` → `InjectedContext.layers.spores`
- Query filter: `type: 'memory'` → `type: 'spore'`
- Layer heading: `memories` → `spores` (or `Relevant Spores` etc.)
- Import renamed constants (`CONTEXT_SPORE_PREVIEW_CHARS`, etc.)
- Update `sporeFm()` import (was `memoryFm()`)
- Status filter for `superseded`/`archived` stays the same

- [ ] **Step 2: Update injector tests**

In `tests/context/injector.test.ts`:
- Update fixtures: `type: 'memory'` → `type: 'spore'`
- Update assertions: `.layers.memories` → `.layers.spores`
- Update descriptions

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/context/injector.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/context/injector.ts tests/context/injector.test.ts
git commit -m "refactor: update context injector for spore terminology"
```

---

### Task 6: Update MCP Tools

**Files:**
- Modify: `src/mcp/tool-definitions.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/mcp/tools/remember.ts`
- Modify: `src/mcp/tools/supersede.ts`
- Modify: `src/mcp/tools/consolidate.ts`
- Modify: `src/mcp/tools/recall.ts`
- Modify: `src/mcp/tools/search.ts`
- Test: `tests/mcp/tools/remember.test.ts`
- Test: other MCP tool tests

- [ ] **Step 1: Update tool-definitions.ts**

Tool names stay the same (`myco_remember`, `myco_recall`, etc.). Update descriptions and parameter names:
- `old_memory_id` → `old_spore_id` in supersede schema
- `new_memory_id` → `new_spore_id` in supersede schema
- `source_memory_ids` → `source_spore_ids` in consolidate schema
- Update description text: "memory" → "spore" where it appears in user-facing descriptions

- [ ] **Step 2: Update remember.ts**

- `writer.writeMemory()` → `writer.writeSpore()`
- `RememberInput` type stays (it's the tool's input, not tied to the type name)
- Update imports

- [ ] **Step 3: Update supersede.ts**

- `input.old_memory_id` → `input.old_spore_id`
- `input.new_memory_id` → `input.new_spore_id`
- `status: 'superseded'` stays (it's a status, not a type name)
- Update callout text

- [ ] **Step 4: Update consolidate.ts**

- `input.source_memory_ids` → `input.source_spore_ids`
- `wisdomId` naming stays
- `writer.writeMemory()` → `writer.writeSpore()`
- Update callout text

- [ ] **Step 5: Update server.ts**

- Vector metadata: `{ type: 'memory' }` → `{ type: 'spore' }` in `embedNote()` calls
- Update any log messages

- [ ] **Step 6: Update recall.ts and search.ts**

- Query filters: `type: 'memory'` → `type: 'spore'`
- Response formatting: update labels

- [ ] **Step 7: Update MCP tool tests**

Update all test fixtures and assertions: `writeMemory` → `writeSpore`, `type: 'memory'` → `type: 'spore'`, parameter names.

- [ ] **Step 8: Run tests**

Run: `npx vitest run tests/mcp/`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/mcp/ tests/mcp/
git commit -m "refactor: update MCP tools for spore terminology"
```

---

### Task 7: Update CLI and Daemon

**Files:**
- Modify: `src/cli/stats.ts`
- Modify: `src/cli/rebuild.ts`
- Modify: `src/cli/reprocess.ts`
- Modify: `src/cli/init.ts`
- Modify: `src/daemon/main.ts`
- Modify: `src/vault/reader.ts`

- [ ] **Step 1: Update vault reader**

In `src/vault/reader.ts`:
- `readAllNotes()` subdirectories: `'memories'` → `'spores'`

- [ ] **Step 2: Update CLI files**

In `src/cli/stats.ts`:
- `index.query({ type: 'memory' })` → `index.query({ type: 'spore' })`
- Update display labels

In `src/cli/rebuild.ts`:
- Vector metadata `type: 'memory'` → `type: 'spore'`
- Status filter comments

In `src/cli/reprocess.ts`:
- `writeObservationNotes()` already updated via observations.ts
- Any direct `type: 'memory'` references

In `src/cli/init.ts`:
- Any `memories` directory creation → `spores`

- [ ] **Step 3: Update daemon main.ts**

In `src/daemon/main.ts`:
- `migrateMemoryFiles()` → `migrateSporeFiles()` (rename function)
- Update path references: `memories/` → `spores/`
- `writeObservations()` metadata: `{ type: 'memory' }` → `{ type: 'spore' }`
- Update log messages

- [ ] **Step 4: Run full test suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/ src/daemon/main.ts src/vault/reader.ts
git commit -m "refactor: update CLI, daemon, and reader for spore terminology"
```

---

### Task 8: Update Prompts and Vault Migration

**Files:**
- Modify: `src/prompts/extraction.md`
- Modify: `src/daemon/main.ts` (add vault migration)

- [ ] **Step 1: Update extraction prompt**

In `src/prompts/extraction.md`:
- Update any references to "memory" or "memories" to "spore" or "spores" in the prompt text
- The JSON output schema (observation types) stays the same — those are observation types, not container types

- [ ] **Step 2: Add vault migration to daemon startup**

In `src/daemon/main.ts`, add a `migrateMemoriesToSpores()` function called during startup (after existing `migrateSporeFiles()`):

```typescript
async function migrateMemoriesToSpores(vaultDir: string, index: MycoIndex): Promise<number> {
  const memoriesDir = path.join(vaultDir, 'memories');
  const sporesDir = path.join(vaultDir, 'spores');

  // Skip if already migrated (spores exists, memories doesn't)
  if (!fs.existsSync(memoriesDir)) return 0;

  if (fs.existsSync(sporesDir)) {
    // Both exist (interrupted migration) — merge remaining files
    // Walk memories/, move any files not already in spores/
    const moveRemaining = (srcDir: string, destDir: string) => {
      for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const srcPath = path.join(srcDir, entry.name);
        const destPath = path.join(destDir, entry.name);
        if (entry.isDirectory()) {
          if (!fs.existsSync(destPath)) fs.mkdirSync(destPath, { recursive: true });
          moveRemaining(srcPath, destPath);
        } else if (!fs.existsSync(destPath)) {
          fs.renameSync(srcPath, destPath);
        }
        // Skip files that already exist in destination (deduplicate by path)
      }
    };
    moveRemaining(memoriesDir, sporesDir);
    // Clean up empty memories/ directory
    fs.rmSync(memoriesDir, { recursive: true, force: true });
  } else {
    // Clean migration — rename directory
    fs.renameSync(memoriesDir, sporesDir);
  }

  // Walk all .md files, update frontmatter type: 'memory' → type: 'spore'
  let count = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(fullPath); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes('type: memory')) {
        fs.writeFileSync(fullPath, content.replace(/type: memory/g, 'type: spore'));
        count++;
      }
    }
  };
  walk(sporesDir);

  // Trigger full reindex — type field changed in all migrated notes.
  // Read all spore files and re-index them so the SQLite index
  // reflects type: 'spore' instead of stale type: 'memory'.
  const reader = new VaultReader(vaultDir);
  const sporeNotes = reader.listNotes('spores');
  for (const note of sporeNotes) {
    indexNote(index, vaultDir, note.path);
  }

  return count;
}
```

- [ ] **Step 3: Call migration on daemon startup**

Add the call in the startup sequence, before index rebuild:
```typescript
const migrated = await migrateMemoriesToSpores(vaultDir, index);
if (migrated > 0) log.info(`Migrated ${migrated} memories → spores`);
```

- [ ] **Step 4: Run full test suite**

Run: `make check`
Expected: PASS (lint + tests)

- [ ] **Step 5: Commit**

```bash
git add src/prompts/extraction.md src/daemon/main.ts
git commit -m "refactor: add vault migration memories→spores, update extraction prompt"
```

---

### Task 9: Update CLAUDE.md and Remaining References

**Files:**
- Modify: `CLAUDE.md`
- Any remaining files found by grep

- [ ] **Step 1: Grep for remaining references**

Run: `grep -rn "memory\|Memory\|memories" src/ --include="*.ts" | grep -v node_modules | grep -v dist`

Fix any remaining references not yet addressed.

- [ ] **Step 2: Update CLAUDE.md**

In `CLAUDE.md`, update:
- Vault Structure section: `memories/` → `spores/`
- Naming Conventions: `memories/{normalized_type}/` → `spores/{normalized_type}/`
- Data Preservation: `writeMemory` → `writeSpore`
- Idempotence: `writeMemory` → `writeSpore`
- Any other `memory`/`memories` references

- [ ] **Step 3: Run full quality gate**

Run: `make check`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git add -A src/ tests/
git commit -m "refactor: complete spore rename — update CLAUDE.md and remaining references"
```

---

## Phase 2: Digest System

### Task 10: Add Digest Config Schema

**Files:**
- Modify: `src/config/schema.ts`
- Test: `tests/config/schema.test.ts` (if exists)

- [ ] **Step 1: Write failing test for digest config parsing**

```typescript
describe('DigestSchema', () => {
  it('should parse digest config with defaults', () => {
    const config = MycoConfigSchema.parse({ version: 2 });
    expect(config.digest.enabled).toBe(true);
    expect(config.digest.tiers).toEqual([1500, 3000, 5000, 10000]);
    expect(config.digest.inject_tier).toBe(3000);
    expect(config.digest.metabolism.active_interval).toBe(300);
    expect(config.digest.metabolism.dormancy_threshold).toBe(7200);
    expect(config.digest.substrate.max_notes_per_cycle).toBe(50);
  });

  it('should allow intelligence override with nullable fields', () => {
    const config = MycoConfigSchema.parse({
      version: 2,
      digest: {
        intelligence: {
          model: 'qwen3.5-30b',
          context_window: 32768,
        },
      },
    });
    expect(config.digest.intelligence.model).toBe('qwen3.5-30b');
    expect(config.digest.intelligence.provider).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config/`
Expected: FAIL — `digest` not in schema

- [ ] **Step 3: Add DigestSchema to config/schema.ts**

```typescript
const DigestIntelligenceSchema = z.object({
  provider: z.enum(['ollama', 'lm-studio', 'anthropic']).nullable().default(null),
  model: z.string().nullable().default(null),
  base_url: z.string().nullable().default(null),
  context_window: z.number().int().positive().default(32768),
});

const DigestMetabolismSchema = z.object({
  active_interval: z.number().int().positive().default(300),
  cooldown_intervals: z.array(z.number().int().positive()).default([900, 1800, 3600]),
  dormancy_threshold: z.number().int().positive().default(7200),
});

const DigestSubstrateSchema = z.object({
  max_notes_per_cycle: z.number().int().positive().default(50),
});

const DigestSchema = z.object({
  enabled: z.boolean().default(true),
  tiers: z.array(z.number().int().positive()).default([1500, 3000, 5000, 10000]),
  inject_tier: z.number().int().positive().nullable().default(3000),
  intelligence: DigestIntelligenceSchema.default({}),
  metabolism: DigestMetabolismSchema.default({}),
  substrate: DigestSubstrateSchema.default({}),
});
```

Add `digest: DigestSchema.default({})` to `MycoConfigSchema`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/config/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config/schema.ts tests/config/
git commit -m "feat: add digest config schema with metabolism, intelligence, substrate sections"
```

---

### Task 11: Extend QueryOptions with updatedSince

**Files:**
- Modify: `src/index/sqlite.ts`
- Test: `tests/index/sqlite.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('query with updatedSince', () => {
  it('should filter notes by updated_at', async () => {
    // Insert two notes with different updated_at timestamps
    index.upsertNote({ path: 'old.md', type: 'spore', id: 'old', title: 'Old', content: '', frontmatter: {}, created: '2026-03-01' });
    // Wait a tick so updated_at differs
    index.upsertNote({ path: 'new.md', type: 'spore', id: 'new', title: 'New', content: '', frontmatter: {}, created: '2026-03-02' });

    const oldTimestamp = '2026-03-01T12:00:00Z';
    const results = index.query({ updatedSince: oldTimestamp });
    // Should return notes updated after the timestamp
    expect(results.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/index/sqlite.test.ts`
Expected: FAIL — `updatedSince` not recognized

- [ ] **Step 3: Add updatedSince to QueryOptions and query()**

In `src/index/sqlite.ts`:

```typescript
export interface QueryOptions {
  type?: string;
  id?: string;
  limit?: number;
  since?: string;        // existing: filters on created
  updatedSince?: string; // new: filters on updated_at
  frontmatter?: Record<string, string>;
}
```

In the `query()` method, add after the `since` filter:
```typescript
if (options.updatedSince) {
  conditions.push('updated_at >= ?');
  params.push(options.updatedSince);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/index/sqlite.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index/sqlite.ts tests/index/sqlite.test.ts
git commit -m "feat: add updatedSince filter to QueryOptions for substrate discovery"
```

---

### Task 12: Add Digest Constants

**Files:**
- Modify: `src/constants.ts`

- [ ] **Step 1: Add digest-related named constants**

```typescript
// Digest — Metabolism
export const DIGEST_ACTIVE_INTERVAL_MS = 300_000;           // 5 min
export const DIGEST_COOLDOWN_INTERVALS_MS = [900_000, 1_800_000, 3_600_000]; // 15m, 30m, 1h
export const DIGEST_DORMANCY_THRESHOLD_MS = 7_200_000;      // 2 hours
export const DIGEST_ACTIVE_SESSION_WINDOW_MS = 1_800_000;   // 30 min — sessions within this are "active"

// Digest — Tiers
export const DIGEST_TIERS = [1500, 3000, 5000, 10000] as const;
export type DigestTier = (typeof DIGEST_TIERS)[number];

// Digest — Context window minimums per tier (from spec table)
export const DIGEST_TIER_MIN_CONTEXT: Record<number, number> = {
  1500: 6500,
  3000: 11500,
  5000: 18500,
  10000: 30500,
};

// Digest — Substrate
export const DIGEST_MAX_NOTES_PER_CYCLE = 50;
export const DIGEST_SUBSTRATE_TYPE_WEIGHTS: Record<string, number> = {
  session: 3,
  spore: 3,
  plan: 2,
  artifact: 1,
  team: 1,
};

// Digest — System prompt overhead estimate
export const DIGEST_SYSTEM_PROMPT_TOKENS = 500;
```

- [ ] **Step 2: Commit**

```bash
git add src/constants.ts
git commit -m "feat: add digest constants — metabolism, tiers, substrate weights"
```

---

### Task 13: Create Digest Prompt Templates

**Files:**
- Create: `src/prompts/digest-system.md`
- Create: `src/prompts/digest-1500.md`
- Create: `src/prompts/digest-3000.md`
- Create: `src/prompts/digest-5000.md`
- Create: `src/prompts/digest-10000.md`

- [ ] **Step 1: Create shared system prompt**

Create `src/prompts/digest-system.md`:
```markdown
You are Myco's digest engine. Your role is to maintain a living understanding
of a software project by synthesizing observations, session histories, plans,
and team activity into a coherent context representation.

You will receive:
1. Your previous synthesis (if one exists)
2. New substrate — recently captured knowledge that needs to be incorporated

Produce an updated synthesis that:
- Integrates the new substrate into your existing understanding
- Stays within the specified token budget
- Is written for an AI agent that will use this as its primary project context
- Uses present tense for active state, past tense for completed work
- Never fabricates — only synthesize from provided data
- Uses markdown formatting for structure and readability
```

- [ ] **Step 2: Create tier-specific prompts**

Create `src/prompts/digest-1500.md`:
```markdown
Budget: ~1,500 tokens. This is the smallest representation.
Prioritize ruthlessly:
- What is this project? (1-2 sentences)
- What is actively being worked on right now?
- What are the critical gotchas or blockers?
- Who is working on it? (if known)

Drop: historical decisions, completed work, trade-off reasoning, conventions.
An agent reading this should immediately know what it's walking into.
```

Create `src/prompts/digest-3000.md`:
```markdown
Budget: ~3,000 tokens.
Include everything from the briefing tier, plus:
- Recent activity narrative (what happened in the last few sessions)
- Key decisions made and why
- Active plans and their status
- Important conventions or patterns the agent should follow

Drop: deep trade-off reasoning, exhaustive history, edge case wisdom.
An agent reading this should be able to start contributing meaningfully.
```

Create `src/prompts/digest-5000.md`:
```markdown
Budget: ~5,000 tokens.
Include everything from the standup tier, plus:
- Accumulated wisdom: recurring gotchas, established patterns
- Trade-off reasoning behind key architectural decisions
- Cross-cutting concerns that affect multiple areas
- Team member specialties and working patterns

Drop: exhaustive historical detail, completed-and-closed threads.
An agent reading this should understand not just what to do, but why things are the way they are.
```

Create `src/prompts/digest-10000.md`:
```markdown
Budget: ~10,000 tokens.
The full picture. Include everything from the onboarding tier, plus:
- Complete thread histories for active and recently completed work
- Detailed trade-off analysis and alternatives that were rejected
- Plan evolution — what changed and why
- Artifact summaries and their significance
- Lessons learned from past incidents

An agent reading this should have the equivalent of months of project context.
```

- [ ] **Step 3: Commit**

```bash
git add src/prompts/digest-system.md src/prompts/digest-1500.md src/prompts/digest-3000.md src/prompts/digest-5000.md src/prompts/digest-10000.md
git commit -m "feat: add digest prompt templates — system + 4 tier-specific prompts"
```

---

### Task 14: Build Digest Engine Core

**Files:**
- Create: `src/daemon/digest.ts`
- Test: `tests/daemon/digest.test.ts`

This is the largest task. It builds the `DigestEngine` class with substrate discovery, prompt assembly, cycle pipeline, and extract writing.

- [ ] **Step 1: Write failing tests for substrate discovery**

Create `tests/daemon/digest.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { DigestEngine } from '@myco/daemon/digest';

describe('DigestEngine', () => {
  describe('discoverSubstrate', () => {
    it('should return notes updated since last cycle', () => {
      // Setup: mock index with notes at different updated_at timestamps
      // Call discoverSubstrate with a lastCycleTimestamp
      // Assert: only notes after that timestamp are returned
    });

    it('should return empty array when no new substrate exists', () => {
      // Setup: all notes updated before lastCycleTimestamp
      // Assert: empty array
    });

    it('should respect max_notes_per_cycle limit', () => {
      // Setup: more notes than limit
      // Assert: array length <= max_notes_per_cycle
    });

    it('should prioritize by type weight then recency', () => {
      // Setup: mix of sessions, spores, artifacts
      // Assert: sessions and spores come before artifacts
    });
  });

  describe('getEligibleTiers', () => {
    it('should filter tiers by context window', () => {
      const engine = new DigestEngine({ contextWindow: 8192, tiers: [1500, 3000, 5000, 10000] });
      const eligible = engine.getEligibleTiers();
      expect(eligible).toEqual([1500]); // Only 1500 fits in 8K
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/daemon/digest.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement DigestEngine class**

Create `src/daemon/digest.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { MycoIndex, IndexedNote } from '@myco/index/sqlite';
import type { LlmProvider } from '@myco/intelligence/types';
import type { MycoConfig } from '@myco/config/schema';
// loadPrompt() is currently private in src/prompts/index.ts.
// It must be exported as part of this task. Add: export function loadPrompt(...)
import { loadPrompt } from '@myco/prompts/index';
import {
  CHARS_PER_TOKEN,
  DIGEST_TIER_MIN_CONTEXT,
  DIGEST_SUBSTRATE_TYPE_WEIGHTS,
  DIGEST_SYSTEM_PROMPT_TOKENS,
} from '@myco/constants';

export interface DigestCycleResult {
  cycleId: string;
  timestamp: string;
  substrate: {
    sessions: string[];
    spores: string[];
    plans: string[];
    artifacts: string[];
    team: string[];
  };
  tiersGenerated: number[];
  model: string;
  durationMs: number;
  tokensUsed: number;
}

export interface DigestEngineConfig {
  vaultDir: string;
  index: MycoIndex;
  llmProvider: LlmProvider;
  config: MycoConfig;
}

export class DigestEngine {
  private vaultDir: string;
  private index: MycoIndex;
  private llm: LlmProvider;
  private config: MycoConfig;
  private digestDir: string;

  constructor(opts: DigestEngineConfig) {
    this.vaultDir = opts.vaultDir;
    this.index = opts.index;
    this.llm = opts.llmProvider;
    this.config = opts.config;
    this.digestDir = path.join(opts.vaultDir, 'digest');
  }

  /** Find notes updated since the last cycle */
  discoverSubstrate(lastCycleTimestamp: string | null): IndexedNote[] {
    const maxNotes = this.config.digest.substrate.max_notes_per_cycle;
    const notes = lastCycleTimestamp
      ? this.index.query({ updatedSince: lastCycleTimestamp })
      : this.index.query({ limit: maxNotes });

    // Filter out extract notes (don't digest our own output)
    const filtered = notes.filter((n) => n.type !== 'extract');

    // Sort by type weight (desc) then recency (desc)
    filtered.sort((a, b) => {
      const wa = DIGEST_SUBSTRATE_TYPE_WEIGHTS[a.type] ?? 0;
      const wb = DIGEST_SUBSTRATE_TYPE_WEIGHTS[b.type] ?? 0;
      if (wb !== wa) return wb - wa;
      return b.created.localeCompare(a.created);
    });

    return filtered.slice(0, maxNotes);
  }

  /** Determine which tiers can run given the context window */
  getEligibleTiers(): number[] {
    const contextWindow = this.config.digest.intelligence.context_window;
    return this.config.digest.tiers.filter(
      (tier) => (DIGEST_TIER_MIN_CONTEXT[tier] ?? Infinity) <= contextWindow,
    );
  }

  /** Format substrate notes for prompt injection */
  formatSubstrate(notes: IndexedNote[], tokenBudget: number): string {
    const charBudget = tokenBudget * CHARS_PER_TOKEN;
    const lines: string[] = [];
    let chars = 0;

    for (const note of notes) {
      const fm = note.frontmatter as Record<string, unknown>;
      let header: string;
      const noteType = fm.observation_type
        ? `${note.type}:${fm.observation_type}`
        : note.type;

      header = `### [${noteType}] ${note.id}`;
      if (note.title) header += ` — "${note.title}"`;

      const preview = note.content.slice(0, charBudget - chars);
      const block = `${header}\n${preview}\n`;

      if (chars + block.length > charBudget) break;
      lines.push(block);
      chars += block.length;
    }

    return lines.join('\n');
  }

  /** Read the previous extract for a tier */
  readPreviousExtract(tier: number): string | null {
    const extractPath = path.join(this.digestDir, `extract-${tier}.md`);
    if (!fs.existsSync(extractPath)) return null;
    const content = fs.readFileSync(extractPath, 'utf-8');
    // Strip YAML frontmatter, return body only
    const fmEnd = content.indexOf('---', 3);
    return fmEnd > 0 ? content.slice(fmEnd + 3).trim() : content;
  }

  /** Write an extract file with frontmatter */
  writeExtract(tier: number, body: string, cycleId: string, model: string, substrateCount: number): void {
    if (!fs.existsSync(this.digestDir)) {
      fs.mkdirSync(this.digestDir, { recursive: true });
    }
    const frontmatter = [
      '---',
      'type: extract',
      `tier: ${tier}`,
      `generated: ${new Date().toISOString()}`,
      `cycle_id: ${cycleId}`,
      `substrate_count: ${substrateCount}`,
      `model: ${model}`,
      '---',
    ].join('\n');

    const extractPath = path.join(this.digestDir, `extract-${tier}.md`);
    const tmpPath = `${extractPath}.tmp`;
    fs.writeFileSync(tmpPath, `${frontmatter}\n\n${body}`);
    fs.renameSync(tmpPath, extractPath);
  }

  /** Append a cycle record to the trace */
  appendTrace(record: DigestCycleResult): void {
    if (!fs.existsSync(this.digestDir)) {
      fs.mkdirSync(this.digestDir, { recursive: true });
    }
    const tracePath = path.join(this.digestDir, 'trace.jsonl');
    fs.appendFileSync(tracePath, JSON.stringify(record) + '\n');
  }

  /** Get the timestamp of the last cycle from the trace */
  getLastCycleTimestamp(): string | null {
    const tracePath = path.join(this.digestDir, 'trace.jsonl');
    if (!fs.existsSync(tracePath)) return null;
    const lines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n');
    if (lines.length === 0 || lines[0] === '') return null;
    const last = JSON.parse(lines[lines.length - 1]) as DigestCycleResult;
    return last.timestamp;
  }

  /** Run a full digest cycle */
  async runCycle(): Promise<DigestCycleResult | null> {
    const lastTimestamp = this.getLastCycleTimestamp();
    const substrate = this.discoverSubstrate(lastTimestamp);

    if (substrate.length === 0) return null;

    const cycleId = `dc-${Date.now().toString(36)}`;
    const startTime = Date.now();
    const eligibleTiers = this.getEligibleTiers();
    const tiersGenerated: number[] = [];
    let totalTokens = 0;

    const systemPrompt = loadPrompt('digest-system');

    // Group substrate by type for the trace
    const substrateByType: DigestCycleResult['substrate'] = {
      sessions: [], spores: [], plans: [], artifacts: [], team: [],
    };
    for (const note of substrate) {
      const key = note.type as keyof typeof substrateByType;
      if (key in substrateByType) {
        substrateByType[key].push(note.id);
      }
    }

    for (const tier of eligibleTiers) {
      const tierPrompt = loadPrompt(`digest-${tier}`);
      const previousExtract = this.readPreviousExtract(tier);

      // Calculate substrate token budget
      const previousTokens = previousExtract
        ? Math.ceil(previousExtract.length / CHARS_PER_TOKEN)
        : 0;
      const substrateBudget = this.config.digest.intelligence.context_window
        - tier                       // output tokens
        - previousTokens             // previous extract
        - DIGEST_SYSTEM_PROMPT_TOKENS; // system + tier prompt

      const formattedSubstrate = this.formatSubstrate(substrate, substrateBudget);

      const prompt = [
        tierPrompt,
        '',
        '## Previous Synthesis',
        previousExtract ?? 'No previous synthesis exists.',
        '',
        '## New Substrate',
        formattedSubstrate,
        '',
        '## Instructions',
        `Produce your updated synthesis now. Stay within ${tier} tokens.`,
      ].join('\n');

      // LlmProvider.summarize() takes a single prompt string (no separate system prompt).
      // Concatenate system + tier prompt + content into one prompt.
      const fullPrompt = `${systemPrompt}\n\n${prompt}`;
      const response = await this.llm.summarize(fullPrompt, {
        maxTokens: tier,
      });

      this.writeExtract(tier, response.text, cycleId, response.model, substrate.length);
      tiersGenerated.push(tier);
      totalTokens += Math.ceil(prompt.length / CHARS_PER_TOKEN) + Math.ceil(response.text.length / CHARS_PER_TOKEN);
    }

    const result: DigestCycleResult = {
      cycleId,
      timestamp: new Date().toISOString(),
      substrate: substrateByType,
      tiersGenerated,
      model: this.config.digest.intelligence.model ?? this.config.intelligence.llm.model,
      durationMs: Date.now() - startTime,
      tokensUsed: totalTokens,
    };

    this.appendTrace(result);
    return result;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/daemon/digest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/digest.ts tests/daemon/digest.test.ts
git commit -m "feat: implement DigestEngine — substrate discovery, cycle pipeline, extract writing"
```

---

### Task 15: Add Metabolism (Adaptive Timer)

**Files:**
- Modify: `src/daemon/digest.ts`
- Test: `tests/daemon/digest.test.ts`

- [ ] **Step 1: Write failing tests for metabolism**

```typescript
describe('Metabolism', () => {
  it('should start in active state', () => {
    const metabolism = new Metabolism(config.digest.metabolism);
    expect(metabolism.state).toBe('active');
  });

  it('should advance through cooldown on empty cycles', () => {
    const metabolism = new Metabolism(config.digest.metabolism);
    metabolism.onEmptyCycle();
    expect(metabolism.currentIntervalMs).toBe(900_000); // first cooldown
    metabolism.onEmptyCycle();
    expect(metabolism.currentIntervalMs).toBe(1_800_000); // second cooldown
  });

  it('should enter dormancy after threshold', () => {
    const metabolism = new Metabolism(config.digest.metabolism);
    metabolism.markLastSubstrate(Date.now() - 7_200_001);
    metabolism.checkDormancy();
    expect(metabolism.state).toBe('dormant');
  });

  it('should activate from dormancy', () => {
    const metabolism = new Metabolism(config.digest.metabolism);
    metabolism.state = 'dormant';
    metabolism.activate();
    expect(metabolism.state).toBe('active');
    expect(metabolism.currentIntervalMs).toBe(300_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/daemon/digest.test.ts`
Expected: FAIL — Metabolism not exported

- [ ] **Step 3: Implement Metabolism class**

Add to `src/daemon/digest.ts`:

```typescript
export type MetabolismState = 'active' | 'cooling' | 'dormant';

export class Metabolism {
  state: MetabolismState = 'active';
  currentIntervalMs: number;
  private cooldownStep = 0;
  private lastSubstrateTime: number = Date.now();
  private activeIntervalMs: number;
  private cooldownIntervalsMs: number[];
  private dormancyThresholdMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: { active_interval: number; cooldown_intervals: number[]; dormancy_threshold: number }) {
    this.activeIntervalMs = config.active_interval * 1000;
    this.cooldownIntervalsMs = config.cooldown_intervals.map((s) => s * 1000);
    this.dormancyThresholdMs = config.dormancy_threshold * 1000;
    this.currentIntervalMs = this.activeIntervalMs;
  }

  onSubstrateFound(): void {
    this.lastSubstrateTime = Date.now();
    this.state = 'active';
    this.cooldownStep = 0;
    this.currentIntervalMs = this.activeIntervalMs;
  }

  onEmptyCycle(): void {
    if (this.state === 'dormant') return;
    this.state = 'cooling';
    if (this.cooldownStep < this.cooldownIntervalsMs.length) {
      this.currentIntervalMs = this.cooldownIntervalsMs[this.cooldownStep];
      this.cooldownStep++;
    }
    this.checkDormancy();
  }

  checkDormancy(): void {
    const elapsed = Date.now() - this.lastSubstrateTime;
    if (elapsed >= this.dormancyThresholdMs) {
      this.state = 'dormant';
      this.currentIntervalMs = 0; // timer suspended
    }
  }

  activate(): void {
    this.state = 'active';
    this.cooldownStep = 0;
    this.currentIntervalMs = this.activeIntervalMs;
    this.lastSubstrateTime = Date.now();
  }

  markLastSubstrate(time: number): void {
    this.lastSubstrateTime = time;
  }

  start(callback: () => Promise<void>): void {
    this.scheduleNext(callback);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleNext(callback: () => Promise<void>): void {
    if (this.state === 'dormant' || this.currentIntervalMs <= 0) return;
    this.timer = setTimeout(async () => {
      await callback();
      this.scheduleNext(callback);
    }, this.currentIntervalMs);
    // Don't block process exit
    if (this.timer.unref) this.timer.unref();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/daemon/digest.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/digest.ts tests/daemon/digest.test.ts
git commit -m "feat: add Metabolism — adaptive timer with active/cooling/dormant states"
```

---

### Task 16: Integrate Digest into Daemon

**Files:**
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Import and initialize DigestEngine in daemon startup**

In `src/daemon/main.ts`, after existing initialization (index, plan watcher, batch manager):

```typescript
import { DigestEngine, Metabolism } from '@myco/daemon/digest';

// In startup, after index and providers are initialized:
if (config.digest.enabled) {
  // Build digest LLM provider: use digest overrides where non-null, fall back to main config
  const digestLlmConfig = {
    provider: config.digest.intelligence.provider ?? config.intelligence.llm.provider,
    model: config.digest.intelligence.model ?? config.intelligence.llm.model,
    base_url: config.digest.intelligence.base_url ?? config.intelligence.llm.base_url,
    context_window: config.digest.intelligence.context_window,
  };
  const digestLlm = (config.digest.intelligence.model || config.digest.intelligence.provider)
    ? createLlmProvider(digestLlmConfig)
    : llmProvider; // no overrides — reuse main provider

  const digestEngine = new DigestEngine({
    vaultDir,
    index,
    llmProvider: digestLlm,
    config,
  });

  const metabolism = new Metabolism(config.digest.metabolism);

  // Run initial cycle if substrate exists
  const result = await digestEngine.runCycle();
  if (result) {
    metabolism.onSubstrateFound();
    log.info(`Initial digest cycle: ${result.tiersGenerated.length} tiers, ${result.durationMs}ms`);
  }

  // Start metabolism timer
  metabolism.start(async () => {
    const cycleResult = await digestEngine.runCycle();
    if (cycleResult) {
      metabolism.onSubstrateFound();
      log.info(`Digest cycle ${cycleResult.cycleId}: ${cycleResult.tiersGenerated.length} tiers`);
    } else {
      metabolism.onEmptyCycle();
      log.debug('Digest: no substrate, backing off');
    }
  });

  // Activate on session registration
  // In the /sessions/register route handler, add:
  metabolism.activate();
}
```

- [ ] **Step 2: Verify config auto-migration for upgrades**

No YAML file mutation needed. The `DigestSchema` uses `.default({})` at every level, so when an existing `myco.yaml` has no `digest` section, Zod parsing fills in all defaults automatically:
- `enabled: true`
- `tiers: [1500, 3000, 5000, 10000]`
- `inject_tier: 3000`
- All metabolism and substrate defaults

Verify this works by adding a test: parse a config YAML with no `digest` key, assert defaults are populated. The daemon logs should note when digest is running for the first time:

```typescript
if (config.digest.enabled) {
  log.info('Digest enabled — starting metabolism');
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat: integrate DigestEngine into daemon startup with metabolism and activation"
```

---

### Task 17: Create myco_context MCP Tool

**Files:**
- Create: `src/mcp/tools/context.ts`
- Modify: `src/mcp/tool-definitions.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp/tools/context.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/mcp/tools/context.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { handleMycoContext } from '@myco/mcp/tools/context';

describe('myco_context', () => {
  it('should return extract content for requested tier', () => {
    // Setup: write a mock extract-3000.md to tmpDir/digest/
    const result = handleMycoContext(tmpDir, { tier: 3000 });
    expect(result.content).toContain('synthesized content');
    expect(result.tier).toBe(3000);
  });

  it('should fall back to nearest tier when requested tier unavailable', () => {
    // Setup: only extract-1500.md exists
    const result = handleMycoContext(tmpDir, { tier: 5000 });
    expect(result.tier).toBe(1500);
    expect(result.fallback).toBe(true);
  });

  it('should return not-ready message when no extracts exist', () => {
    const result = handleMycoContext(tmpDir, { tier: 3000 });
    expect(result.content).toContain('not yet available');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/context.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement context tool handler**

Create `src/mcp/tools/context.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { DIGEST_TIERS } from '@myco/constants';

interface ContextInput {
  tier?: number;
}

interface ContextResult {
  content: string;
  tier: number;
  fallback: boolean;
  generated?: string;
}

export function handleMycoContext(vaultDir: string, input: ContextInput): ContextResult {
  const requestedTier = input.tier ?? 3000;
  const digestDir = path.join(vaultDir, 'digest');

  // Try exact tier first
  const exactPath = path.join(digestDir, `extract-${requestedTier}.md`);
  if (fs.existsSync(exactPath)) {
    return readExtract(exactPath, requestedTier, false);
  }

  // Fall back to nearest available tier
  const available = DIGEST_TIERS
    .filter((t) => fs.existsSync(path.join(digestDir, `extract-${t}.md`)))
    .sort((a, b) => Math.abs(a - requestedTier) - Math.abs(b - requestedTier));

  if (available.length > 0) {
    const fallbackTier = available[0];
    const fallbackPath = path.join(digestDir, `extract-${fallbackTier}.md`);
    return readExtract(fallbackPath, fallbackTier, true);
  }

  return {
    content: 'Digest context is not yet available. The first digest cycle has not completed. Context will be available after the daemon processes vault data.',
    tier: requestedTier,
    fallback: false,
  };
}

function readExtract(filePath: string, tier: number, fallback: boolean): ContextResult {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // Strip YAML frontmatter
  const fmEnd = raw.indexOf('---', 3);
  const body = fmEnd > 0 ? raw.slice(fmEnd + 3).trim() : raw;

  // Extract generated timestamp from frontmatter
  const generatedMatch = raw.match(/generated:\s*(.+)/);
  const generated = generatedMatch?.[1]?.trim();

  let content = body;
  if (fallback) {
    content = `[Note: Requested tier ${tier} unavailable, serving nearest available tier]\n\n${body}`;
  }

  return { content, tier, fallback, generated };
}
```

- [ ] **Step 4: Register tool in tool-definitions.ts**

Add to `src/mcp/tool-definitions.ts`:

```typescript
export const TOOL_CONTEXT = 'myco_context';

// Add to TOOL_DEFINITIONS array:
{
  name: TOOL_CONTEXT,
  description: 'Retrieve Myco\'s synthesized understanding of this project. Returns a pre-computed context extract at the requested token tier. Available tiers: 1500 (executive briefing), 3000 (team standup), 5000 (deep onboarding), 10000 (institutional knowledge). This is a rich, always-current synthesis of project history, decisions, patterns, and active work — not a search result.',
  inputSchema: {
    type: 'object',
    properties: {
      tier: {
        type: 'number',
        enum: [1500, 3000, 5000, 10000],
        description: 'Token budget tier. Larger tiers include more detail. Default: 3000.',
      },
    },
  },
}
```

- [ ] **Step 5: Add case to server.ts switch**

In `src/mcp/server.ts`, add to the `CallToolRequestSchema` switch:

```typescript
case TOOL_CONTEXT: {
  const result = handleMycoContext(config.vaultDir, args as { tier?: number });
  return { content: [{ type: 'text', text: result.content }] };
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/mcp/tools/context.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/mcp/tools/context.ts src/mcp/tool-definitions.ts src/mcp/server.ts tests/mcp/tools/context.test.ts
git commit -m "feat: add myco_context MCP tool — serves tiered digest extracts"
```

---

### Task 18: Update Session-Start Injection

**Files:**
- Modify: `src/hooks/session-start.ts`
- Modify: `src/daemon/main.ts` (the `/context` route handler)

- [ ] **Step 1: Update the /context route to serve digest extract when enabled**

In `src/daemon/main.ts`, modify the `/context` route handler:

```typescript
server.registerRoute('POST', '/context', async (body: unknown) => {
  const { session_id, branch } = body;

  // If digest is enabled and inject_tier is set, serve the extract
  if (config.digest.enabled && config.digest.inject_tier) {
    const { handleMycoContext } = await import('@myco/mcp/tools/context');
    const result = handleMycoContext(vaultDir, { tier: config.digest.inject_tier });

    if (result.content && !result.content.includes('not yet available')) {
      return {
        context: result.content,
        source: 'digest',
        tier: result.tier,
      };
    }
    // Fall through to layer-based injection if no extract exists yet
  }

  // Existing layer-based injection (fallback)
  const context = buildInjectedContext(index, config, { sessionId: session_id, branch });
  return { context: context.text, source: 'layers' };
});
```

- [ ] **Step 2: Update session-start.ts to handle the new response format**

In `src/hooks/session-start.ts`, the hook already outputs the context text from the daemon response. If the response includes `source: 'digest'`, no change needed — it outputs the text either way. But add logging:

```typescript
if (response.source === 'digest') {
  log.debug(`Injecting digest extract (tier ${response.tier})`);
}
```

- [ ] **Step 3: Run type check**

Run: `npx tsc --noEmit`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/daemon/main.ts src/hooks/session-start.ts
git commit -m "feat: serve digest extract at session start, fallback to layer-based injection"
```

---

### Task 19: Full Integration Test

**Files:**
- Test: `tests/daemon/digest.test.ts` (extend)

- [ ] **Step 1: Add integration test for full digest cycle**

```typescript
describe('DigestEngine integration', () => {
  it('should run a full cycle: discover → synthesize → write extracts → trace', async () => {
    // Setup:
    // 1. Create tmpDir with vault structure
    // 2. Write mock session and spore notes to vault
    // 3. Index them
    // 4. Create DigestEngine with mock LLM provider
    // 5. Run cycle

    const mockLlm = {
      name: 'test',
      summarize: async (prompt: string) => ({
        text: 'Synthesized project understanding...',
        model: 'test-model',
      }),
      isAvailable: async () => true,
    };

    const engine = new DigestEngine({
      vaultDir: tmpDir,
      index,
      llmProvider: mockLlm as LlmProvider,
      config: testConfig,
    });

    const result = await engine.runCycle();

    // Verify extracts written
    expect(fs.existsSync(path.join(tmpDir, 'digest', 'extract-1500.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'digest', 'extract-3000.md'))).toBe(true);

    // Verify trace appended
    const trace = fs.readFileSync(path.join(tmpDir, 'digest', 'trace.jsonl'), 'utf-8');
    const record = JSON.parse(trace.trim());
    expect(record.cycleId).toBeDefined();
    expect(record.tiersGenerated).toContain(1500);
    expect(record.substrate.sessions.length).toBeGreaterThan(0);

    // Verify result
    expect(result).not.toBeNull();
    expect(result!.durationMs).toBeGreaterThan(0);
  });

  it('should return null when no substrate exists', async () => {
    // Setup: empty index, no notes
    const result = await engine.runCycle();
    expect(result).toBeNull();
  });

  it('should skip tiers that exceed context window', async () => {
    // Setup: config with context_window: 8192
    // Only 1500 tier should be generated
    const result = await engine.runCycle();
    expect(result!.tiersGenerated).toEqual([1500]);
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `make check`
Expected: PASS (lint + all tests)

- [ ] **Step 3: Commit**

```bash
git add tests/daemon/digest.test.ts
git commit -m "test: add digest integration tests — full cycle, empty substrate, tier gating"
```

---

### Task 20: Update CLAUDE.md with Digest Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add digest to CLAUDE.md**

Update the following sections:

**Architecture section** — add `digest/` to the vault structure diagram.

**Vault Structure section** — add `digest/` directory with description.

**Glossary** — add the full glossary from the spec (Digest, Extract, Substrate, Trace, Metabolism, Dormancy, Activation, Spore).

**Golden Paths** — add "Restart daemon after code changes" note about digest.

**Module Boundaries** — note that the Digest module is a daemon task, not a hook.

- [ ] **Step 2: Run quality gate**

Run: `make check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with digest system and spore terminology"
```

---

## Verification Checklist

After completing all tasks:

- [ ] `make check` passes (lint + tests)
- [ ] `make build` succeeds
- [ ] Daemon starts cleanly with `node dist/src/cli.js restart`
- [ ] Vault migration runs (memories/ → spores/) on first startup
- [ ] Digest cycle runs within 5 minutes of daemon start
- [ ] Extract files appear in `vault/digest/`
- [ ] `myco_context` MCP tool returns extract content
- [ ] Session-start hook injects extract when configured
- [ ] Metabolism backs off when no new data arrives
- [ ] All existing MCP tools still work with spore terminology
