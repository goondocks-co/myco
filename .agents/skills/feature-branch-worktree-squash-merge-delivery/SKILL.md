---
name: myco:feature-branch-worktree-squash-merge-delivery
description: Use this skill when delivering a non-trivial Myco feature that spans multiple files and requires clean commit history in a PR. Activates whenever you need to use git worktrees for isolated implementation, run the /simplify quality pass (with full procedure: duplication extraction, dispatch table replacement, function signature simplification, React prop threading), use `make build` as the full quality gate, or squash all worktree commits into a single clean PR commit. Keywords: git worktree, feature branch, feature/my-feature-name, squash merge, make build, /simplify, clean commit history.
managed_by: myco
version: 1
user-invocable: true
allowed-tools: [Bash]
---

# Feature Branch Worktree Squash-Merge Delivery

Use this skill when delivering a non-trivial Myco feature that spans multiple files and requires clean commit history in a PR. This is the standard delivery mechanism for all non-trivial Myco features.

## When to Apply

- Delivering a new feature that spans multiple files
- Implementing any non-trivial change that requires a clean PR commit
- Working on a named feature branch (`feature/my-feature-name` convention)
- Whenever you need to isolate implementation from the main branch during development

## Procedure

### Step 1: Design on `main`

Write the design spec in `docs/superpowers/specs/` while on the main branch. Commit only the spec, not implementation.

```bash
docs/superpowers/specs/2026-04-13-my-feature-design.md
git add docs/superpowers/specs/
git commit -m "docs: add design spec for my-feature"
```

Note: `docs/superpowers/specs/` is gitignored for external contributors but tracked locally.

### Step 2: Create a git worktree

```bash
git worktree add ../myco-feature-X feature/my-feature-name
cd ../myco-feature-X
```

**Critical**: use a sibling directory (e.g., `../myco-feature-X`), **not a subdirectory inside the repo**. Nested worktrees confuse Myco's CWD detection and create phantom sessions.

### Step 3: Implement with incremental commits

Commit regularly in the worktree. Don't worry about commit message quality — these will be squashed. Keep `.myco/` and `VAULT_GITIGNORE`-tracked files out of commits.

### Step 4: Run the `/simplify` Quality Pass

After implementation, run a structured quality review targeting four classes of technical debt that accumulate during fast feature work. This pass must complete **before** the squash — simplification changes belong in the final commit, not a follow-up PR.

**Sequence constraint**: make a simplify commit in the worktree — it will be squashed into the single feature commit at delivery.

#### 4a. Identify and Extract Duplication

```bash
git diff --name-only main          # files changed in this branch
grep -rn "\.slice(0, 8)" src/      # shortSession() candidates
grep -rn "new Date().toLocaleString" src/  # date formatter candidates
```

Any logic appearing 2+ times across changed files is a candidate for extraction. Shared helpers go in `src/lib/`. **Read `src/lib/format.ts` before adding anything** — re-extracting an existing helper creates a naming conflict and a second source of truth.

```typescript
// Before: inline in two components
const display = sessionId.slice(0, 8) + '...';
// After: import from src/lib/format.ts
import { shortSession } from '../lib/format';
const display = shortSession(sessionId);
```

#### 4b. Replace If-Ladders with Dispatch Tables (3+ cases only)

```typescript
// Before: growing if-else chain
if (type === 'session_start') { handleSessionStart(payload); }
else if (type === 'spore_created') { handleSpore(payload); }
else { log.warn('unknown type', type); }

// After: dispatch table — new types are one-line additions
const handlers: Record<string, (p: Payload) => void> = {
  session_start: handleSessionStart,
  spore_created: handleSpore,
};
const handler = handlers[type];
if (handler) handler(payload);
else log.warn('unknown type', type);
```

Only apply when there are **3+ cases** or the list is clearly growing. A 2-entry dispatch table is often less readable than a plain if/else.

#### 4c. Simplify Function Signatures (4+ parameters)

Functions with 4+ parameters where 2+ are always passed together → group into a context object:

```typescript
// Before: 5 loose parameters
function emitNotification(sessionId, type, payload, machineId, timestamp)

// After: stable params grouped into a context object
interface NotificationCtx { sessionId: string; machineId: string; timestamp: number; }
function emitNotification(ctx: NotificationCtx, type: string, payload: object)
```

The daemon layer (`src/daemon/`) and CLI handlers (`src/cli/`) accumulate parameter debt the fastest.

#### 4d. Check React Prop Threading (3+ component layers)

If a value passes through 3+ React component layers without being used by intermediate layers, use `React.createContext` or restructure the component tree:

```tsx
// Red flag: sessionId passes A → B → C but B never uses it
<SessionPage sessionId={id}>
  <SessionContainer sessionId={id}>  {/* passes through, never reads */}
    <SessionCard sessionId={id} />   {/* actual consumer */}
  </SessionContainer>
</SessionPage>
```

Check `src/ui/` after any feature that adds new data to page-level views.

#### 4e. Verify Zero Regressions

Run TypeScript **before** tests — TypeScript catches renamed/refactored signature mismatches before you waste time debugging misleading test failures:

```bash
npx tsc --noEmit
npm test
```

Both must be clean before committing.

#### 4f. Commit the simplify pass

```bash
git add -A
git commit -m "refactor: /simplify pass — <feature-name>"
```

This commit will be squashed into the feature commit in Step 6.

### Step 5: Run `make build`

```bash
make build
```

This executes `tsc` + `vitest` + `tsup` + `vite` in sequence. **Do NOT use `npm run build`** — it runs only the bundler, silently skipping type checks and tests. `make build` is the gate before squash. Never proceed until it passes cleanly.

### Step 6: Squash all commits, delete worktree, push

Run from inside the worktree directory (`../myco-feature-X`):

```bash
# Squash all implementation + simplify commits into one
git reset --soft $(git merge-base HEAD main)
git commit -m "feat: <single clear description of the feature>"

# Delete the worktree before pushing
git worktree remove ../myco-feature-X

# Push the feature branch
git push origin feature/my-feature-name
```

The single squashed commit becomes the PR commit.

## Key Gotchas

- **`npm run build` silently ships broken packages** — only `make build` runs the full `tsc` + `vitest` + `tsup` + `vite` chain
- **Sibling directory, not subdirectory** — always use `../myco-feature-X`; nested worktrees cause CWD detection misattribution
- **`/simplify` before squash, not after** — simplification belongs in the final squashed commit, not a follow-up cleanup PR
- **Delete the worktree before pushing** — `git worktree remove` must precede `git push`; lingering worktrees confuse subsequent Claude Code sessions
- **Design spec on `main` first** — commit the spec in `docs/superpowers/specs/` before switching to the worktree
- **Run `npm rebuild` after branch switches involving native modules** — if the dependency tree includes native Node addons (e.g., `better-sqlite3`), switching between branches requires `npm rebuild` before running tests or the daemon; failures manifest as cryptic runtime errors, not build errors
- **Stage untracked files before `/simplify` or code review** — Claude Code's review tools only see git-tracked files; new files that haven't been `git add`-ed are invisible; run `git add -N .` (intent-to-add) before any review pass
- **Read `src/lib/format.ts` before extracting helpers** — re-extracting an existing helper creates a naming conflict during the simplify pass
