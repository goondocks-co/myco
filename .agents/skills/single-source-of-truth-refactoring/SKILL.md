---
name: myco:single-source-of-truth-refactoring
description: |
  Apply this skill whenever you encounter logic, values, or transformations
  duplicated across multiple files in the Myco codebase — even if the user
  doesn't explicitly ask for a refactor. Covers five recurring SSoT patterns:
  (1) extracting shared read projections to read-projections.ts, (2)
  centralizing provider capabilities in context-windows.ts, (3) replacing
  magic strings with named constants in constants.ts, (4) creating semantic
  wrapper functions in config/loader.ts and settings-merge.ts, and (5) adding
  path properties to service state objects (DaemonServiceState). Also covers
  two critical violation classes to detect during code review: parallel
  ownership predicates (is-this-mine? checks duplicated across files) and
  database query locality (direct DB calls in tool files that bypass the shared
  data access layer). The root discipline is: name the thing, own it in one
  place, let consumers reference it.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Single-Source-of-Truth Refactoring

The Myco codebase has a recurring architectural smell: logic, values, or transformations scattered across multiple files with no canonical owner. When two consumers independently compute or verify the same thing, they drift — silently. CI stays green while production ships divergent behavior. This skill documents five fix patterns and two violation classes discovered across six independent sessions of Myco development.

**Core discipline:** Name the thing, own it in one place, let consumers reference it.

## Prerequisites

- Identify the canonical home before touching code: is there already an obvious module that *should* own this value? (`constants.ts` for named scalars, `context-windows.ts` for provider capability defaults, service state objects for related file paths, `grove/paths.ts` for daemon-scoping decisions)
- Grep for all existing usages before extracting so no call site is missed:
  ```bash
  grep -rn "the-pattern-or-literal" packages/
  ```
- Confirm tests cover the scattered behavior before deleting any duplicate path

## Procedure A: Detecting SSoT Violations During Code Review

Apply these two checks when reviewing any PR that touches shared infrastructure. The violations surface as runtime failures, not compile errors — catching them here saves production incidents.

### Check 1 — Re-computation of an already-available value

Flag any function that re-derives a value already available from a canonical source in the same call chain.

Ask: "Does a helper already exist that produces this?" If yes, the consumer should call the canonical source, not re-derive it inline.

**Example trigger:** A file computing a daemon variant string inline at its own call site when a canonical helper already exists and is co-located with the relevant domain module.

### Check 2 — Parallel ownership predicates

Flag when two or more code paths independently answer "does this file/content belong to Myco?" using different checks.

Symptoms:
- One path uses a regex, another uses substring matching
- The match strings in each check don't exactly agree
- A file could pass one check and fail the other

**Real example:** `installer.ts:1278` had regex `/\bmyco-run\.cjs\b|\bmyco-hook\.cjs\b|\blauncher\.cjs\b/` while `install-helpers.ts:isMycoHookCommand` used different substring checks. When they diverged, uninstall silently failed on files that only one path recognized as Myco-owned.

**Fix signal:** Consolidate into a single helper with a named constant for the match strings (see Procedure E2).

## Procedure B: Extracting Shared Read Projections

**When:** Two or more consumers (agent tools, harness, API, context queries) independently define the same lean field shape for a database entity.

**Smell:** The same "pick these fields from a batch/session/spore" logic exists in both `read-tools.ts` and `context-queries.ts`. When they drift, agents receive a different field shape than what the harness validates against — silently.

**Fix:**

1. Create named projection functions in `read-projections.ts`:
   ```typescript
   export function projectBatchForAgent(b: BatchRow, options: ProjectionOptions = {}) {
     return { user_prompt: b.user_prompt, response_summary: b.response_summary };
   }
   export function projectSessionForAgent(s: SessionRow, options: ProjectionOptions = {}) {
     return { title: s.title, summary: s.summary, /* counts */ };
   }
   export function projectSporeForAgent(sp: SporeRow, options: ProjectionOptions = {}) {
     return { observation_type: sp.observation_type, title: sp.title, importance: sp.importance };
   }
   // projectEntityForAgent(), projectEdgeForAgent() follow the same pattern
   ```

2. Replace inline field picks in every consumer (`read-tools.ts`, `context-queries.ts`, any API layer) with calls to the shared projection functions.

3. Verify: a field shape change in `projectSessionForAgent()` now propagates to all consumers automatically — no grep required to find missed usages.

**Rule:** Any data transformation used by multiple consumers (tools + harness + API) belongs in a shared projection layer, not duplicated at each call site.

## Procedure C: Centralizing Provider Capability Defaults

