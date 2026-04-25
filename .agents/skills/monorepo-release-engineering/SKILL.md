---
name: myco:monorepo-release-engineering
description: |
  Use this skill for Myco's npm workspace, CI publishing pipelines, or any task
  touching package release, versioning, or tag workflows across the five
  published packages (`@goondocks/myco`, `myco-team`, `myco-collective`,
  `myco-hub`, `myco-shared`). Covers workspace bootstrap, OIDC tag-trigger
  publishing, adding a new publishable package (the four-place wiring needed
  to avoid silent skips), test version-string drift, diagnosing silent
  tag-publish failures (`[skip ci]`, missing triggers, cascade-skip from
  transitive needs), first-time trusted-publishing bootstrap (local publish
  then OIDC), worktree delivery gates, Dependabot batching, and Node binary
  PATH resolution in Wrangler sub-shell spawns. Apply even when the user
  doesn't explicitly say "monorepo" or "release engineering" — it covers any
  package publishing, CI workflow, or dependency update work.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Multi-Package Monorepo and Release Engineering

Myco is structured as a multi-package npm workspace. Five packages publish to
npm, each with its own version, CLI, and tag-driven CI release trigger:

| Package | Role | GH Release? |
|---|---|---|
| `@goondocks/myco` | Core CLI / daemon | yes |
| `@goondocks/myco-team` | Team-sync Worker + CLI | yes |
| `@goondocks/myco-collective` | Collective Worker + UI + CLI | yes |
| `@goondocks/myco-hub` | Local daemon hub + reverse proxy | yes |
| `@goondocks/myco-shared` | Internal helpers (process/port/JSON) | **no** — internal-only |

`packages/myco-deploy` exists in the workspace but is not published.

This skill covers the full release engineering domain: workspace setup,
per-package publishing pipelines, **how to add a new publishable package
without silent skips**, test hardening against version drift, **CI publish
diagnostics for skipped jobs**, **first-time trusted-publishing bootstrap**,
and the operational pitfalls that will silently break releases if you don't
know them.

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
| `@goondocks/myco` | `myco/vX.Y.Z` | `myco/v0.22.3` |
| `@goondocks/myco-team` | `myco-team/vX.Y.Z` | `myco-team/v0.1.6` |
| `@goondocks/myco-collective` | `myco-collective/vX.Y.Z` | `myco-collective/v0.1.7` |
| `@goondocks/myco-hub` | `myco-hub/vX.Y.Z` | `myco-hub/v0.1.0` |
| `@goondocks/myco-shared` | `myco-shared/vX.Y.Z` | `myco-shared/v0.1.1` |

### 2.2 — Current state: tag-only releases via GitHub Actions OIDC

CI publishing is **live and authoritative**. Two workflows fire on the same
tag-prefix patterns:

- `.github/workflows/publish.yml` — builds, packs, optionally creates a GitHub
  Release, and publishes to npm via OIDC trusted-publishing.
- `.github/workflows/sync-package-versions.yml` — reads the tag, writes the
  version into the matching `package.json` files on `main`, and commits with
  `[skip ci]`.

This means **you never edit `version` fields by hand**. Tag, push, done.
`scripts/sync-package-versions.mjs` is the source of truth for which package
gets which version on a given tag prefix.

Node 22's bundled npm 10.x supports OIDC natively. **Never run
`npm install -g npm@latest` in CI** — it replaces npm's own dependencies and
corrupts them, silently breaking the OIDC publish step with a cryptic auth
error.

