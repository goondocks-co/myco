# Vault Curation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically supersede stale spores when new ones are created, and filter superseded spores from digest substrate.

**Architecture:** A `checkSupersession` pipeline in `src/vault/curation.ts` combines vector search (candidate finding) with LLM evaluation (supersession judgment). It's called fire-and-forget after every spore write. The digest engine gets a one-line status filter. A `myco curate` CLI provides one-time vault-wide cleanup.

**Tech Stack:** TypeScript, Vitest, SQLite FTS5, sqlite-vec, Zod

**Spec:** `docs/superpowers/specs/2026-03-20-vault-curation-design.md`

---

### Task 1: Add constants

**Files:**
- Modify: `src/constants.ts`

- [ ] **Step 1: Add supersession constants**

```typescript
// --- Vault curation ---
/** Max candidate spores after post-filtering for supersession check. */
export const SUPERSESSION_CANDIDATE_LIMIT = 5;

/** Over-fetch from vector index before post-filtering by status/type. */
export const SUPERSESSION_VECTOR_FETCH_LIMIT = 20;

/** Max output tokens for supersession LLM evaluation. */
export const SUPERSESSION_MAX_TOKENS = 256;

/** Similarity threshold for clustering related spores in batch curation. */
export const CURATION_CLUSTER_SIMILARITY = 0.75;
```

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(curation): add supersession and curation constants"
```

---

### Task 2: Create supersession prompt

**Files:**
- Create: `src/prompts/supersession.md`

- [ ] **Step 1: Write the prompt template**

```markdown
You are evaluating whether a new observation supersedes any existing observations in a knowledge vault.

An observation is superseded ONLY when the new one makes it factually outdated or incorrect.
Do NOT supersede observations that:
- Discuss the same topic from a different angle
- Record a different decision about the same component
- Describe a trade-off that was considered (even if a different choice was made later)

Examples of supersession:
- New: "The unload API uses instance_id field" → Supersedes: "The unload API uses model field"
- New: "ensureLoaded runs every cycle" → Supersedes: "ensureLoaded runs once via modelReady flag"

Examples of NOT supersession:
- New: "We chose Ollama for digest" → Does NOT supersede: "LM Studio requires KV cache management"
  (Both are valid observations about different providers)
- New: "Added retry logic to summarize" → Does NOT supersede: "summarize throws on 404"
  (The 404 behavior is still true; retry is additive)

## New Observation

{{new_spore}}

## Existing Observations

{{candidates}}

---

Return a JSON array of IDs from the existing observations that the new observation supersedes.
If none are superseded, return an empty array: []

