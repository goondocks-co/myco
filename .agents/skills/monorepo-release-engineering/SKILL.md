---
name: myco:monorepo-release-engineering
description: |
  Use this skill when working on Myco's multi-package npm workspace structure,
  per-package CI release pipelines, or any task touching package publishing,
  version management, or release tag workflows across `packages/myco`,
  `packages/myco-team`, and `packages/myco-collective`.
  Covers six procedures: (1) bootstrapping the monorepo workspace,
  (2) configuring per-package OIDC publish workflows with tag-prefix triggers,
  (3) auditing and hardening test version assertions to avoid silent drift,
  (4) diagnosing and fixing silent tag-publish failures caused by `[skip ci]`
  commit messages, (5) applying the worktree delivery gate safely for
  multi-package experimental work, and (6) managing dependencies with
  Dependabot batching workflows. Also covers Node binary PATH resolution in
  Wrangler sub-shell spawns. Apply this skill even if the user don't explicitly
  ask for "monorepo" or "release engineering" — it applies any time you're
  working with package publishing, CI workflows, or dependency updates.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Multi-Package Monorepo and Release Engineering

Myco is structured as a three-package npm workspace: `packages/myco` (the core
CLI/daemon), `packages/myco-team` (team sync), and `packages/myco-collective`
(org-level knowledge and cross-project features). Each package is independently
publishable with its own CLI, version, and CI release trigger. The monorepo
split is **Collective V1 milestone zero** — no cross-package feature work begins
until the workspace is properly structured.

This skill covers the full release engineering domain: initial workspace setup,
per-package publishing pipelines, test hardening against version drift, and the
operational pitfalls that will silently break releases if you don't know them.

## Prerequisites

- Node 22 (bundled npm 10.x — supports OIDC natively, no upgrade needed)
- Each package has its own `package.json` with a unique `name` field
- Root `package.json` defines the `workspaces` array
- You are working on a feature branch, not directly on `main`

## Procedure 1: Bootstrap the Monorepo Workspace

**When:** Adding a new package to the workspace, or converting the repo from a
single-package layout to a monorepo.

### 1.1 — Root workspace manifest

In the root `package.json`, declare all packages:

```json
{
  "workspaces": [
    "packages/myco",
    "packages/myco-team",
    "packages/myco-collective"
  ]
}
```

Run `npm install` from the root to link all workspace packages. Each package is
then available for cross-package `require()` without publishing.

### 1.2 — Per-package manifests

Each package needs a self-contained `package.json`:

```json
{
  "name": "@goondocks/myco-collective",
  "version": "0.1.0",
  "main": "dist/index.js",
  "bin": {
    "myco-collective": "dist/cli.js"
  }
}
```

> **Naming convention:** The published package name (e.g., `@goondocks/myco-collective`)
> is the npm identity. The release tag prefix (e.g., `collective/v0.1.0`) is the
> CI trigger. They are separate namespaces — keep them consistent but understand
> they are distinct concepts.

### 1.3 — Build and test isolation

Each package must build independently:

```bash
# Build only myco-collective
npm run build --workspace=packages/myco-collective

# Test only myco-collective
npm run test --workspace=packages/myco-collective

# Build all packages
npm run build --workspaces
```

Verify that no package's build depends on another package's `dist/` output.
Cross-package dependencies within the workspace are resolved via the workspace
symlink, not via built artifacts.

## Procedure 2: Configure Per-Package CI Release Pipelines

**When:** Setting up or modifying CI publish workflows for any package.

### 2.1 — Tag-prefix trigger convention

Each package uses a distinct tag prefix to trigger its own publish workflow:

| Package | Tag format | Example |
|---|---|---|
| `packages/myco` | `myco/vX.Y.Z` | `myco/v0.15.0` |
| `packages/myco-team` | `myco-team/vX.Y.Z` | `myco-team/v0.3.0` |
| `packages/myco-collective` | `collective/vX.Y.Z` | `collective/v0.1.0` |

### 2.2 — Current state: Manual publishing

**Currently:** Myco releases are published manually using npm CLI. Automated GitHub Actions publish workflows are planned but not yet implemented.

Node 22's bundled npm 10.x supports OIDC natively. **Never run `npm install -g npm@latest` in CI** — it replaces npm's own dependencies and corrupts them, silently breaking the OIDC publish step with a cryptic auth error.

When automated publishing is implemented, ensure:
- `permissions: { id-token: write }` for OIDC provenance
- `npm publish --provenance --access public` for secure publishing
- No global npm upgrades that corrupt OIDC dependencies

### 2.3 — Manual tagging and publishing

**The tag is authoritative.** Current manual release process:

