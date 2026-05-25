---
name: building-myco-discipline
description: >-
  Use this skill when building any non-trivial change in Myco — new features,
  refactors, capability work, anything touching shared state, or anything
  that crosses module boundaries. It codifies how Myco is built and why:
  capability-first architecture for shared state, structural invariants
  rather than procedural ones, live smoke-testing rigor, detailed code
  review as a normal step, and the "what was this defending against?"
  audit that refactors must pass. Activate this skill even when the user
  just asks for "a small change" — the discipline is what keeps small
  changes from compounding into the bug classes that this codebase has
  fought through three migrations.
version: 1
user-invocable: true
---

# Building Myco the Myco Way

This skill is the operational codex for non-trivial work in Myco. It is the *how*; `AGENTS.md` is the *what* and *why*. Read both before starting work that touches more than one file.

## When to apply

- Any feature work that spans more than one module
- Any refactor (especially when the diff DELETES code that looks like cleanup)
- Any work touching paths in the [Capabilities table](../../../AGENTS.md#capabilities-single-writers-for-shared-state) — `daemon.json`, `<projectRoot>/.myco/`, `myco.yaml`, symbiont agent config
- Any work that adds a new entry point — HTTP handler, MCP tool, CLI command, intelligence task
- Any work that takes more than ~3 commits

Do NOT skip this skill because the change "feels small." The recurring bug class in this codebase is: a small change that looked clean compounded into a regression because a load-bearing invariant lived in convention, not in structure.

## Tenets

These are the lessons paid for in production bugs, code reviews, and review cycles.

### 1. Capability-first for shared state

If your change writes to a path or resource that *anything else* writes to, the first question is: **is there a capability that owns this?** Check [AGENTS.md's Capabilities table](../../../AGENTS.md#capabilities-single-writers-for-shared-state).

- **If yes:** route through it. Do not call the lower-level primitives.
- **If no but the resource is shared:** stop and design a capability before writing the second writer. *"I'll add a capability later when there's more than one caller"* is the bug pattern; the second writer is when the drift begins.

The cost of designing a capability up front is one extra session of design. The cost of duplicating discipline across N writers is months of recurring regressions — see `feat/grove-refactor`, the `global-symbiont-install` migration, and the `ProjectVault` refactor itself for receipts.

### 2. Invariants are structural, not procedural

A capability is not done when it compiles. It is done when there is **no callable sequence that can violate its invariants**.

- Invariants encoded as procedure (call A, then B, then C in this order) are fragile. An exception in B skips C. An empty input skips the loop. A future maintainer reorders the body.
- Encode invariants structurally:
  - Wrap per-state-class writes in a helper that runs the guard FIRST. Example: `ProjectVault._writePerMachineFile(fn)` runs `_ensureGitignore()` before invoking `fn`, so even if `fn` throws the gitignore is already on disk.
  - Compute responses from a FRESH read of the resource, not by piggy-backing on the last write's return. Example: `patchSymbiontOverrides({})` returns `loadConfig(vaultDir)` so an empty patch still surfaces the live state.
  - Validate inputs at the capability boundary BEFORE any disk I/O. Validation throws cleanly; partial state is impossible.

Test the invariants with **property-style tests**, not example-based ones. See `tests/vault/project-vault-invariants.test.ts` for the pattern: enumerate every public method, assert the full invariant set after each call. Property tests catch the "method forgot the pairing" bug class mechanically.

### 3. Refactors preserve externally observable contracts

When you refactor a function, you are claiming the externally observable behavior is unchanged. Verify the claim:

- For HTTP handlers: every (input → status code, error envelope code, response shape) tuple the old code honored MUST survive. Lock with contract-diff regression tests (see `tests/daemon/api/projects-symbiont-overrides.test.ts` — the block labeled "Contract-diff regression suite").
- For library functions: every (input → return shape, thrown exception type) tuple must survive.
- Happy-path tests catch zero of these regressions. Write the contract-diff tests BEFORE the refactor; they double as the migration checklist.

If you can't preserve a contract (rare — usually because the old code was wrong), surface it explicitly in the PR description. Do not change error codes, status codes, response shapes, or thrown exception types silently.

### 4. "What was this defending against?" — the refactor audit

Before deleting any try/catch, validation block, defensive null check, or seemingly-redundant guard, answer this question out loud: **what input, filesystem state, or upstream failure did this defend against, and where in the new code does the equivalent defense live?**

The mental model "fewer lines = better" produces regressions in this codebase because defensive code is almost always load-bearing, even when it looks like noise. The cost of one extra audit question per deleted defensive block is seconds. The cost of finding the missing defense in a code review three rounds later is hours of follow-up commits.

Concrete pattern that has bitten this codebase repeatedly: the old handler had `try { existing = loadX() } catch { existing = null }`. The refactor removed the try/catch as "cleanup." A corrupt input on disk now produces a 500 in a code path that used to recover gracefully. Always ask the question.

### 5. Live smoke testing is a quality gate, not an optimization

The test suite does not catch:
- Cross-process invariants (daemon-restart-and-rebind, file-handle races, signal handlers).
- Real-world envelope regressions (status codes from malformed inputs that no happy-path test exercises).
- Filesystem state at the boundary (gitignore present at the moment another file is written; symlink resolution; permission bits).

For any change that touches the capture pipeline, daemon lifecycle, vault state, or installed file layout, build the binary and run a sandbox smoke test before claiming the work is done. Smoke testing pattern:

```bash
SMOKE_DIR=$(mktemp -d /tmp/myco-smoke-XXXXXX)
mkdir -p "$SMOKE_DIR/home" "$SMOKE_DIR/launchagents" "$SMOKE_DIR/project"
cd "$SMOKE_DIR/project" && git init -q && echo test > README.md && git add . && \
  git -c user.email=t@t -c user.name=t commit -q -m init

MYCO_HOME="$SMOKE_DIR/home" \
MYCO_LAUNCH_AGENTS_DIR="$SMOKE_DIR/launchagents" \
MYCO_SERVICE_VARIANT=dev \
  /Users/chris/Repos/myco/packages/myco-darwin-arm64/bin/myco daemon > "$SMOKE_DIR/daemon.log" 2>&1 &
disown
sleep 4
# Exercise the new code path here.
```

The smoke check that caught the binding_id regression in the global-install work was a daemon-restart cycle — something no unit test could express. If your change touches state the daemon binds to on startup, the smoke is non-negotiable.

### 6. Detailed code review is a normal step, not exceptional

The `/code-review` slash command runs a 3-finder high-effort review (line-by-line, removed-behavior auditor, cross-file tracer). For any non-trivial PR, run it before claiming the work is done. Even on commits the author thinks are clean. Especially then.

- The high-effort mode is recall-biased. Expect 5-10 findings; most will be real. Triage each one: confirmed bug, plausible-with-explicit-decision-not-to-fix, or refuted-with-citation.
- Run it *again* after fixing the first round. The fixes themselves can introduce new regressions in the same family — the second-round review on the `ProjectVault` capability found 9 bugs in the refactor that was meant to close 10 bugs.
- The review is not a courtesy. It is the quality gate.

### 7. Test taxonomy — pick the right tool for the failure mode

| Bug class | Test that catches it |
|---|---|
| Logic errors, off-by-one, wrong condition | Unit tests on the function |
| Multi-file coordination bugs (gitignore missing, binding_id orphaned) | Property tests on the capability's invariants |
| API envelope regressions (status code, error code, response shape changes) | Contract-diff regression tests (per-endpoint tuple list) |
| Cross-process state (daemon restart, file handle races, signal handlers) | Live smoke testing |
| Mock-leak fragility (test mocks omit a new export) | Defensive mock sweeps — every `mock.module('.../lib/api'` mock must expose every export the test's render tree might touch |
| Removed defensive code masking real failure modes | "What was this defending against?" audit during review |

Happy-path tests catch the first row. They catch zero of the rest. Plan test coverage in that taxonomy before writing the implementation.

### 8. Worktrees for non-trivial work

For any change spanning more than ~3 commits or touching critical paths (capture, daemon, vault, install), work in a git worktree. See [`myco:feature-branch-worktree-squash-merge-delivery`](../feature-branch-worktree-squash-merge-delivery/SKILL.md). Worktrees keep main clean while you iterate and force a deliberate squash-merge step that produces a reviewable PR history.

## Golden paths

### Adding a new HTTP endpoint that writes shared state

1. Identify the resource. Is it in the [Capabilities table](../../../AGENTS.md#capabilities-single-writers-for-shared-state)?
   - **Yes:** route through that capability. Handler does input validation + envelope mapping only.
   - **No:** stop. Design the capability first. The endpoint is the second writer that motivates the capability.
2. Write contract-diff tests BEFORE the handler. Enumerate every input the endpoint accepts (good and bad) and the expected (status, error code, response shape).
3. Write the handler. Catch every typed error from the capability and map to the right envelope.
4. Add a property-style invariant test if the capability's surface changed.
5. Run `/code-review` at `high` effort.
6. Live-smoke the endpoint against a sandbox daemon.

### Refactoring a function

1. Read the function and list every defensive block (try/catch, validation, null check). For each, write down what input it defended against.
2. Identify the externally observable contract: every (input → result/exception) tuple callers may depend on.
3. Write contract-diff regression tests for that surface. They are the migration checklist.
4. Refactor.
5. Run `/code-review` at `high` effort — specifically asking the removed-behavior finder *"for every deleted defensive block, where is the equivalent defense in the new code?"*

### Adding a new shared file under `.myco/` or `~/.myco/`

1. Decide: is this state per-project, per-Grove, or per-machine? See the three-tier scoped config doc.
2. Identify the owning capability. If there isn't one, design it BEFORE the second writer exists.
3. Update [AGENTS.md's Capabilities table](../../../AGENTS.md#capabilities-single-writers-for-shared-state) to reflect the new resource and its capability.
4. Add the path to `VAULT_GITIGNORE` (in `packages/myco/src/vault/gitignore.ts`) if it's per-machine and gitignored.
5. Add a property-style invariant: *after every public method on the capability, the new file is in the expected state*.

## Anti-patterns this skill prevents

- **The second writer.** Two callsites both writing the same shared file by hand. The convention diverges; the file's invariant breaks; the bug surfaces in production. *Fix:* design the capability before the second writer lands.
- **Cleanup-by-deletion.** Removing a try/catch, validation block, or null check because it "looked like dead code." The defense was load-bearing. *Fix:* the "what was this defending against?" audit.
- **Procedure-as-invariant.** Encoding `do A then B then ensure X` in the method body. An exception in B skips X. *Fix:* wrap the per-state writer in a helper that runs the guard first.
- **Last-write piggy-back response.** Returning `lastResult.field ?? defaultValue` instead of `freshRead().field`. Empty input collapses to default; on-disk state diverges from response. *Fix:* compute responses from a fresh read.
- **Happy-path-only test coverage.** Tests verify "method X succeeds." No test verifies "method X never violates invariant Y." *Fix:* property-style tests of the invariant set.
- **Skip the live smoke.** "The unit tests pass; we're good." Cross-process invariants never had unit coverage. *Fix:* sandbox smoke for any change touching daemon lifecycle, vault state, or installed layout.

## References

- [`AGENTS.md`](../../../AGENTS.md) — durable invariants and the Capabilities table.
- [`myco:feature-branch-worktree-squash-merge-delivery`](../feature-branch-worktree-squash-merge-delivery/SKILL.md) — delivery mechanism for non-trivial work.
- [`myco:safe-config-updates`](../safe-config-updates/SKILL.md) — applying the capability pattern to a specific resource (myco.yaml).
- [`myco:debug-capture`](../debug-capture/SKILL.md) — the cross-layer lifecycle walk that smoke testing complements.
- `tests/vault/project-vault-invariants.test.ts` — exemplar property-style invariant suite.
- `tests/daemon/api/projects-symbiont-overrides.test.ts` — exemplar contract-diff regression suite (search for "Contract-diff regression suite").