Return ONLY the JSON array, no other text.
```

- [ ] **Step 2: Verify prompt loads**

Run: `npx tsc --noEmit`
Expected: No errors (prompt is a .md file, loaded at runtime via `loadPrompt`)

- [ ] **Step 3: Commit**

```bash
git add src/prompts/supersession.md
git commit -m "feat(curation): add supersession evaluation prompt"
```

---

### Task 3: Create curation module with tests (TDD)

**Files:**
- Create: `src/vault/curation.ts`
- Create: `tests/vault/curation.test.ts`

- [ ] **Step 1: Write the test file with all test cases**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkSupersession } from '@myco/vault/curation';
import type { MycoIndex, IndexedNote } from '@myco/index/sqlite';
import type { VectorIndex } from '@myco/index/vectors';
import type { LlmProvider } from '@myco/intelligence/llm';
import type { EmbeddingProvider } from '@myco/intelligence/llm';

// --- Helpers ---

function makeNote(overrides: Partial<IndexedNote> = {}): IndexedNote {
  return {
    path: 'spores/decision/decision-abc123.md',
    type: 'spore',
    id: 'decision-abc123',
    title: 'Test Decision',
    content: 'We decided to use X.',
    frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' },
    created: '2026-03-15T10:00:00Z',
    ...overrides,
  };
}

function makeMockIndex(notes: IndexedNote[] = []): MycoIndex {
  return {
    query: vi.fn().mockReturnValue(notes),
    queryByIds: vi.fn((ids: string[]) =>
      notes.filter((n) => ids.includes(n.id))
    ),
    getNoteByPath: vi.fn(),
    upsertNote: vi.fn(),
    deleteNote: vi.fn(),
    close: vi.fn(),
    getPragma: vi.fn(),
    getDb: vi.fn(),
  } as unknown as MycoIndex;
}

function makeMockVectorIndex(results: Array<{ id: string; similarity: number }> = []): VectorIndex {
  return {
    search: vi.fn().mockReturnValue(
      results.map((r) => ({ id: r.id, similarity: r.similarity, metadata: { type: 'spore' } }))
    ),
    upsert: vi.fn(),
    delete: vi.fn(),
    close: vi.fn(),
  } as unknown as VectorIndex;
}

function makeMockEmbedding(): EmbeddingProvider {
  return {
    name: 'test',
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3], model: 'test', dimensions: 3 }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

function makeMockLlm(response: string = '[]'): LlmProvider {
  return {
    name: 'test',
    summarize: vi.fn().mockResolvedValue({ text: response, model: 'test' }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

// --- Tests ---

describe('checkSupersession', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns empty when no vector results found', async () => {
    const newSpore = makeNote({ id: 'new-1' });
    const index = makeMockIndex([newSpore]);
    const vectorIndex = makeMockVectorIndex([]);

    const result = await checkSupersession('new-1', {
      index,
      vectorIndex,
      embeddingProvider: makeMockEmbedding(),
      llmProvider: makeMockLlm(),
      vaultDir: '/tmp/vault',
    });

    expect(result).toEqual([]);
  });

  it('returns empty when vectorIndex is null', async () => {
    const result = await checkSupersession('new-1', {
      index: makeMockIndex([makeNote({ id: 'new-1' })]),
      vectorIndex: null as unknown as VectorIndex,
      embeddingProvider: makeMockEmbedding(),
      llmProvider: makeMockLlm(),
      vaultDir: '/tmp/vault',
    });

    expect(result).toEqual([]);
  });

  it('filters candidates by observation_type and active status', async () => {
    const newSpore = makeNote({ id: 'new-1', frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' } });
    const sameType = makeNote({ id: 'old-1', frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' } });
    const diffType = makeNote({ id: 'old-2', frontmatter: { type: 'spore', observation_type: 'gotcha', status: 'active' } });
    const superseded = makeNote({ id: 'old-3', frontmatter: { type: 'spore', observation_type: 'decision', status: 'superseded' } });

    const index = makeMockIndex([newSpore, sameType, diffType, superseded]);
    const vectorIndex = makeMockVectorIndex([
      { id: 'old-1', similarity: 0.9 },
      { id: 'old-2', similarity: 0.85 },
      { id: 'old-3', similarity: 0.8 },
    ]);

    const llm = makeMockLlm('[]');
    await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir: '/tmp/vault',
    });

    // LLM should only see old-1 (same type, active)
    const prompt = (llm.summarize as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(prompt).toContain('old-1');
    expect(prompt).not.toContain('old-2');
    expect(prompt).not.toContain('old-3');
  });

  it('supersedes spores identified by LLM', async () => {
    const newSpore = makeNote({ id: 'new-1', content: 'New approach' });
    const oldSpore = makeNote({ id: 'old-1', content: 'Old approach', path: 'spores/decision/decision-old-1.md' });

    const index = makeMockIndex([newSpore, oldSpore]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    const llm = makeMockLlm('["old-1"]');

    const result = await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir: '/tmp/vault',
    });

    expect(result).toEqual(['old-1']);
  });

  it('skips LLM call when no candidates after filtering', async () => {
    const newSpore = makeNote({ id: 'new-1', frontmatter: { type: 'spore', observation_type: 'decision', status: 'active' } });
    // Only candidate is a different type
    const diffType = makeNote({ id: 'old-1', frontmatter: { type: 'spore', observation_type: 'gotcha', status: 'active' } });

    const index = makeMockIndex([newSpore, diffType]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    const llm = makeMockLlm();

    await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir: '/tmp/vault',
    });

    expect(llm.summarize).not.toHaveBeenCalled();
  });

  it('handles malformed LLM response gracefully', async () => {
    const newSpore = makeNote({ id: 'new-1' });
    const oldSpore = makeNote({ id: 'old-1' });

    const index = makeMockIndex([newSpore, oldSpore]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    const llm = makeMockLlm('Sure! Here are the results: not json at all');

    const result = await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir: '/tmp/vault',
    });

    expect(result).toEqual([]);
  });

  it('filters out hallucinated IDs from LLM response', async () => {
    const newSpore = makeNote({ id: 'new-1' });
    const oldSpore = makeNote({ id: 'old-1' });

    const index = makeMockIndex([newSpore, oldSpore]);
    const vectorIndex = makeMockVectorIndex([{ id: 'old-1', similarity: 0.9 }]);
    // LLM returns a real ID and a hallucinated one
    const llm = makeMockLlm('["old-1", "does-not-exist"]');

    const result = await checkSupersession('new-1', {
      index, vectorIndex, embeddingProvider: makeMockEmbedding(), llmProvider: llm, vaultDir: '/tmp/vault',
    });

    expect(result).toEqual(['old-1']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/vault/curation.test.ts`