**When:** Provider-specific metadata (context window sizes, capability flags) appears as switch statements or hardcoded constants in multiple files.

**Smell:** `run-accounting.ts`, `executor-state.ts`, and `openai.ts` each had independent `switch(provider)` blocks returning context window sizes. Adding a new provider required changes in all three.

**Fix:**

1. Define named constants in `context-windows.ts`:
   ```typescript
   /** Inferred frontier-model context window when the provider does not expose one. */
   export const DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS = 200_000;

   /** Inferred OpenAI-compatible cloud context window when the provider does not expose one. */
   export const DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS = 128_000;

   /** Default context window Myco applies for local agent runs when no override is set. */
   export const DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS = 32_768;
   ```

2. Update `run-accounting.ts`'s `resolveContextWindow()` to import and use these constants as fallback defaults rather than repeating literals inline.

3. Remove hardcoded switch blocks from `run-accounting.ts`, `executor-state.ts`, `openai.ts`. Capability queries now route through the centralized constants.

**Rule:** Provider capability defaults belong in `context-windows.ts`. Adding a new provider's default context window is a single-line edit; without this file, it's a multi-file grep.

## Procedure D: Replacing Magic Strings and Inline Strategy Config

Two related smells — both resolved by extracting a named owner. Handle them together when they co-occur.

### D1 — Magic string literals

**When:** The same string literal (a fallback name, filename, event key, variant tag) appears in 3+ code paths.

**Fix:**
1. Add a named constant to `constants.ts`:
   ```typescript
   // constants.ts
   export const DEFAULT_SYMBIONT_NAME = 'claude-code';
   ```
2. Replace all occurrences — use grep to find every call site including interpolated forms:
   ```bash
   grep -rn "DEFAULT_SYMBIONT_NAME\|'claude-code'" packages/myco/src/
   ```
3. Add or verify a regression test for the fallback path (model: `manifest-schema.test.ts`).

Because changing the string now requires touching `constants.ts` once, a literal change is a single diff line. Without the constant, grep-and-hope misses aliased or interpolated uses.

### D2 — Inline strategy configuration

**When:** `deepMerge(a, b, { arrayStrategy: 'replace' })` (or similar option objects embedding semantic decisions) appears at multiple call sites.

**Fix — create named semantic wrappers in the appropriate module file:**

- Config overlay wrapper in `config/loader.ts`:
  ```typescript
  /** Config overlay uses replace semantics: arrays in source overwrite arrays in target. */
  export function deepMergeConfig<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
    return deepMerge(target, source, { arrayStrategy: 'replace' });
  }
  ```

- Settings merge wrapper in `symbionts/settings-merge.ts`:
  ```typescript
  /** Symbiont settings merge uses union semantics: arrays are concatenated and deduped. */
  export function deepMergeSettings(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    return deepMerge(target, source, { arrayStrategy: 'union' });
  }
  ```

Both wrappers call the primitive `deepMerge()` from `utils/deep-merge.ts` with the appropriate strategy. Each wrapper lives in its domain module — not in the utility itself.

Named wrappers win over inlining because:
- `deepMergeConfig` signals intent at the call site — readers understand *this is config overlay* without deciphering the options object
- Changing strategy for all config merges is a single-line edit in the wrapper, not a grep across call sites
- New developers reading `deepMergeConfig` get context for free; inline option literals require knowing the semantics externally

Trade-off: 2–4 lines of wrapper noise. Semantic clarity wins for shared infrastructure.

### D3 — Config write path canonicalization

**When:** Multiple callers independently load a config file, spread its contents, mutate a field, and re-save — the load-spread-save anti-pattern.

**Fix:** Use `updateTierConfigRaw` (in `config/loader.ts`) as the single canonical write path for machine/grove config changes:
```typescript
// Before: load-spread-save anti-pattern (duplicates merge logic, error-prone)
const existing = await loadMachineConfig(vaultDir);
await saveMachineConfig(vaultDir, { ...existing, someField: newValue });

// After: canonical write path
await updateTierConfigRaw({ kind: 'machine', vaultDir }, (raw) => {
  raw.someField = newValue;
  return raw;
});
```

`updateTierConfigRaw` owns the read-modify-write cycle. Internally it relies on the `GROVE_TIER_FIELDS` constant (in `config/loader.ts`) as the shared definition of which fields belong at the grove tier — the same constant consumed by strip, retain, and lift operations so those three code paths can never independently drift.

### D4 — Shared extract handler and UI error string consolidation

**When:** Multiple API route handlers share the same validation + update logic, or UI components independently convert error values to strings.