**Manual bump and publish:**
```bash
# Edit package.json + packages/myco/package.json + packages/myco/ui/package.json
# (Hand-edit the "version" field from 0.21.2 → 0.22.0, etc.)
npm install --package-lock-only --ignore-scripts   # refresh the lock
git add package.json packages/myco/package.json packages/myco/ui/package.json package-lock.json
git commit -m "chore(release): bump to v0.22.0"
git push origin main
git tag myco/v0.22.0
git push origin myco/v0.22.0

# Manual publish to npm
cd packages/myco
npm publish --access public
cd ../..
```

**Tag-only (prefer for betas):**
```bash
# No package.json edits — handle manually or via automation
git tag myco/v0.22.0-beta.5
git push origin myco/v0.22.0-beta.5

# Manual publish to npm
cd packages/myco
npm publish --tag beta --access public
cd ../..
```

> **Commit message:** use a semantic form that describes what the commit
> actually does (e.g., `chore(release): bump to v0.22.0`), not a terse
> marker like `Cut 0.22.0`. Historical commits use the terse form; future
> release-bump commits should read as change descriptions — the git log
> needs to be legible without side context about the release cadence.

### 2.4 — Nested non-workspace packages

For packages that exist within the monorepo but are NOT part of the workspace
(e.g., Cloudflare Workers co-located within package directories at `packages/myco-team/worker` and `packages/myco-collective/worker`), configure separate CI triggers:

These packages maintain independent `package.json` files but don't participate
in the root workspace linking. They require explicit `npm install` in their
own directory during CI.

## Procedure 3: Harden Tests Against Version Drift

**When:** Writing or reviewing tests that assert on package version numbers,
or after a release sync where tests suddenly fail with no apparent code changes.

### 3.1 — The silent failure pattern

Tests that hardcode version strings fail silently when a package is released
with an updated version:

```typescript
// ❌ BAD — breaks on every release
expect(output).toContain('myco-collective v0.1.0');
```

The test passes on the commit where it was written, but after a version bump
the hardcoded string no longer matches. The failure can be hard to trace because
no logic changed — only the version in `package.json`.

### 3.2 — Dynamic version reading

Fix by reading the version from the package manifest at test time:

```typescript
// ✅ GOOD — survives version bumps
const { version } = require('@goondocks/myco-collective/package.json');

expect(output).toContain(`myco-collective v${version}`);
```

Within a workspace, `require('@goondocks/myco-collective/package.json')` resolves to
the workspace copy — no publish needed for this to work locally or in CI.

### 3.3 — Audit existing tests before tagging

Before cutting a release, grep for hardcoded version strings in the test suite:

```bash
# Find hardcoded version strings in tests
grep -rn "v[0-9]\+\.[0-9]\+\.[0-9]\+" tests/ --include="*.test.ts"

# Known location to check in this project
grep -n "v0\." tests/cli/collective-*.test.ts
```

Update any hardcoded version assertions to the dynamic `require()` pattern
before pushing the release tag.

## Procedure 4: Diagnose Manual Publish Issues

**When:** A release was attempted but the package did not appear on npm as expected.

### 4.1 — Common failure modes

**Authentication issues:**
```bash
# Verify npm auth status
npm whoami

# Re-authenticate if needed
npm login
```

**Wrong package directory:**
```bash
# ❌ Publishing from wrong location
npm publish  # from repo root

# ✅ Publishing from package directory
cd packages/myco
npm publish --access public
```

**Version conflicts:**
```bash
# Check if version already exists
npm view @goondocks/myco versions --json

# If version exists, bump and try again
npm version patch  # or minor, major
npm publish --access public
```

### 4.2 — Future automated workflow diagnostics

When GitHub Actions publish workflows are implemented, common issues will include:

**`[skip ci]` on tagged commits:** If you tag a commit that carries `[skip ci]`,
GitHub will silently skip all workflows for that tag — including the publish
workflow. Check the commit message of the tagged commit:

```bash
git log --oneline myco/v0.15.0 -1
# If output contains [skip ci], that's the problem
```

**Missing workflow triggers:** Ensure workflow files are configured with the correct tag patterns and permissions.

### 4.3 — Pre-publish verification checklist

Before any publish attempt:

```bash
# 1. Verify package builds successfully
npm run build

# 2. Verify tests pass
npm test

# 3. Check version is unique
npm view $(npm pkg get name | tr -d '"') versions --json

# 4. Verify package.json is correct
npm pkg get name version

# 5. Dry run the publish
npm publish --dry-run --access public
```

## Procedure 5: Worktree Delivery Gate for Multi-Package Work

**When:** Using git worktrees for experimental development that spans multiple
packages.

### 5.1 — The required delivery path