Expected: FAIL — module `@myco/vault/curation` does not exist

- [ ] **Step 3: Implement `src/vault/curation.ts`**

The implementation should:
1. Look up the new spore in the FTS index to get its content and observation_type
2. Embed the content via the embedding provider
3. Vector-search with `type: 'spore'`, limit `SUPERSESSION_VECTOR_FETCH_LIMIT`
4. Post-filter: look up each candidate in the FTS index, keep only those with matching `observation_type`, `status === 'active'`, and `id !== newSporeId`
5. If no candidates remain, return `[]`
6. Build the prompt using `loadPrompt('supersession')` with interpolation
7. Call `llmProvider.summarize()` with `SUPERSESSION_MAX_TOKENS`
8. Parse response: use `stripReasoningTokens()` then try `JSON.parse()`. Note: `extractJson()` has an intermediate regex for `{...}` objects that could incorrectly match embedded braces in reasoning text before reaching the direct parse fallback. For arrays, strip reasoning tokens and parse directly, wrapping in try/catch with `[]` fallback
9. Validate with Zod `z.array(z.string())`
10. Filter to only IDs that exist in the index and have `status: 'active'`
11. For each valid ID: call `VaultWriter.updateNoteFrontmatter()` to set `status: 'superseded'` and `superseded_by`, append the Obsidian notice, re-index, delete from vector index
12. Return the list of superseded IDs

Use the existing patterns from `handleMycoSupersede` for the actual supersession writes (frontmatter update + notice append + re-index). Replicate the logic rather than importing the MCP handler directly — the handler has a different interface and mixes input validation with business logic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/vault/curation.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full check**

