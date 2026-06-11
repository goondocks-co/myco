---
name: myco:feature-branch-worktree-squash-merge-delivery
description: >-
  Use this skill when delivering a non-trivial Myco feature that spans
  multiple files and needs clean PR history. It applies whenever you need
  git worktrees for isolated implementation, the `/simplify` quality pass,
  `make build` as the full quality gate, or a single clean squash-merge
  commit for the final PR.
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
- Working on a named feature branch (`feature/branch-name` convention)
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
git worktree add ../myco-branch-name feature/branch-name
cd ../myco-branch-name
```

**Critical**: use a sibling directory (e.g., `../myco-branch-name`), **not a subdirectory inside the repo**. Nested worktrees confuse Myco's CWD detection and create phantom sessions.

### Step 2b: Pin the worktree to its dev binary

```bash
make dev-link-worktree
```

This writes a `.myco/runtime.command` file that pins this worktree to the freshly-built local binary (not the shared `~/.local/bin/myco-dev` symlink). All hooks, MCP calls, and CLI invocations in this worktree then dispatch to the worktree build. The file is gitignored, so it's never committed. When you're done (Step 6), run `make dev-unlink-worktree` to remove the pin.

Skip this step ONLY when you deliberately want the worktree to fall back to the global binary.

**Isolation caveat — schema migrations**: Do NOT use `make dev-link-worktree` when the feature branch carries a schema migration that the shared `~/.myco` vault hasn't seen yet. Running the worktree binary against the shared vault will migrate it in place, breaking the main branch. For isolated programmatic testing in schema-migration scenarios, use a temp git repo with a separate `MYCO_HOME`:

```bash
export MYCO_HOME=$(mktemp -d)   # scratch vault — migrated fresh, main vault untouched
./dist/myco-daemon &
# run your tests here
unset MYCO_HOME
```

**Vendor asset caveat**: Native vendor assets are not automatically rebuilt in new worktrees. If the daemon or tests fail with native module errors after creating a worktree, run `npm rebuild` to force recompilation before proceeding.

**Safe dogfood sequence**: (1) develop and commit on the worktree; (2) run isolated tests with a temp `MYCO_HOME` if the branch has schema changes; (3) switch to the root checkout for live daemon dogfood once the migration is confirmed safe.

### Step 3: Implement with incremental commits

Commit regularly in the worktree. Don't worry about commit message quality — these will be squashed. Keep `.myco/` and `VAULT_GITIGNORE`-tracked files out of commits.

### Step 4: Run the `/simplify` Quality Pass

After implementation, run a structured quality review targeting four classes of technical debt that accumulate during fast feature work. This pass must complete **before** the squash — simplification changes belong in the final commit, not a follow-up PR.

**Sequence constraint**: make a simplify commit in the worktree — it will be squashed into the single feature commit at delivery.

#### 4a. Identify and Extract Duplication

```bash
git diff --name-only main          # files changed in this branch
grep -rn "\.slice(0, 8)" packages/ # session ID truncation patterns
grep -rn "new Date().toLocaleString" packages/ # date formatter candidates
```

Any logic appearing 2+ times across changed files is a candidate for extraction. Shared helpers go in `packages/myco/src/utils/` or the appropriate utility module within the relevant package. **Check existing utility modules before adding anything** — re-extracting an existing helper creates a naming conflict and a second source of truth.

```typescript
// Before: inline in two components
const display = sessionId.slice(0, 8) + '...';
// After: import from utility module
import { shortSession } from '../utils';
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

The daemon layer (`packages/myco/src/daemon/`) and CLI handlers (`packages/myco/src/cli/`) accumulate parameter debt the fastest.

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

Check React components in the UI package after any feature that adds new data to page-level views.

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

This runs lint + fast unit tests + bundler (`tsc` + `vitest` fast profile + `tsup` + `vite`). Integration, smoke, and daemon tests are excluded from the default profile — they run in CI on every PR. **Do NOT use `npm run build`** — it runs only the bundler, silently skipping type checks and tests. For pre-release confidence when tagging a release, use `make build-all` instead. `make build` is the standard gate before squash. Never proceed until it passes cleanly.