```
worktree branch  →  local feature branch  →  PR  →  main
```

**Never** merge a worktree branch directly to local `main`. This bypasses PR
review and CI, and risks landing incomplete multi-package work on `main` — which
can break the other packages in the workspace since they share a root manifest.

### 5.2 — Setting up a worktree for package development

```bash
# Create worktree for Collective development
git worktree add ../myco-collective-work feature/collective-v1

# Work in the worktree
cd ../myco-collective-work
# ... make changes to packages/myco-collective ...

# When done: push the feature branch to origin
git push origin feature/collective-v1

# Back in main repo: open a PR from feature/collective-v1 → main
# Do NOT run: git merge feature/collective-v1 from local main
```

### 5.3 — Cleaning up worktrees

```bash
# Remove the worktree once the PR is merged
git worktree remove ../myco-collective-work

# Prune stale worktree metadata
git worktree prune
```

### 5.4 — Avoid shared file conflicts across worktrees

When running parallel worktrees for different packages, plan file ownership
before starting. If two worktrees touch the same file (e.g., root `package.json`
or a shared type definition), merge conflicts become difficult to resolve. Plan
the split upfront:

| Worktree | Owns |
|---|---|
| `feature/collective-v1` | `packages/myco-collective/`, root workspace changes |
| `feature/team-v2` | `packages/myco-team/` only |

If root `package.json` changes are needed in multiple worktrees, do them
sequentially, not in parallel.

### 5.5 — Quality gate integration for nested workers

When the worktree contains nested workers (e.g., `packages/myco-collective/worker`, `packages/myco-team/worker`),
extend the quality gate to validate worker-specific concerns:

```bash
# In the worktree, before pushing to origin:
make build                    # Standard monorepo build
make test-workers            # Worker-specific tests
wrangler deploy --dry-run    # Validate Worker deployment config
```

This prevents broken worker configs from reaching main branch where they could
block other releases.

## Procedure 6: Node Binary Resolution in Sub-Process Spawns

**When:** A script or build tool (e.g., Wrangler) spawns Node sub-processes,
or you're writing code that programmatically invokes Node.

### 6.1 — Symptom

```
env: node: No such file or directory
```

This occurs when a sub-process is launched in a clean shell environment (e.g.,
by Wrangler during `wrangler dev`) where `PATH` does not include the version
manager's (nvm/fnm/volta) Node binary location.

### 6.2 — Fix: resolve via `process.execPath`

Never rely on bare `node` in spawned processes:

```typescript
// ❌ BAD — fails in clean-shell sub-processes
const child = spawn('node', ['script.js']);

// ✅ GOOD — always resolves to the running Node binary
const child = spawn(process.execPath, ['script.js']);
```

`process.execPath` is the absolute path to the Node binary running the parent
process. It is always correct regardless of `PATH` because it doesn't require
a shell lookup — it's a property of the current runtime.

### 6.3 — Audit bare `node` invocations

```bash
grep -rn "spawn('node'" src/ --include="*.ts"
grep -rn 'exec("node' src/ --include="*.ts"
grep -rn '"node "' src/ --include="*.ts"
```

Replace any bare `node` spawn with `process.execPath`.

## Procedure 7: UI Lockfile Mutation Prevention

**When:** Running npm operations from the repo root that could affect UI package
lockfiles, or debugging why UI builds are broken after root npm operations.

### 7.1 — The mutation pattern

Running certain npm commands from the monorepo root can mutate the lockfiles
in nested packages, even when those packages are not part of the root workspace:

```bash
# From repo root - can mutate packages/*/worker/package-lock.json
npm install some-package
npm audit fix
npm update
```

This happens because npm's workspace resolution sometimes treats nested
`package.json` files as implicit workspace members, even when they're not
declared in the root `workspaces` array.

### 7.2 — Safe operation patterns

Always operate within the package directory for non-workspace packages:

```bash
# ❌ BAD — from repo root
npm install --prefix packages/myco-collective/worker some-package

# ✅ GOOD — within the package directory  
cd packages/myco-collective/worker
npm install some-package
cd ../../..
```

For workspace packages, root operations are safe and preferred:

```bash
# ✅ GOOD — for workspace members
npm install --workspace=packages/myco-collective some-package
```

### 7.3 — Lockfile audit after root operations

After any root npm operation, check for unintended mutations:

```bash
# Check for any lockfile changes
git status | grep package-lock.json

# If nested worker lockfiles changed, reset them:
git checkout -- packages/*/worker/package-lock.json
```

Only commit lockfile changes for the specific package you intended to modify.

## Procedure 8: Dependency Management Patterns for Monorepos

**When:** Managing Dependabot PRs, running dependency audits, or planning dependency updates across multiple packages.