Run: `make check`
Expected: All tests pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add src/vault/curation.ts tests/vault/curation.test.ts
git commit -m "feat(curation): add checkSupersession pipeline with tests"
```

---

### Task 4: Add digest substrate filtering

**Files:**
- Modify: `src/daemon/digest.ts`
- Modify: `tests/daemon/digest.test.ts`

- [ ] **Step 1: Add test for superseded spore filtering**

Add to the `discoverSubstrate` describe block in `tests/daemon/digest.test.ts`:

```typescript
it('filters out superseded spores', () => {
  const notes = [
    makeNote({ id: 's1', type: 'session' }),
    makeNote({ id: 'm1', type: 'spore', frontmatter: { type: 'spore', status: 'active' } }),
    makeNote({ id: 'm2', type: 'spore', frontmatter: { type: 'spore', status: 'superseded' } }),
    makeNote({ id: 'm3', type: 'spore', frontmatter: { type: 'spore', status: 'archived' } }),
  ];
  const index = makeMockIndex(notes);
  const engine = new DigestEngine({
    vaultDir,
    index,
    llmProvider: makeMockLlm(),
    config: makeConfig(),
  });

  const result = engine.discoverSubstrate(null);
  expect(result).toHaveLength(2);
  expect(result.find((n) => n.id === 's1')).toBeDefined();
  expect(result.find((n) => n.id === 'm1')).toBeDefined();
  expect(result.find((n) => n.id === 'm2')).toBeUndefined();
  expect(result.find((n) => n.id === 'm3')).toBeUndefined();
});