### Step 6: Squash all commits, delete worktree, push

Run from inside the worktree directory (`../myco-branch-name`):

```bash
# Squash all implementation + simplify commits into one
git reset --soft $(git merge-base HEAD main)
git commit -m "feat: <single clear description of the feature>"

# Remove the dev binary pin
make dev-unlink-worktree

# Delete the worktree before pushing
git worktree remove ../myco-branch-name

# Push the feature branch
git push origin feature/branch-name
```

The single squashed commit becomes the PR commit.

## Key Gotchas

### Core Worktree Hazards

- **Native modules fail to build inside worktrees** — packages with native dependencies (sqlite-vec, better-sqlite3) cannot compile inside git worktrees. All test failures trace to native module build errors, not code issues. Use `npm rebuild` after creating worktrees to force recompilation.

- **Nested UI workspace installs required** — new worktrees need `npm install` inside each `packages/*/ui` directory. The root install doesn't cover nested UI workspaces. Run manually after worktree creation to prevent build failures in UI components.

- **Daemon segfault on worktree activation** — activating a worktree while the daemon is running can cause segmentation faults. Stop the daemon before creating or switching worktrees: `pkill -f "myco-daemon"` then restart after worktree setup.

- **Wrong daemon takeover** — worktrees can spawn duplicate daemon processes that compete for the same vault. Check for phantom processes with `ps aux | grep myco` before starting work in a worktree.

- **Config path contamination** — worktree-local paths can leak into shared config files, breaking subsequent sessions. Avoid absolute path references in temporary configs; use relative paths or environment variables.

- **Branch activation failures** — switching branches within an active worktree confuses git state. Always `git checkout` to the intended branch immediately after worktree creation, before any commits.

- **Resource cleanup incomplete** — interrupted worktree operations leave stale references. Use `git worktree prune` periodically to clean orphaned worktree entries.

### Binary and Path Safety

- **Hardcoded binary names leak between scopes** — build scripts that reference fixed binary names (e.g., `myco-daemon`) break when multiple worktrees exist. Use dynamic scope dispatch to isolate binary instances.

- **Absolute path leaks** — worktree-specific absolute paths contaminate shared configuration. Always use relative paths or project-root-relative references in config files.

- **Build artifact scope collision** — multiple worktrees can overwrite each other's build outputs. Ensure build directories are worktree-scoped or use unique naming.

### CLI and Configuration Compatibility

- **CLI subcommand help regression prevention** — when adding new CLI commands or modifying existing ones, ensure help text remains accessible and accurate. Test `myco <command> --help` patterns after CLI changes.

- **Config tier migration safety** — features that modify configuration must be compatible with Myco's three-tier config system (machine/grove/project/personal). Test config changes across all scope levels during worktree development.

- **Cross-worktree config isolation** — configuration changes made in a worktree should not affect the main development environment or other concurrent worktrees. Use environment variables or temporary config files when needed.

### Standard Quality and Build Gotchas

- **`npm run build` silently ships broken packages** — only `make build` runs lint + fast unit tests + `tsc` + `tsup` + `vite`; for the full test sweep including integration/smoke, use `make build-all`
- **Sibling directory, not subdirectory** — always use `../myco-branch-name`; nested worktrees cause CWD detection misattribution
- **`/simplify` before squash, not after** — simplification belongs in the final squashed commit, not a follow-up cleanup PR
- **Delete the worktree before pushing** — `git worktree remove` must precede `git push`; lingering worktrees confuse subsequent Claude Code sessions
- **Design spec on `main` first** — commit the spec in `docs/superpowers/specs/` before switching to the worktree
- **Run `npm rebuild` after branch switches involving native modules** — if the dependency tree includes native Node addons (e.g., `better-sqlite3`), switching between branches requires `npm rebuild` before running tests or the daemon; failures manifest as cryptic runtime errors, not build errors
- **Stage untracked files before `/simplify` or code review** — Claude Code's review tools only see git-tracked files; new files that haven't been `git add`-ed are invisible; run `git add -N .` (intent-to-add) before any review pass
- **Check existing utility modules before extracting helpers** — re-extracting an existing helper creates a naming conflict during the simplify pass