The publish job uses `--provenance --access public` and runs in a
`npm-publish` GitHub environment that gates on the tag-prefix allow-list (set
on the npm package's Trusted Publishers config).

### 2.3 — Tag-only release procedure

**For a stable release:**
```bash
# Make sure main is up to date and tests pass locally
git checkout main && git pull
make build  # quality gate

# Tag and push — that's it. sync-package-versions.yml writes the version,
# publish.yml builds and publishes.
git tag myco/v0.22.4
git push origin myco/v0.22.4
```

**For a prerelease (beta/alpha/rc):**
```bash
git tag myco/v0.22.4-beta.1
git push origin myco/v0.22.4-beta.1
# publish.yml maps -alpha → @alpha, -beta → @beta, -rc → @next on npm.
```

**Watch the run land:**
```bash
gh run list --workflow=publish.yml --limit 1
gh run watch $(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

If `Publish to npmjs.org` is **`skipped`**, see Procedure 5 — that's a CI
diagnostic, not a normal state.

> **Commit message:** for any non-tag commit that touches release infra, use a
> semantic form (`chore(release): …`, `fix(release): …`). The git log is the
> primary debugging tool when releases regress.

### 2.4 — Adding a new publishable package (the four-place wiring)

**The single most error-prone moment in this domain.** Missing any one of
these places makes the workflow silently no-op when the tag is pushed.

When a new package needs CI publishing, you must update **four** files:

1. **`packages/<new-pkg>/package.json`** — must have `"name"`, `"version"`,
   `"main"`/`"exports"`, `"files"` (whitelisting `dist/` etc.), and either
   `"publishConfig": { "access": "public" }` or top-level `"private": false`.
   Internal-only packages: keep `"private": true`.

2. **`.github/workflows/publish.yml`**:
   - Add to `on.push.tags`:
     ```yaml
     - '<prefix>/v*.*.*'
     - '<prefix>/v*.*.*-*'
     ```
   - Add a case branch in the `validate-tag` step:
     ```bash
     <prefix>)
       PACKAGE_NAME="@goondocks/<pkg>"
       PACKAGE_DIR="packages/<pkg>"
       TARBALL_PREFIX="goondocks-<pkg>"
       ;;
     ```
   - If the package is **internal** and shouldn't have a GitHub Release,
     add it to the exclusion in `create-release`'s `if:` clause:
     ```yaml
     needs.validate-tag.outputs.tag_prefix != 'myco-shared'
     ```

3. **`.github/workflows/sync-package-versions.yml`**:
   - Add the same two `on.push.tags` patterns.
   - Add `packages/<pkg>/package.json` to the `git add` list in the commit
     step. (Forgetting this means the version gets written but never committed,
     so subsequent runs keep re-writing the same change.)

4. **`scripts/sync-package-versions.mjs`** — append a `PACKAGE_TARGETS` entry:
   ```js
   {
     envKey: 'MYCO_<UPPER>_VERSION',
     tagPrefix: '<prefix>',
     files: ['packages/<pkg>/package.json'],
   },
   ```

5. **npm Trusted Publishers config** (one-time, on npmjs.com after the first
   publish): add a publisher entry pointing at `goondocks-co/myco`'s
   `publish.yml` workflow with environment `npm-publish`. See Procedure 6 for
   the bootstrap sequence.

**Verification before pushing the first tag:**
```bash
# Trigger pattern is in the workflow
grep -n '<prefix>/v' .github/workflows/publish.yml .github/workflows/sync-package-versions.yml
# Validate-tag has the case branch
grep -A3 '<prefix>)' .github/workflows/publish.yml
# Sync script knows about it
grep '<prefix>' scripts/sync-package-versions.mjs
# Workspace dependency graph resolves
npm install
ls -la node_modules/@goondocks/<pkg>     # symlink → packages/<pkg>
```

If any of those four are missing, the tag will silently no-op — see
Procedure 5 for diagnosis.

### 2.5 — Nested non-workspace packages

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

## Procedure 4: Diagnose Silent CI Publish Failures

**When:** A tag was pushed, but the package did not land on npm. CI may show
the workflow as `success` overall — that does **not** mean publish ran.

### 4.1 — The five silent-skip modes

Each presents the same surface symptom ("nothing on npm after push"):

| Mode | Root cause | Detection |
|---|---|---|
| **Tag-trigger missing** | `on.push.tags` doesn't list the new prefix | No workflow run appears at all under `gh run list --workflow=publish.yml` |
| **Stale workflow registration** | Triggers were added to the workflow file but GitHub Actions is still using the prior registration; tag pushes match neither old nor new pattern set | No workflow run, even though `on.push.tags` includes the prefix and the tag points at a commit where the workflow file is correct. Reproduces across multiple known-working prefixes. **Fix: a no-op edit to the workflow file (e.g. add a top-level comment), commit, and push — that re-registers the trigger set. Then re-push the tag.** Bit `myco-hub/v0.1.1` for ~35 minutes despite multiple delete-and-recreate attempts |
| **Validate-tag rejects** | Case branch missing → `*)` falls through → `exit 1` | One job ran (`Validate Release Tag`), conclusion `failure` |
| **`[skip ci]` on the tagged commit** | Tag points at a commit whose message contains `[skip ci]` | No run; `git log -1 <tag>` shows the marker |
| **Cascade-skip from transitive needs** | Downstream job's implicit `success()` evaluation skips because an ancestor was skipped | Run appears, build is `success`, but `Create GitHub Release` and/or `Publish to npmjs.org` are `skipped` |

### 4.2 — Diagnostic commands

```bash
# Did the workflow even fire?
gh run list --workflow=publish.yml --limit 5 --json databaseId,headBranch,conclusion