it('includes spores without status field (legacy)', () => {
  const notes = [
    makeNote({ id: 'm1', type: 'spore', frontmatter: { type: 'spore' } }),
  ];
  const index = makeMockIndex(notes);
  const engine = new DigestEngine({
    vaultDir,
    index,
    llmProvider: makeMockLlm(),
    config: makeConfig(),
  });

  const result = engine.discoverSubstrate(null);
  expect(result).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon/digest.test.ts`
Expected: FAIL — superseded spores are not filtered

- [ ] **Step 3: Add status filter to `discoverSubstrate`**

In `src/daemon/digest.ts`, after the existing extract filter in `discoverSubstrate()`, add:

```typescript
// Filter out superseded/archived spores — they've been replaced by newer observations
const filtered = notes
  .filter((n) => n.type !== EXTRACT_TYPE)
  .filter((n) => {
    if (n.type !== 'spore') return true;
    const status = n.frontmatter.status as string | undefined;
    return !status || status === 'active';
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/daemon/digest.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/digest.ts tests/daemon/digest.test.ts
git commit -m "feat(curation): filter superseded spores from digest substrate"
```

---

### Task 5: Wire into daemon batch processor

**Files:**
- Modify: `src/daemon/main.ts`

- [ ] **Step 1: Import checkSupersession**

Add import at top of `src/daemon/main.ts`:

```typescript
import { checkSupersession } from '../vault/curation.js';
```

- [ ] **Step 2: Add fire-and-forget call after spore writes**

In the `writeObservations` function (around line 68), after `indexAndEmbed()` for each observation note, add:

```typescript
// Fire-and-forget supersession check
checkSupersession(note.id, {
  index: deps.index,
  vectorIndex: deps.vectorIndex,
  embeddingProvider: deps.embeddingProvider,
  llmProvider,
  vaultDir: deps.vaultDir,
  log: (level, msg, data) => deps.logger[level]('curation', msg, data),
}).catch((err) => deps.logger.debug('curation', 'Supersession check failed', { id: note.id, error: (err as Error).message }));
```

Follow the exact same fire-and-forget pattern used by `indexAndEmbed` — `.catch()` with debug log, never block the response.

**Note:** `llmProvider` is NOT currently in `IndexDeps` or `writeObservations` scope. The cleanest approach: add the `checkSupersession` call in the `batchManager` callback in `main.ts` (around line 359) where both `llmProvider` and `indexDeps` are in scope, rather than inside `writeObservations` itself. This mirrors how `indexAndEmbed` is called from the batch callback, not from `writeObservationNotes`.

- [ ] **Step 3: Verify build**

Run: `make check`
Expected: All tests pass, no type errors

- [ ] **Step 4: Commit**

```bash
git add src/daemon/main.ts
git commit -m "feat(curation): fire-and-forget supersession check on spore write"
```

---

### Task 6: Wire into MCP remember tool

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Add supersession check to the remember dispatch**

In `src/mcp/server.ts`, in the `myco_remember` case of the tool dispatch switch, after the existing `embedNote()` call, add the supersession check. The MCP server already has `config.embeddingProvider`, `config.vectorIndex`, and can access the LLM provider. Check how other tools access these deps and follow the same pattern.

```typescript
// Fire-and-forget supersession check
if (config.vectorIndex && config.embeddingProvider && config.llmProvider) {
  checkSupersession(result.id, {
    index,
    vectorIndex: config.vectorIndex,
    embeddingProvider: config.embeddingProvider,
    llmProvider: config.llmProvider,
    vaultDir: config.vaultDir,
  }).catch(() => { /* non-fatal */ });
}
```

**Required wiring:** The MCP server's `ServerConfig` interface does NOT have `llmProvider`. You must:
1. Add `llmProvider?: LlmProvider` to the `ServerConfig` interface in `src/mcp/server.ts`
2. Pass `llmProvider` when creating the MCP server in `src/daemon/main.ts` (the daemon already creates `llmProvider` — thread it to the server config)

- [ ] **Step 2: Verify build**

Run: `make check`
Expected: All tests pass, no type errors

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat(curation): add supersession check to myco_remember MCP tool"
```

---

### Task 7: Create `myco curate` CLI command

**Files:**
- Create: `src/cli/curate.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Register the command in `src/cli.ts`**

Add to the USAGE string:

```
  curate [options]         Scan vault and supersede stale spores (--dry-run)
```

Add to the switch-case:

```typescript
case 'curate': return (await import('./cli/curate.js')).run(args, vaultDir);
```

- [ ] **Step 2: Implement `src/cli/curate.ts`**

The CLI command should:
1. Load config, create providers (LLM, embedding), open index and vector index
2. Query all active spores: `index.query({ type: 'spore' })` filtered by `status === 'active'`
3. Group by `observation_type`
4. Within each group, embed each spore and cluster by vector similarity using greedy nearest-neighbor with `CURATION_CLUSTER_SIMILARITY` threshold
5. For each cluster with 2+ spores, build the supersession prompt with ALL cluster members (not just pairwise) and ask the LLM which ones are outdated
6. If `--dry-run`: print proposed supersessions. Otherwise: execute them via the supersede logic from `curation.ts`
7. Print summary: scanned N spores, found M clusters, superseded K

The batch curation logic is fundamentally different from `checkSupersession` (which is single-spore-triggered). Export a separate `curateVault()` function from `src/vault/curation.ts` that takes the full vault scan approach. It shares the supersession prompt and supersede-write logic with `checkSupersession` but has its own clustering and evaluation flow.

Follow the pattern of `src/cli/digest.ts` and `src/cli/reprocess.ts` for provider creation and progress output.

- [ ] **Step 3: Verify build**

Run: `make check`
Expected: All tests pass, no type errors

- [ ] **Step 4: Smoke test**

Run: `node dist/src/cli.js curate --dry-run`
Expected: Scans the vault, prints any proposed supersessions without writing

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/cli/curate.ts
git commit -m "feat(curation): add myco curate CLI command"
```

---

### Task 8: Final integration verification

- [ ] **Step 1: Full test suite**

Run: `make check`
Expected: All tests pass

- [ ] **Step 2: Build**

Run: `make build`
Expected: Clean build

- [ ] **Step 3: Smoke test the inline pipeline**

Restart daemon, create a test spore via `myco_remember`, check daemon logs for curation activity:

```bash
node dist/src/cli.js restart
# (create a spore via an agent session)
tail -20 ~/.myco/vaults/myco/logs/daemon.log | grep curation
```

Expected: Log entries showing supersession check ran

- [ ] **Step 4: Smoke test the CLI**

```bash
node dist/src/cli.js curate --dry-run
```

Expected: Output listing scanned spores, clusters found, and any proposed supersessions

- [ ] **Step 5: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "feat(curation): integration cleanup"
```