### 8.1 — Batching Dependabot PRs

When multiple Dependabot PRs accumulate, batch them locally rather than merging individually:

```bash
# Fetch all open Dependabot branches
git fetch origin

# Create a batch branch
git checkout -b dependabot-batch-$(date +%Y%m%d)

# Merge each Dependabot branch (replace with actual branch names)
git merge origin/dependabot/npm_and_yarn/eslint-9.15.0
git merge origin/dependabot/npm_and_yarn/typescript-5.7.2
git merge origin/dependabot/npm_and_yarn/prettier-3.4.1

# Run full test suite
npm test
npm run build --workspaces

# If tests pass, push and create PR
git push origin dependabot-batch-$(date +%Y%m%d)
```

This approach runs tests once on the combined changes rather than individually, catching interaction issues between dependency updates.

### 8.2 — Dependabot coverage gaps for nested packages

Dependabot only monitors packages declared in the root `.github/dependabot.yml`. Nested packages outside the workspace (workers, UI apps) require explicit configuration:

```yaml
# .github/dependabot.yml
version: 2
updates:
  # Root workspace packages (covered by default)
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
  
  # Explicit nested package monitoring
  - package-ecosystem: "npm"
    directory: "/packages/myco-collective/worker"
    schedule:
      interval: "weekly"
  
  - package-ecosystem: "npm"  
    directory: "/packages/myco-team/worker"
    schedule:
      interval: "weekly"
```

Without explicit entries, these packages accumulate stale dependencies silently.

### 8.3 — `npm audit fix` safety procedures

Running `npm audit fix` across a monorepo requires careful scoping to avoid breaking changes:

```bash
# ❌ DANGEROUS — can introduce breaking changes across all packages
npm audit fix

# ✅ SAFE — audit each package individually
npm audit fix --workspace=packages/myco
npm audit fix --workspace=packages/myco-team
npm audit fix --workspace=packages/myco-collective

# For nested non-workspace packages
cd packages/myco-collective/worker && npm audit fix && cd ../../..
cd packages/myco-team/worker && npm audit fix && cd ../../..
```

Always run the full test suite after any `npm audit fix`:

```bash
npm test
npm run build --workspaces
make test-workers  # if workers exist
```

### 8.4 — Dependency version alignment across packages

Workspace packages should align on shared dependencies to avoid version conflicts:

```bash
# Check for version mismatches across workspace packages
npm ls typescript --workspaces
npm ls eslint --workspaces
npm ls prettier --workspaces
```

If mismatches exist, align to the highest compatible version:

```bash
# Update all workspace packages to same version
npm install typescript@5.7.2 --workspace=packages/myco
npm install typescript@5.7.2 --workspace=packages/myco-team  
npm install typescript@5.7.2 --workspace=packages/myco-collective
```

For development dependencies, consider hoisting to the root:

```bash
# Remove from individual packages
npm uninstall typescript --workspace=packages/myco-collective

# Install at root (available to all workspace packages)  
npm install --save-dev typescript@5.7.2
```

## Cross-Cutting Gotchas

| Gotcha | Symptom | Fix |
|---|---|---|
| `npm install -g npm@latest` in CI | OIDC publish fails with cryptic auth error | Remove the step; Node 22's bundled npm 10.x supports OIDC natively |
| Hardcoded version in tests | Tests fail after release sync with no code changes | Use `require('package.json').version` dynamically |
| Manual publish from wrong directory | Package not found error during publish | Always `cd` to the package directory before `npm publish` |
| Bare `node` in spawn calls | `env: node: No such file or directory` in Wrangler | Replace with `process.execPath` |
| Merging worktree directly to local `main` | Incomplete features land in main, CI bypassed | Always deliver via PR: worktree → feature branch → PR |
| Tagging before auditing test version strings | Tests fail on the release commit itself | Run version-string grep audit before pushing a release tag |
| Root npm operations mutating nested lockfiles | UI builds break after unrelated npm operations | Operate within package directories for non-workspace packages |
| Missing nested worker validation in worktree gate | Worker config errors reach main branch | Extend quality gate with `wrangler deploy --dry-run` |
| Individual Dependabot PR merges | Interaction issues between dependency updates missed | Batch multiple Dependabot PRs locally and test combined changes |
| Missing Dependabot config for nested packages | Workers and UI apps accumulate stale dependencies | Add explicit `.github/dependabot.yml` entries for all package directories |
| Monorepo-wide `npm audit fix` | Breaking changes introduced across multiple packages | Run `npm audit fix` per workspace, test after each |
| Version mismatches across workspace packages | Runtime conflicts between packages | Align shared dependency versions using `npm ls --workspaces` |