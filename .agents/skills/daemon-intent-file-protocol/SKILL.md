---
name: myco:daemon-intent-file-protocol
description: |
  Apply this skill when writing, modifying, or reviewing any code that touches
  Myco's intent-file-mediated daemon communication protocol — even if the user
  doesn't explicitly ask about correctness. The protocol (write intent file →
  reconciler reads → acts) has four documented failure modes: (1) concurrent
  writers silently dropping each other's intent via shared-file merge logic,
  (2) intent cleared before the async action it triggers is confirmed complete,
  (3) intent written but never consumed when the daemon is in deep_sleep state
  (SELF_RECONCILE excludes deep_sleep), and (4) reconciler re-entrancy where a
  handler raises a new intent for the very action the reconciler is executing,
  producing a perpetual no-op loop. Covers diagnosis, fix patterns, and required
  test coverage for all four gaps.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Daemon Intent File Protocol — Four Correctness Gaps

Myco's daemon uses an intent-file protocol for inter-process communication: a CLI or background job writes a TOML file signaling desired state; the SELF_RECONCILE job picks it up and acts. The protocol sounds simple but has four seams where failures are **silent** — the daemon appears healthy while actually doing nothing or doing the wrong thing. These four gaps were discovered across sessions cfde2eeb (v0.27.11/v0.27.12) and 81767ff4 (PR #355).

## Prerequisites

- SELF_RECONCILE runs in `['active', 'idle', 'sleep']` — **`deep_sleep` is explicitly excluded**. This shapes Gaps 3 and 4.
- Current intent file paths are type-specific (post-split architecture): `intent.restart.toml` and `intent.update.toml`. The old shared `intent.toml` no longer exists.
- Key files:
  - `packages/myco/src/daemon/update-installer.ts` — update intent authoring and `spawnUpdateScript`
  - `packages/myco/src/cli/restart.ts` — restart path (CLI command)
  - `packages/myco/src/daemon/self-reconcile.ts` — intent consumer, handler dispatch, and `skipIntent` usage
  - `packages/myco/src/daemon/intent.ts` — intent file constants and type definitions

---

## Gap 1 — Concurrent Writers Silently Drop Each Other's Intent

**Category:** Write race — shared file + merge logic → last-writer-wins.

When a single `intent.toml` was shared across all intent types, `mergeIntent()` performed a read-modify-write cycle:

1. Read the shared file
2. Merge in the new intent section
3. Write the file back

When a CLI `myco restart` and the SELF_RECONCILE background job overlapped, the last writer silently discarded the other's section. No error was raised; one action simply never happened.

### Fix pattern: type-specific files, no merge

Each intent type owns exactly one file. Writers create atomically; the reconciler reads each file independently:

```
intent.restart.toml   ← owned by the restart path only
intent.update.toml    ← owned by update-installer only
```

Because files are type-specific, no merge is ever needed. `mergeIntent()` was removed entirely — if you see it re-introduced, that is a regression.

**Rule:** If you add a new intent type, create a new type-specific file. Never return to a shared file with merge logic.

### Detection

```bash
# Any write target named intent.toml (without a type suffix) is the bug
grep -r "mergeIntent\|['\"]intent\.toml['\"]" packages/myco/src/daemon/
```

### Test coverage required

Concurrent writers: two processes writing different intent sections simultaneously must both survive independently after the writes complete.

---

## Gap 2 — Intent Cleared Before Async Action Confirms Success

**Category:** Write ordering — intent wiped before the action it triggers is confirmed complete.

`installUpdate` in `packages/myco/src/daemon/update-installer.ts` promised in its docstring: *"retain intent on failure so next tick retries."* The implementation violated this in two ways:

1. **Fire-and-forget spawn:** `spawnUpdateScript()` forked the install shell and returned immediately — there was no way to observe success or failure.
2. **Premature clear:** The intent file was wiped *before* the spawned process finished. On failure, nothing remained for the next reconciler tick to retry.

The daemon appeared to attempt the update on every reconcile cycle but never completed it and left no trace of failure.

### Fix pattern: confirm-before-clear with error persistence

```
install script succeeds → clear intent file
install script fails   → write update-error.json → do NOT clear intent
```

`installUpdate` (via `self-reconcile.ts`) now checks for `~/.myco/update-error.json` on the next invocation:
- **Present:** surface the structured error and halt — do not silently retry a broken binary.
- **Absent, intent present:** normal retry semantics apply.
- Intent is only cleared after the update script explicitly confirms success.

**Rule:** Never clear an intent file before the action it triggered has confirmed completion. If the action is async (spawned process, background job), you must observe its outcome before cleanup.

### Detection

Review any code path that:

1. Writes an intent file
2. Spawns or defers the action asynchronously
3. Clears the intent file **without** awaiting or observing the spawned action's result

That sequence is always wrong regardless of how unlikely concurrent failure seems.

---

## Gap 3 — Intent Written But Never Consumed in `deep_sleep` State

**Category:** State machine gap — the reconciler consumer is excluded from one daemon power state.

`myco restart` used the full intent-file path:

1. Write `intent.restart.toml`
2. Wait for SELF_RECONCILE to consume it
3. Poll `/health` for a new PID

SELF_RECONCILE is configured with `runIn: ['active', 'idle', 'sleep']`. When the daemon was in `deep_sleep`, SELF_RECONCILE never ran. The intent file sat unread indefinitely. After 15 seconds the CLI printed:

> *"Reconciler did not converge within 15s."*

The daemon stayed in `deep_sleep`, nothing restarted, and the user got a timeout with no actionable error.