# What's the per-job status of the run?
RUN_ID=<from above>
gh api repos/goondocks-co/myco/actions/runs/$RUN_ID/jobs --jq '.jobs[] | {name, conclusion}'

# Was the tagged commit marked [skip ci]?
git log -1 --format='%s%n%b' <tag-name>

# What's actually on npm?
npm view @goondocks/<pkg> versions --json
npm view @goondocks/<pkg> dist-tags

# Compare to git tags — drift means CI silently skipped at some point
git tag --list "<prefix>/v*" | tail -5
```

### 4.3 — The cascade-skip pattern (most-bitten)

GitHub Actions evaluates a job's implicit `success()` against **all transitive
ancestors**, not just direct `needs:`. When `cross-compile` is gated
`if: tag_prefix == 'myco'`, it's `skipped` for any other prefix. Even though
`build` runs (it has `if: always() && (cross-compile.result == 'skipped' || ...)`),
`build`'s success doesn't shield `create-release` and `publish` — their
default `success()` sees the skipped ancestor and quietly skips them too.

**Detection:** look for `Build and Test` = `success` paired with
`Create GitHub Release` = `skipped` and `Publish to npmjs.org` = `skipped`
in the same run. That's the cascade.

**Fix:** mirror the `always() &&` override on each downstream job:
```yaml
create-release:
  needs: [validate-tag, build]
  if: |
    always() &&
    needs.validate-tag.result == 'success' &&
    needs.build.result == 'success'

publish:
  needs: [validate-tag, build, create-release]
  if: |
    always() &&
    needs.validate-tag.result == 'success' &&
    needs.build.result == 'success' &&
    (needs.create-release.result == 'success' || needs.create-release.result == 'skipped')
```

The current workflow has these gates. **Don't remove them** — and when
adding a new downstream job, copy the same pattern.

This pattern bit `myco-team/v0.1.5`, `myco-team/v0.1.6`, and
`myco-collective/v0.1.7` between when `cross-compile` was added and when the
gates were fixed in commits `dd4838a7` and `026e06b3`. The git tags exist;
those versions never made it to npm.

### 4.4 — `Create GitHub Release` exits 141 (SIGPIPE) on first-time prefixes

When a new tag prefix has no prior tag of its own kind, the release-notes
generator falls back to walking the entire repo log to fill the
"What's Changed" section. Under `set -euo pipefail` (which the workflow
uses), the historical pattern `git log --pretty=format:"- %s" --no-merges
| head -20` blows up: `head` closes the pipe early, `git` receives SIGPIPE
(exit 141), `pipefail` propagates it, the step exits 141.

**Detection:** `Create GitHub Release` shows `failure`, log ends with
`Process completed with exit code 141`, the failing step is `Generate
release notes`. The step's stdout includes the heredoc bodies but no
git-log output preceding the error.

**Fix:** use git's native `-n N` flag instead of piping to `head`:

```bash
# ❌ fails under pipefail when there are more than N commits in the range
COMMITS=$(git log --pretty=format:"- %s" --no-merges | head -20)

