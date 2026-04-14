---
name: myco:monorepo-release-engineering
description: |
  Use this skill when working on Myco's multi-package npm workspace structure,
  per-package CI release pipelines, or any task touching package publishing,
  version management, or release tag workflows across `packages/myco`,
  `packages/myco-team`, and `packages/myco-collective`. Covers five distinct
  procedures: (1) bootstrapping the monorepo workspace, (2) configuring
  per-package OIDC publish workflows with tag-prefix triggers, (3) auditing
  and hardening test version assertions to avoid silent drift, (4) diagnosing
  and fixing silent tag-publish failures caused by `[skip ci]` commit messages,
  and (5) applying the worktree delivery gate safely for multi-package
  experimental work. Also covers Node binary PATH resolution in Wrangler
  sub-shell spawns. Apply this skill even if the user doesn't explicitly ask
  for "monorepo" or "release engineering" — it applies any time you're adding
  a new package, cutting a release, touching CI publish workflows, or
  investigating why a tag didn't publish.
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
- GitHub Actions with npm OIDC publishing configured (`provenance` + `id-token: write`)
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
  "name": "@goondocks/myco-team",
  "version": "0.1.0",
  "main": "dist/index.js",
  "bin": {
    "myco-team": "dist/cli.js"
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
# Build only myco-team
npm run build --workspace=packages/myco-team

# Test only myco-team
npm run test --workspace=packages/myco-team

# Build all packages
npm run build --workspaces
```

Verify that no package's build depends on another package's `dist/` output.
Cross-package dependencies within the workspace are resolved via the workspace
symlink, not via built artifacts.

## Procedure 2: Configure Per-Package CI Release Pipelines

**When:** Setting up or modifying GitHub Actions publish workflows for any package.

### 2.1 — Tag-prefix trigger convention

Each package uses a distinct tag prefix to trigger its own publish workflow:

| Package | Tag format | Example |
|---|---|---|
| `packages/myco` | `myco/vX.Y.Z` | `myco/v0.15.0` |
| `packages/myco-team` | `myco-team/vX.Y.Z` | `myco-team/v0.3.0` |
| `packages/myco-collective` | `collective/vX.Y.Z` | `collective/v0.1.0` |

Workflow trigger:

```yaml
on:
  push:
    tags:
      - 'myco-team/v*'
```

### 2.2 — OIDC publish workflow

Node 22's bundled npm 10.x supports OIDC natively. **Never run
`npm install -g npm@latest` in CI** — it replaces npm's own dependencies and
corrupts them, silently breaking the OIDC publish step with a cryptic auth error.

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write   # Required for OIDC provenance
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      # Do NOT add: run: npm install -g npm@latest
      - run: npm ci
      - run: npm publish --provenance --access public
        working-directory: packages/myco-team
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

### 2.3 — Tagging for release

```bash
# Bump version in the package manifest first
cd packages/myco-team
npm version 0.3.1

# Tag at the repo root with the prefix convention
git tag myco-team/v0.3.1
git push origin myco-team/v0.3.1
```

> **Critical:** Before tagging, verify the target commit does not carry a
> `[skip ci]` message — see Procedure 4. A tag on a `[skip ci]` commit is
> silently never published.

## Procedure 3: Harden Tests Against Version Drift

**When:** Writing or reviewing tests that assert on package version numbers,
or after a release sync where tests suddenly fail with no apparent code changes.

### 3.1 — The silent failure pattern

Tests that hardcode version strings fail silently when a package is released
with an updated version:

```typescript
// ❌ BAD — breaks on every release sync
expect(output).toContain('myco-team v0.2.0');
```

The test passes on the commit where it was written, but after a version bump
the hardcoded string no longer matches. The failure can be hard to trace because
no logic changed — only the version in `package.json`.

### 3.2 — Dynamic version reading

Fix by reading the version from the package manifest at test time:

```typescript
// ✅ GOOD — survives version bumps
const { version } = require('@goondocks/myco-team/package.json');

expect(output).toContain(`myco-team v${version}`);
```

Within a workspace, `require('@goondocks/myco-team/package.json')` resolves to
the workspace copy — no publish needed for this to work locally or in CI.

### 3.3 — Audit existing tests before tagging

Before cutting a release, grep for hardcoded version strings in the test suite:

```bash
# Find hardcoded version strings in tests
grep -rn "v[0-9]\+\.[0-9]\+\.[0-9]\+" tests/ --include="*.test.ts"

# Known location to check in this project
grep -n "v0\." tests/cli/team-rotate.test.ts
```

Update any hardcoded version assertions to the dynamic `require()` pattern
before pushing the release tag.

## Procedure 4: Diagnose Silent Tag-Publish Failures

**When:** A release tag was pushed but the package did not appear on npm, and
no error was reported.

### 4.1 — Symptom

```
Tag: myco-team/v0.3.1  ✓ (exists in GitHub)
GitHub Actions run:    ✗ (no workflow triggered)
npm registry:          ✗ (version never appears)
```

No workflow failure — no workflow run at all. The tag is visible in the GitHub
UI but nothing happened.

### 4.2 — Root cause: `[skip ci]` on the tagged commit

Sync workflows often write back to `main` with a `[skip ci]` commit message to
prevent infinite CI loops. If you tag a commit that carries `[skip ci]`,
GitHub **silently skips all workflows** for that tag — including the publish
workflow. There is no error, no notification, and no indication in the UI beyond
the absence of a workflow run.

Check the commit message of the tagged commit:

```bash
git log --oneline myco-team/v0.3.1 -1
# If output contains [skip ci], that's the problem
```

### 4.3 — Workaround: pre-tag commit check

Before tagging, verify the target commit is clean:

```bash
COMMIT_MSG=$(git log -1 --pretty=%B)
if echo "$COMMIT_MSG" | grep -q '\[skip ci\]'; then
  echo "ERROR: Cannot tag a [skip ci] commit — publish workflow will be skipped"
  echo "Create an empty commit or tag a different commit."
  exit 1
fi
```

To fix an already-created tag on a `[skip ci]` commit, delete the tag, create
an empty commit, and re-tag:

```bash
git tag -d myco-team/v0.3.1
git push origin :refs/tags/myco-team/v0.3.1
git commit --allow-empty -m "chore: trigger publish for myco-team v0.3.1"
git tag myco-team/v0.3.1
git push origin myco-team/v0.3.1
```

### 4.4 — Long-term: replace the `[skip ci]` sync strategy

The `[skip ci]` approach is fragile. A more robust long-term fix is to detect
sync commits by actor rather than by commit message:

```yaml
# In the publish workflow, skip runs triggered by the sync bot
if: github.actor != 'github-actions[bot]'
```

Or use path filters that naturally exclude the files the sync workflow touches.
Either approach avoids the silent-skip behavior.

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

## Cross-Cutting Gotchas

| Gotcha | Symptom | Fix |
|---|---|---|
| `npm install -g npm@latest` in CI | OIDC publish fails with cryptic auth error | Remove the step; Node 22's bundled npm 10.x supports OIDC natively |
| Hardcoded version in tests | Tests fail after release sync with no code changes | Use `require('package.json').version` dynamically |
| `[skip ci]` on tagged commit | Tag exists but package never publishes, no error shown | Check commit message before tagging; use an empty commit if needed |
| Bare `node` in spawn calls | `env: node: No such file or directory` in Wrangler | Replace with `process.execPath` |
| Merging worktree directly to local `main` | Incomplete features land in main, CI bypassed | Always deliver via PR: worktree → feature branch → PR |
| Tagging before auditing test version strings | Tests fail on the release commit itself | Run version-string grep audit before pushing a release tag |