### Fix pattern: direct API call primary, intent file as fallback

**File:** `packages/myco/src/cli/restart.ts`

```
1. POST /api/restart  (same handler as the UI button — works in all power states)
2. On HTTP error (daemon unreachable) → fall back to intent file path
```

Result: **2.66 s restart** in the happy path versus the prior 15 s timeout.

**Rule:** The intent-file path is a fallback for when the daemon is unreachable, not the primary channel. Any CLI command that needs to work across all power states must POST directly to the daemon API first.

### Checking which states matter

Before writing code that depends on SELF_RECONCILE consuming an intent, confirm `deep_sleep` is included:

```bash
grep -r "runIn\|SELF_RECONCILE" packages/myco/src/daemon/self-reconcile.ts
```

If `deep_sleep` is absent, the intent will not be consumed in that state.

### Test coverage required

Tests for intent consumption must explicitly exercise all daemon power states, including `deep_sleep`. A test that only covers `active` or `idle` does not catch this gap.

---

## Gap 4 — Reconciler Re-Entrancy: Handler Raises Intent for Its Own Action

**Category:** Reconciler re-entrancy — a handler called from the reconciler raises a new intent for the action it is already executing, creating a perpetual no-op loop.

**Files:** `packages/myco/src/daemon/self-reconcile.ts`, `packages/myco/src/grove/launcher-install.ts` (`installGlobalLaunchers`)
**Commit:** `56b5bc9a` | **PR:** #355 (global-symbiont-install)

**Symptom:** Launchers were never written on first-start. Every hook fire raised ENOENT because `~/.myco/launchers/*.cjs` did not exist, making all symbiont integrations non-functional.

**The loop:**

1. Daemon-bound `installGlobalLaunchers` raises a `refresh-launchers` intent
2. Reconciler observes the intent → calls `installGlobalLaunchers()`
3. The same code path raises **another** `refresh-launchers` intent
4. Cycle repeats every 90 s — launchers are never actually written to disk

This was a publication blocker: launchers are essential for symbiont hook invocation.

### Fix pattern: `skipIntent` flag in reconciler context

The reconciler passes `skipIntent: true` when calling any intent-raising function during reconciliation:

```ts
// Before — perpetual loop
// reconciler observes intent
//   → calls installGlobalLaunchers()
//     → intent raised again
//       → loop (every 90 s, no launchers written)

// After — direct write
// reconciler passes skipIntent: true
//   → installGlobalLaunchers() skips intent-raise
//     → writes launchers directly to disk
```

From `packages/myco/src/daemon/self-reconcile.ts`:
```ts
// skipIntent: true forces the actual write — otherwise the
// default daemon-bound `installGlobalLaunchers` would observe
// the intent and re-raise it indefinitely
const refresh = deps.refreshLaunchers ?? (() => installGlobalLaunchers(undefined, { skipIntent: true }));
```

**Rule:** Any function that can be called both directly (where raising intent is correct) and from reconciler context (where acting directly is correct) **must** accept a `skipIntent` flag. The reconciler must always pass `skipIntent: true` to prevent re-entrancy.

### Detection

If a reconciler handler calls a function that also raises an intent observable by the same reconciler, you have a potential loop:

```bash
grep -r "skipIntent\|refresh-launchers" packages/myco/src/daemon/self-reconcile.ts
```

Any intent-raising call inside a reconciler handler that lacks `skipIntent: true` is suspect.

### Test coverage required

- `tests/grove/launcher-install.test.ts` — "installGlobalLaunchers — daemon-bound intent bypass" (2 tests)
- `tests/symbionts/installer-integration.test.ts` — "write ordering: launchers exist before any agent hook config"

Any handler added to the reconciler that also raises intents needs a companion test verifying that `skipIntent: true` produces a direct write and no new intent.

---

## Cross-Cutting Gotchas

### All four failures are silent

None of these gaps raise an error at the point of failure. The daemon appears healthy; the operation either silently no-ops, enters an infinite loop that looks like activity, or times out with a generic convergence message. Always test the **outcome** (file written to disk, PID changed, launcher present), not just the absence of errors.

### Intent files are not a general-purpose IPC mechanism

The protocol was designed for low-frequency, non-overlapping intents. It breaks under:

- Concurrent writers (Gap 1)
- Async actions with unknown completion time (Gap 2)
- Consumers that do not run in all power states (Gap 3)
- Recursive call chains originating inside the reconciler (Gap 4)

For synchronous-completion-required operations or anything that must work in `deep_sleep`, use the HTTP API directly.

### The four-gap taxonomy

| Gap | Category | Root Cause | Fix Pattern |
|-----|----------|------------|-------------|
| 1 | **Write race** | Shared file + merge → last-writer-wins | Type-specific files, no merge |
| 2 | **Write ordering** | Intent cleared before action confirms | Persist intent until confirmation |
| 3 | **State machine gap** | Consumer excluded from `deep_sleep` | Direct API call primary; intent as fallback |
| 4 | **Reconciler re-entrancy** | Handler raises intent it is already executing | `skipIntent: true` in reconciler context |

### Required test matrix for any intent file change

1. **Concurrent writers** — two intent types written simultaneously; both sections must survive independently.
2. **Failed action** — intent must persist; structured error must be captured (e.g., `update-error.json`).
3. **All daemon power states including `deep_sleep`** — consumer must receive the intent or a documented fallback path must exist.
4. **Reconciler-context invocation** — verify `skipIntent: true` causes direct write with no new intent raised.