# ✅ git limits its own output, no pipe involved
COMMITS=$(git log -n 20 --pretty=format:"- %s" --no-merges)
```

The current workflow uses the `-n` form. **Don't reintroduce `| head -N`**
in any release-notes generator — and, more generally, in any pipefail-
guarded step that consumes a long-running producer's output.

This bit `myco-hub/v0.1.1` (the first myco-hub release that fired CI),
fixed in commit `8f9b8b03`.

### 4.5 — Recovery: re-tagging vs. version-bumping

If a tag fired but failed/skipped and **the version isn't on npm yet**:
```bash
git tag -d <prefix>/vX.Y.Z
git push origin :refs/tags/<prefix>/vX.Y.Z
git tag <prefix>/vX.Y.Z <fix-sha>
git push origin <prefix>/vX.Y.Z
```

If the version **is** on npm (you'd see it in `npm view`), don't reuse the
number — bump and tag a new patch:
```bash
git tag <prefix>/vX.Y.(Z+1)
git push origin <prefix>/vX.Y.(Z+1)
```

### 4.6 — Pre-tag verification

Before pushing a release tag:
```bash
make build           # full quality gate (tsc + tests + per-package builds)
gh run list --workflow=publish.yml --limit 1   # confirm latest workflow shape on main
git log -1 origin/main --format='%s'           # NOT [skip ci]
```

## Procedure 5: First-Time Publish Bootstrap (Trusted Publishing)

**When:** Adding a brand-new package to npm. CI's OIDC publish requires the
package to **already exist** on the registry before trusted-publishing config
can attach to it.

### 5.1 — Why CI can't go first

npm's trusted-publishers UI is per-package. Until v0.0.1 of the package is on
the registry, there's no package page on which to configure a trusted
publisher. So the bootstrap is: **publish locally once, then attach the
trusted publisher, then let CI take over for v0.0.2+.**

### 5.2 — Bootstrap sequence

```bash
# Pre-flight
npm whoami                                     # logged in
npm view @goondocks/<pkg> 2>&1 | head -1       # should be 404
git status                                     # clean
git checkout main && git pull

# Build and inspect
npm install
npm run build -w @goondocks/<pkg>
npm pack --workspace @goondocks/<pkg> --pack-destination /tmp
tar -tzf /tmp/goondocks-<pkg>-X.Y.Z.tgz
tar -xOzf /tmp/goondocks-<pkg>-X.Y.Z.tgz package/package.json | head -20
# Confirm main/types/exports point to dist/

# Publish (no provenance — OIDC is CI-only)
npm publish --workspace @goondocks/<pkg> --access public

# Verify
sleep 10
npm view @goondocks/<pkg>
```

> **Do NOT pass `--provenance` locally** — it requires GitHub OIDC and fails
> with a token-source mismatch outside CI.
>
> **Do NOT push a `<prefix>/v0.0.1` git tag yet.** CI would try to publish
> the same version and either fail with `403 cannot publish over existing
> version` or — if the trusted publisher isn't configured yet — fail with
> `401`.

### 5.3 — Configure the trusted publisher

1. Go to `https://www.npmjs.com/package/@goondocks/<pkg>/access`.
2. **Trusted Publishers** → **Add Publisher** → GitHub Actions.
3. Organization: `goondocks-co`, Repository: `myco`,
   Workflow: `publish.yml`, Environment: `npm-publish`.
4. Save.

### 5.4 — Test the CI path