**Config handler consolidation:** If two PUT handlers differ only in which config tier they write, extract the shared logic into a typed helper. The `handlePutTierConfig<TConfig>(body, options)` pattern in the config API is the canonical example — each endpoint delegates to the single function parameterized by tier kind:
```typescript
// Grove config PUT
return handlePutTierConfig<GroveConfig>(body, { kind: 'grove', groveId: req.groveId });
// Machine config PUT
return handlePutTierConfig<MachineConfig>(body, { kind: 'machine' });
```

**UI error string consolidation:** If components independently do `err instanceof Error ? err.message : String(err)` or equivalent, replace with the canonical `errorMessage(err)` helper. This function consolidates 12+ ad-hoc error-to-string patterns that existed across UI components. Any new UI code that converts a caught error to a string should use it rather than inlining the pattern again.

## Procedure E: Centralizing Service State Paths and Ownership Predicates

### E1 — Service state path properties

**When:** A filename (e.g., `"daemon.lock"`) is reconstructed via `path.join(dir, filename)` at 3+ locations, potentially with inconsistent join styles.

**Fix:** Add the path as a first-class property to the service state object, following the existing pattern:
```typescript
// Before: magic strings reconstructed in 3 places
const lockFile = path.join(daemonDir, "daemon.lock");

// After: centralized in DaemonServiceState (daemon/service-state.ts)
export interface DaemonServiceState {
  statePath: DaemonStatePath;  // already existed — the precedent
  lockPath: string;            // new property, same discipline
  // ...
}

// All call sites become:
const lockFile = daemonService.lockPath;
```

`DaemonServiceState` already owned `statePath`; `lockPath` follows the same precedent. Any service object managing multiple related files should expose all paths as properties — not reconstruct them at call sites.

**OS portability note:** `path.join` behavior differs across platforms. Centralizing the join ensures every consumer gets the same result regardless of OS.

### E2 — Canonical ownership predicates

**When:** The question "does this content/file belong to Myco?" is answered by different checks in different modules.

**Fix:**
1. Audit all checks across the codebase — do they agree on which content is Myco-owned? (They often don't. That's the bug.)
2. Consolidate into a single helper with a named constant for the match strings:
   ```typescript
   // symbionts/install-helpers.ts
   export const MYCO_LAUNCHER_SUBSTRINGS = [
     'myco-run.cjs',
     'myco-hook.cjs',
     'launcher.cjs',
   ];

   export function containsMycoLauncherReference(content: string): boolean {
     return MYCO_LAUNCHER_SUBSTRINGS.some(s => content.includes(s));
   }
   ```
3. Replace all divergent checks (`isMycoHookCommand`, both `isConfigured` branches, `uninstallPluginHookFile`) with calls to the single helper.

**Why canonical:** When the checks diverge, uninstall silently fails — one path skips a file it doesn't recognize as Myco-owned. This is the same bug class as Antigravity marker detection divergence. Ownership detection must be a single check, or the invariant is coincidentally satisfied rather than structurally enforced.

## Cross-Cutting Gotchas

**Violations fail silently, not loudly.** SSoT violations rarely throw. CI stays green. Divergence surfaces in production: a file isn't uninstalled, a Grove migrates to the wrong daemon, an agent sees a different field shape than the harness validates against. When you see unexpected runtime behavior that tests "should" cover, check for duplicate ownership logic before assuming a test gap.

**Verify all smell classes after any SSoT refactor.** Use this table as a checklist:

| Smell | Canonical fix | Canonical location |
|-------|---------------|--------------------:|
| Projection logic in 2+ consumers | Named projections module | `read-projections.ts` |
| Provider capability defaults in switch blocks | Named constants | `context-windows.ts` |
| Magic string literals scattered | Named constant | `constants.ts` |
| Strategy config inline at call sites | Named semantic wrappers | `config/loader.ts`, `settings-merge.ts` |
| Config write via load-spread-save | `updateTierConfigRaw()` + `GROVE_TIER_FIELDS` | `config/loader.ts` |
| Duplicated PUT handler validation logic | Typed extract helper (e.g. `handlePutTierConfig<T>`) | domain API module |
| Ad-hoc error-to-string in UI | `errorMessage()` canonical helper | UI lib module |
| File paths reconstructed at call sites | Service state path properties | `daemon/service-state.ts` |
| Parallel ownership predicates | Single canonical helper | `symbionts/install-helpers.ts` |
| Direct DB calls in tool files | Queries belong in the data access layer | domain query/read module |

**When you discover a new violation class:** don't only fix the instance — add it to this table. The skill grows with the codebase.