Bump in source, tag, push:
```bash
# In a fresh commit on main with X.Y.(Z+1) in packages/<pkg>/package.json
# (or let sync-package-versions handle it — see Procedure 2.3)
git tag <prefix>/vX.Y.(Z+1)
git push origin <prefix>/vX.Y.(Z+1)
gh run watch $(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

A successful run shows `Publish to npmjs.org` = `success`. After this point
the package is fully OIDC-driven; no more local publishes.

### 5.5 — Bootstrap pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Used `--provenance` locally | "ENEEDAUTH" / token-source mismatch | Drop the flag for the bootstrap publish |
| Forgot `--access public` on a scoped package | `402 Payment Required` | Add `--access public` |
| 2FA set to "Authorization and writes" | npm prompts for OTP, CI will later fail | Set 2FA to "Authorization only" or pass `--otp=<code>` |
| Pushed a git tag before configuring trusted publisher | CI publish fails 401 | Delete tag, configure trusted publisher, retry |
| Pushed `vX.Y.Z` to CI matching the local-published version | `403 cannot publish over existing version` | Bump to `vX.Y.(Z+1)` |

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
| Forgetting one of the four-place wirings for a new package | Tag push triggers nothing OR validate-tag fails OR sync-versions doesn't commit | See Procedure 2.4 — tags trigger, case branch, sync-yml file list, sync-mjs PACKAGE_TARGETS |
| Stale workflow registration after adding a new trigger pattern | Tag pushes silently fire nothing even though the workflow file is correct, reproducible across multiple known-working prefixes | Make any no-op edit to `publish.yml` (e.g. add a comment), commit, push, then re-push the tag. See Procedure 4.1 |
| `git log \| head -N` under pipefail | `Create GitHub Release` exits 141 on first-time-prefix releases | Replace with `git log -n N` — git's native limit, no pipe. See Procedure 4.4 |
| Cascade-skip from transitive needs | Build succeeds, create-release + publish silently skip | Add `if: always() && needs.X.result == 'success'` to every downstream job. See Procedure 4.3 |
| `npm publish --provenance` locally during bootstrap | Token-source mismatch / ENEEDAUTH | Drop `--provenance`; OIDC is CI-only. Local bootstrap is plain `npm publish --access public` |
| Pushing a tag before configuring trusted publisher | CI publish 401 | Bootstrap order: local publish → npm Trusted Publishers UI → push tag |
| Reusing a version that's live on npm | `403 cannot publish over existing version` | If version is on npm, bump. If only the tag exists (CI skipped), force-retag the existing version |
| Git-tag/npm-registry drift | `git tag --list` shows a version `npm view` doesn't | Cascade-skip happened. Re-tag at fixed-workflow SHA (Procedure 4.4) |
| `npm install -g npm@latest` in CI | OIDC publish fails with cryptic auth error | Remove the step; Node 22's bundled npm 10.x supports OIDC natively |
| Hardcoded version in tests | Tests fail after release sync with no code changes | Use `require('package.json').version` dynamically |
| Manual publish from wrong directory | Package not found error during publish | Always `cd` to the package directory or use `npm publish --workspace @goondocks/<pkg>` |
| Bare `node` in spawn calls | `env: node: No such file or directory` in Wrangler | Replace with `process.execPath` |
| Merging worktree directly to local `main` | Incomplete features land in main, CI bypassed | Always deliver via PR: worktree → feature branch → PR |
| Tagging before auditing test version strings | Tests fail on the release commit itself | Run version-string grep audit before pushing a release tag |
| Root npm operations mutating nested lockfiles | UI builds break after unrelated npm operations | Operate within package directories for non-workspace packages |
| Missing nested worker validation in worktree gate | Worker config errors reach main branch | Extend quality gate with `wrangler deploy --dry-run` |
| Individual Dependabot PR merges | Interaction issues between dependency updates missed | Batch multiple Dependabot PRs locally and test combined changes |
| Missing Dependabot config for nested packages | Workers and UI apps accumulate stale dependencies | Add explicit `.github/dependabot.yml` entries for all package directories |
| Monorepo-wide `npm audit fix` | Breaking changes introduced across multiple packages | Run `npm audit fix` per workspace, test after each |
| Version mismatches across workspace packages | Runtime conflicts between packages | Align shared dependency versions using `npm ls --workspaces` |