---
name: myco:monorepo-quality-engineering-build-lifecycle
description: |
  Quality engineering procedures for Myco's npm workspace: build orchestration (make vs npm), cross-platform artifact validation, workspace dependency management, release workflow hardening, and CI/CD pipeline robustness. Use when setting up quality gates, debugging build failures, hardening release workflows, or managing workspace dependencies.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Monorepo Quality Engineering & Build Lifecycle

Quality engineering procedures for establishing and maintaining robust build validation, dependency management, and CI/CD workflows in Myco's multi-package npm workspace. These procedures ensure silent failures are caught, cross-platform compatibility is validated, and release workflows are hardened against common failure modes.

## Prerequisites

- Myco project with established npm workspace structure
- Understanding of the multi-package architecture (packages/, ui workspaces)
- Knowledge of npm workspace commands and lockfile management
- Access to CI/CD configuration files
- For Grove deployment: understanding of multi-tenant architecture and project isolation

## Procedure 1: Multi-stage Quality Gates

Establish and maintain the distinction between fast development builds (`make build`) versus comprehensive CI validation (`make build-all`).

### Build Orchestration Strategy

**Default Development Build** (fast profile, then auto-deploys + restarts the running dev daemon since the Makefile targets dogfooding):
```bash
make build
# Executes: check-fast (lint+test-fast) -> npm run build -> dev-refresh
# Excludes: tests/integration/, tests/smoke/, tests/daemon/integration/
```
**Compile-only** (no daemon refresh): `make build-only` runs `npm run build` only.
**Full CI Build**: `make build-all` runs check-all (lint+test-all, all buckets) -> npm run build -> dev-refresh.
**Native Module Rebuild** (fix stale `.node` binaries after a branch switch): `make build-rebuild` runs `rebuild` (`npm rebuild`) then `build`.
**Bundler-only** (skips validation, no daemon refresh): `npm run build`

### Fast Profile Test Exclusions

The `MYCO_TEST_PROFILE=fast` excludes these test buckets to avoid CI flakes during development:
- `tests/integration/` - Integration tests that may have external dependencies
- `tests/smoke/` - Smoke tests that may require full system setup
- `tests/daemon/integration/` - Daemon integration tests with timing dependencies

### Implementing Quality Gates

1. **Review Makefile targets** to ensure proper orchestration:
```bash
grep -A 10 "^build:" Makefile
```

2. **Validate stage dependencies** - each stage should fail fast:
   - TypeScript compilation via `tsc --noEmit` in lint
   - Fast test execution via `MYCO_TEST_PROFILE=fast node scripts/run-bun-tests.mjs`
   - Bundler compilation via workspace builds
   - Worker validation via `npm run check:workers`

3. **Prevent silent quality failures** in release workflows:
   - Use `make build` for development (fast feedback loop)
   - Use `make build-all` in CI/CD for comprehensive validation
   - Verify exit codes are properly propagated
   - Add explicit validation steps after bundler operations

### Grove Project-Scoped Build Validation

For Grove multi-tenant builds, add project-scoped validation that respects tenant isolation:

```bash
# Project-scoped build validation
GROVE_PROJECT_ID=<project-id> make build-tenant
# Validates: tenant-specific config, scoped resources, isolated testing
```

**Project-scoped validation checklist**:
- Tenant configuration loads correctly from `.myco/project.toml`
- Build artifacts use project-scoped paths (no cross-tenant contamination)
- Test suites run with proper project context isolation
- Database schema validation respects multi-tenant constraints

### Quality Gate Debugging

When build stages fail:
```bash
# Run stages individually to isolate failures
npm run lint          # tsc --noEmit + worker checks
npm test              # fast profile by default
npm run test:fast     # explicit fast profile
npm run test:integration  # integration tests only
npm run build         # workspace builds only
```

## Procedure 2: Cross-platform Build Validation

Validate artifacts and handle platform-specific native dependencies across build matrices.

### Tree-Shaking Quality Validation

Tree-shaking can introduce subtle build failures when value imports contaminate package boundaries:

1. **Detect tree-shaking fragility**:
```bash
# Check for value imports of type helpers across package boundaries
grep -r "import.*{.*}" packages/myco-*/src/ | grep -v "type.*{.*}"
```

2. **Fix contaminated imports**:
```typescript
// BAD: Value import contaminates bundle and breaks platform boundaries
import { PromptInput } from '@goondocks/myco';

// GOOD: Type-only import preserves tree-shaking
import type { PromptInput } from '@goondocks/myco';
```

**Tree-shaking fragility patterns**:
- **Value imports of types**: Import types that should be type-only imports  
- **Cross-package helper contamination**: Utility functions pulled across package boundaries
- **Platform-specific leaks**: Native dependencies contaminating wrong platform builds
- **Bundle size regression**: Sudden increases indicating contaminated tree-shaking

### Build Matrix Management

1. **Platform-specific gotchas**:
   - macOS: may require different native binaries
   - Linux: ensure glibc compatibility
   - Windows: handle path separators and executable extensions

2. **Native binary handling patterns**:
   - Use `npm rebuild` after switching Node versions
   - Handle better-sqlite3 and esbuild native dependencies
   - Clear npm cache when target architecture mismatches

## Procedure 3: Workspace Dependency Management

Manage npm workspace dependencies, lockfile synchronization, audit fixes without mutations, and Dependabot PR batching.

### Root vs Nested Package Installs

1. **Root workspace management**:
```bash
# Install all workspace dependencies
npm install

# Add dependency to specific workspace
npm install --workspace=@goondocks/myco some-package
```

2. **Nested UI workspace handling**:
```bash
# UI workspaces need separate installs in git worktrees
for ui_dir in packages/*/ui; do
  if [ -d "$ui_dir" ]; then
    echo "Installing $ui_dir"
    (cd "$ui_dir" && npm install)
  fi
done
```

### Lockfile Synchronization

1. **Detect lockfile drift**:
```bash
# Check for multiple package-lock.json files
find . -name "package-lock.json" -not -path "./node_modules/*"
```

2. **Audit fix mutation detection**:
```bash
# Run audit fix and check for unexpected changes
git status --porcelain > before_audit.txt
npm audit fix
git status --porcelain > after_audit.txt
diff before_audit.txt after_audit.txt
```

3. **Lockfile coordination** across nested workspaces:
   - Keep root package-lock.json as source of truth
   - Regenerate nested lockfiles only when absolutely necessary
   - Use `npm ci` in CI to ensure lockfile compliance

### Dependabot PR Batching

When multiple Dependabot PRs accumulate, use the batching workflow:

1. **Batch all open PRs locally**:
```bash
# Collect all Dependabot branches
git fetch origin
git branch -r | grep dependabot | head -5  # Process in batches
```

2. **Run tests on combined changes**:
```bash
# Create temporary branch with all updates
git checkout -b deps/batch-update
for branch in $(git branch -r | grep dependabot | head -5); do
  git merge $branch --no-edit
done
npm test
```

3. **Merge successful batches** instead of individual PRs

## Procedure 4: Pre-Release Quality Validation

Four complementary techniques for comprehensive pre-release quality gates that address different failure modes in Myco releases.

### Technique 1: Parallel Agent Team Review

**When:** Final quality pass before merging a release PR cluster.

**Pattern:** Use three specialist agents running in parallel worktrees:

1. **Reuse reviewer** — checks for duplication, repeated logic, missed consolidation opportunities
2. **Performance reviewer** — analyzes performance implications, resource usage, bottlenecks
3. **Security reviewer** — validates security patterns, access controls, input validation

**Implementation**:
```bash
# Set up parallel review worktrees
git worktree add ../myco-review-reuse main
git worktree add ../myco-review-performance main  
git worktree add ../myco-review-security main

# Run parallel agent reviews
(cd ../myco-review-reuse && myco agent review --focus=reuse) &
(cd ../myco-review-performance && myco agent review --focus=performance) &
(cd ../myco-review-security && myco agent review --focus=security) &
wait

# Consolidate findings
myco agent consolidate-reviews ../myco-review-*
```

### Technique 2: Multi-Tier Full-Stack Smoke Testing

**When:** After feature implementation, before release merge.

**Pattern:** Three-tier validation covering component, integration, and end-to-end layers:

**Tier 1 - Component Smoke Tests**:
```bash
# Fast component-level validation
npm run test:smoke-components
# Validates: core functionality, error boundaries, state management
```

**Tier 2 - Integration Smoke Tests**:
```bash
# Service integration validation
npm run test:smoke-integration
# Validates: API endpoints, database operations, external service calls
```

**Tier 3 - End-to-End Smoke Tests**:
```bash
# Full stack workflow validation
npm run test:smoke-e2e
# Validates: user workflows, UI interactions, data persistence
```

### Technique 3: E2E Two-Layer Validation

**When:** Critical workflow changes or major feature releases.

**Pattern:** Two independent E2E test approaches for maximum coverage:

**Layer 1 - Synthetic E2E (Playwright)**:
```bash
# Automated browser-based testing
npm run test:e2e-synthetic
# Validates: UI automation, form workflows, navigation paths
```

**Layer 2 - Manual E2E (Human Validation)**:
```bash
# Human-driven workflow validation
npm run test:e2e-manual-checklist
# Validates: UX quality, edge cases, accessibility, real-world usage
```

### Technique 4: /simplify Maintainability Sweeps

**When:** Before major releases or after significant feature additions.

**Pattern:** Agent-driven codebase simplification to reduce technical debt:

```bash
# Run maintainability sweep agent
myco agent simplify --target=codebase --focus=maintainability

# Specific sweep categories
myco agent simplify --focus=duplication    # Remove code duplication
myco agent simplify --focus=complexity     # Reduce cyclomatic complexity  
myco agent simplify --focus=dependencies   # Optimize dependency usage
myco agent simplify --focus=documentation  # Improve code documentation
```

**Quality gates**:
- No increase in cyclomatic complexity without justification
- Documentation coverage maintained or improved
- Dependency count stable or reduced
- Code duplication within acceptable thresholds

### Pre-Release Quality Integration

Integrate all four techniques into release workflow:

```bash
# Complete pre-release quality validation pipeline
./scripts/pre-release-quality-gate.sh

# Pipeline sequence:
# 1. Multi-tier smoke testing (automated)
# 2. Parallel agent team review (semi-automated)  
# 3. E2E two-layer validation (manual + automated)
# 4. /simplify maintainability sweep (agent-driven)
```

**Release readiness checklist**:
- [ ] All smoke test tiers pass (component, integration, E2E)
- [ ] Parallel agent review completed with consolidated findings
- [ ] E2E validation passed (both synthetic and manual layers)
- [ ] Maintainability sweep completed with no regressions
- [ ] All quality gate findings addressed or justified
- [ ] Release documentation updated with validation results

## Procedure 5: Release Workflow Hardening

Harden release workflows against common failure modes including multi-package publish pitfalls and OIDC auth issues.

### Multi-Project Update Fan-Out Workflow

Grove daemon supports `myco update --all-projects` for machine-scoped update coordination across all Groves:

```bash
# Multi-project update fan-out across all Groves
myco update --all-projects

# This replaces per-project update calls:
# myco update --project /path/to/project1
# myco update --project /path/to/project2
# etc.
```

**Multi-project update quality patterns**:
- **Fan-out validation**: Verify all projects receive updates without errors
- **Failure isolation**: One project failure doesn't block others
- **Resource management**: Bounded concurrency to prevent system overload
- **Machine-scoped coordination**: Updates coordinated at machine level, not per-project

### Grove Multi-Project Update Implementation

Quality validation for machine-scoped update workflows:

```bash
# Validate multi-project update fan-out
npm run test:multi-project-updates

# Test resource management during fan-out
npm run test:update-concurrency-limits

# Validate failure isolation patterns
npm run test:update-failure-isolation
```

### Grove Public Release Readiness

For Grove multi-tenant releases, add public readiness verification:

```bash
# Grove public release readiness checks
./scripts/grove-release-check.sh
```

**Public readiness checklist**:
- Multi-tenant database migrations tested on staging D1
- Project isolation verified (no cross-tenant data leaks)
- Public API endpoints secured with proper tenant validation
- Documentation updated for Grove deployment patterns
- Monitoring/alerting configured for multi-tenant metrics

### Multi-Package Publish Pipeline Hardening

Four hidden failure modes affect monorepo package publishing:

1. **Workspace build order dependencies**: Shared packages must build before consumers
2. **Tag-based workflow triggering**: Use specific package tag patterns: `myco-package/v*.*.*`
3. **Package dependency resolution**: Validate all workspace packages resolve correctly
4. **Publication auth and registry consistency**: Ensure consistent registry configuration

### OIDC Authentication Hardening

GitHub Actions `setup-node@v6` can hijack npm OIDC authentication:

```bash
# Fix OIDC hijacking by removing injected _authToken
sed -i '/_authToken=/d' .npmrc
```

## Procedure 6: CI/CD Pipeline Robustness

Strengthen CI/CD pipelines against npm publish failures, OIDC issues, and npm self-corruption.

### Grove CI/CD Multi-Tenant Enforcement

Add multi-tenant validation to CI/CD pipelines:

```yaml
# GitHub Actions Grove validation
- name: Validate Multi-Tenant Build
  run: |
    npm run test:tenant-isolation
    npm run validate:grove-configs
    npm run test:migration-safety
    npm run test:grove-enforcement
```

### npm Publish CI Pitfalls

Three independent failure modes affect `npm publish` in GitHub Actions:

1. **OIDC auth hijacking**: `setup-node@v6` injects `_authToken` into `.npmrc`, overriding OIDC
2. **npm self-corruption**: `npm install -g npm@latest` in CI corrupts npm's own dependencies
3. **Package propagation delays**: npm registry may have eventual consistency delays

**Fix**: Remove `_authToken` from `.npmrc`, use Node's bundled npm, add retry logic for installs.

### Bun Test Integration

```bash
# Use project's test runner script
node scripts/run-bun-tests.mjs

# Profile-based testing (fast is now default for make build)
MYCO_TEST_PROFILE=fast node scripts/run-bun-tests.mjs
MYCO_TEST_PROFILE=integration node scripts/run-bun-tests.mjs
```

## Procedure 7: Build Artifact Management

Manage build outputs and ensure proper cleanup across workspaces.

### Workspace Build Outputs

1. **Clean build artifacts**:
```bash
# Clean all package dist directories
make clean
# Removes: packages/myco/dist packages/myco-team/dist packages/myco-collective/dist packages/myco-hub/dist packages/myco-shared/dist
```

2. **Validate workspace build order**:
```bash
# Check build dependencies
npm run build
# Builds shared first, then myco, then dependent packages
```

### Cross-Package Dependencies

1. **Verify workspace linking**:
```bash
# Check workspace package references
npm ls --depth=0
grep -r "@goondocks/myco" packages/*/package.json
```

## Procedure 8: Grove Multi-Project Infrastructure Quality

Validate Grove daemon multi-project fan-out patterns, scope iteration infrastructure, and runtime cache management for quality engineering.

### Multi-Project Update Fan-Out Quality Patterns

Grove daemon `myco update --all-projects` requires robust fan-out quality validation:

```bash
# Test multi-project update fan-out under load
npm run test:multi-project-update-fanout

# Validate update isolation and resource management
npm run test:update-concurrency-bounds
```

**Fan-out resource management**:
```typescript
// BAD: Unbounded update fan-out accumulates system pressure
const allProjects = await getAllProjects();
await Promise.all(allProjects.map(project => updateProject(project)));

// GOOD: Bounded update with resource management
const projectChunks = chunk(allProjects, 4); // Process in chunks of 4
for (const chunk of projectChunks) {
  await Promise.all(chunk.map(project => updateProject(project)));
  await new Promise(resolve => setImmediate(resolve));
}
```

### Scope Iterator Validation

Grove daemon uses three-tier scope iterators for multi-project operations:

```bash
# Test Grove scope iteration patterns
npm run test:scope-iterators

# Validate three-tier fan-out: forEachGrove -> forEachProject -> forEachProjectCold
npm run test:multi-project-fanout
```

### Grove Runtime Cache Quality Validation

Grove daemon maintains bounded LRU caches for database and embedding handles:

```bash
# Test Grove runtime cache bounds
npm run test:grove-cache-bounds

# Monitor cache handle accumulation
npm run monitor:grove-handles
```

## Procedure 9: Feature Branch Worktree Quality Engineering

Comprehensive quality validation for feature branch worktree workflows with vendor cache isolation, testing patterns, and provisioning checklist management.

### Worktree Vendor Cache Isolation

Implement vendor cache isolation to prevent cross-branch contamination:

```bash
# Create feature branch with isolated vendor cache
git worktree add ../myco-feature-name feature/feature-name

# Setup isolated npm cache for worktree
cd ../myco-feature-name
export NPM_CONFIG_CACHE="$(pwd)/.npm-cache"
export NODE_MODULES_CACHE="$(pwd)/node_modules"

# Verify cache isolation
npm config get cache
# Should show: /path/to/myco-feature-name/.npm-cache
```

**Vendor cache isolation checklist**:
- Each worktree has isolated `node_modules/` directory
- NPM cache directory (`NPM_CONFIG_CACHE`) is worktree-scoped
- No symlinks between worktree caches
- Package lock files are independent per worktree
- Binary executables in `.bin/` are worktree-specific

### Nested UI Workspace Installation

Install dependencies for nested UI workspaces with proper isolation:

```bash
# Install nested UI workspace dependencies in worktree
for ui_dir in packages/*/ui; do
  if [ -d "$ui_dir" ]; then
    echo "Installing UI workspace: $ui_dir"
    (cd "$ui_dir" && npm ci --cache="$(pwd)/.npm-cache")
    
    # Verify UI workspace isolation
    echo "Checking isolation for $ui_dir"
    (cd "$ui_dir" && npm config get cache)
  fi
done
```

### Cloudflare Worker Package Dependencies

Handle Cloudflare worker package dependencies with proper isolation:

```bash
# Install worker package dependencies with npm ci
for worker_dir in packages/*/worker; do
  if [ -d "$worker_dir" ]; then
    echo "Installing worker dependencies: $worker_dir"
    (cd "$worker_dir" && npm ci --production)
    
    # Verify worker package integrity
    (cd "$worker_dir" && npm audit --audit-level moderate)
  fi
done
```

### Vendor-src libsqlite3 Provisioning

`packages/myco/vendor-src/` is git-ignored — it is NOT copied by git worktree add and does not exist in a fresh worktree. It holds the compiled `libsqlite3` artifact that Bun-compiled binaries embed via `import ... with { type: "file" }`. Build the host target explicitly before relying on `make dev-build`/`make build`:

```bash
# Provision vendor-src/libsqlite3 for the host target in a new worktree
bash packages/myco/scripts/build-libsqlite3-target.sh $(HOST_TARGET)
# Cached after first run — reuses the fetched sqlite amalgamation tarball
```

### Native Vendor Cache Manual Copy

Manually copy native vendor cache for cross-platform compatibility:

```bash
# Manual native vendor cache copy for worktree setup
MAIN_CACHE_DIR="../myco-main/node_modules/.cache"
WORKTREE_CACHE_DIR="$(pwd)/node_modules/.cache"

if [ -d "$MAIN_CACHE_DIR" ]; then
  echo "Copying native vendor cache..."
  mkdir -p "$WORKTREE_CACHE_DIR"
  
  # Copy native binaries and compilation cache
  cp -r "$MAIN_CACHE_DIR/esbuild" "$WORKTREE_CACHE_DIR/" 2>/dev/null || true
  cp -r "$MAIN_CACHE_DIR/better-sqlite3" "$WORKTREE_CACHE_DIR/" 2>/dev/null || true
  cp -r "$MAIN_CACHE_DIR/@rollup" "$WORKTREE_CACHE_DIR/" 2>/dev/null || true
  
  echo "Native vendor cache copied successfully"
fi
```

### MCP/Capture Wiring Setup

Initialize MCP and capture system for worktree development:

```bash
# Initialize MCP/capture wiring for worktree
myco-dev init --worktree

# Verify MCP server configuration
if [ -f ".myco/mcp-config.json" ]; then
  echo "MCP configuration found"
  cat .myco/mcp-config.json | jq '.servers | keys'
else
  echo "Warning: MCP configuration not found"
fi

# Test capture system connectivity
myco-dev test-capture --worktree
```

### Isolated Smoke Testing Patterns

Implement isolated smoke testing for worktree development:

```bash
# Run isolated smoke tests in worktree environment
export MYCO_TEST_ISOLATION=true
export MYCO_WORKTREE_ID="$(basename $(pwd))"

# Isolated component smoke tests
npm run test:smoke-components --isolation

# Isolated integration smoke tests  
npm run test:smoke-integration --worktree="$MYCO_WORKTREE_ID"

# Isolated end-to-end smoke tests
npm run test:smoke-e2e --isolation --worktree="$MYCO_WORKTREE_ID"
```

### Worktree Testing Patterns

Implement comprehensive testing patterns for worktree-isolated development:

```bash
# Test suite validation across multiple worktrees
./scripts/test-worktree-isolation.sh

# Run tests in parallel across worktrees
parallel --bar 'cd ../myco-{} && npm test' ::: main feature-auth feature-db

# Isolated test database per worktree
export MYCO_TEST_DB_PATH="$(pwd)/.myco/test.db"
export MYCO_VAULT_DIR="$(pwd)/.myco"
```

### Feature Branch Provisioning Checklist

```bash
# Automated feature branch provisioning script
./scripts/provision-feature-branch.sh feature-name

# Manual provisioning steps
git worktree add ../myco-feature-name feature/feature-name
cd ../myco-feature-name
npm install && npm run build && npm test
```

**Feature branch provisioning checklist**:
- [ ] Git worktree created successfully: `../myco-feature-name`
- [ ] Vendor-src libsqlite3 provisioned: `bash packages/myco/scripts/build-libsqlite3-target.sh $(HOST_TARGET)` (git-ignored, not copied by worktree add)
- [ ] NPM cache isolation configured: `NPM_CONFIG_CACHE`
- [ ] Dependencies installed: `npm install` completed
- [ ] Nested UI workspaces installed: UI-specific `npm ci` completed  
- [ ] Cloudflare worker dependencies installed: Worker-specific `npm ci` completed
- [ ] Native vendor cache copied: Manual cache copy from main worktree
- [ ] MCP/capture wiring initialized: `myco-dev init --worktree` completed
- [ ] Build artifacts generated: `npm run build` passed
- [ ] Isolated smoke tests pass: All smoke test tiers green with isolation
- [ ] Test suite passes: `npm test` all green (fast profile by default)
- [ ] Vendor cache isolated: no cross-worktree contamination
- [ ] Database isolation verified: `.myco/test.db` is worktree-scoped
- [ ] Configuration isolation: `.myco/config.yaml` is worktree-specific

### Worktree Quality Gate Integration

Integrate worktree quality validation into standard quality gates:

```bash
# Multi-worktree build validation
make build-all-worktrees

# Validates: all worktrees build successfully, no cross-contamination
for worktree in ../myco-*; do
  echo "Building $worktree..."
  (cd "$worktree" && make build) || exit 1
done
```

## Cross-Cutting Gotchas

### Build System Pitfalls
- **Silent bundler failures**: Always validate that `npm run build` actually created expected artifacts in each workspace
- **Native dependency conflicts**: Use `npm rebuild` after Node version changes or branch switches
- **Tree-shaking fragility**: Value imports of type helpers contaminate package bundles and break platform boundaries - use type-only imports
- **Platform boundary contamination**: Cross-package value imports break tree-shaking and create platform-specific build failures
- **Fast profile assumptions**: Remember `make build` now uses fast profile by default - use `make build-all` for comprehensive CI validation
- **`make dev-build` requires daemon restart**: `make dev-build` compiles the Bun binary to `packages/myco-$(HOST_TARGET)/bin/` but does not reload the running daemon. After a rebuild, run `myco-dev restart` to pick up the new binary.
- **Cross-variant artifact thrash**: `make build-all` compiles all platform targets. During development iteration, use `make dev-build` (host target only) to avoid building artifacts for platforms that cannot run on the local machine.
- **Binary recompilation can trigger launchd KeepAlive throttle**: `packages/myco/scripts/clean-core.mjs` (run by `npm run build` and `npm run build:binaries`) removes build artifacts before recompiling. If the launchd daemon service monitors the binary output path, the temporary absence triggers KeepAlive respawn attempts. Under rapid successive rebuilds launchd may enter throttle mode. Recovery: `launchctl kickstart -k gui/$(id -u)/com.myco.daemon` after the build completes.
- **`npm allow-scripts` silently blocks postinstall binary convergence**: If an `allow-scripts` policy blocks postinstall hooks, `packages/myco/scripts/select-binary.mjs` won't run and npm exits 0 without error. The binary appears installed but may be wrong for the platform. Check for `allow-scripts` warnings in install output or run `cd packages/myco && node scripts/select-binary.mjs` manually.

### Gate Integrity Pitfalls
- **EXPLAIN QUERY PLAN step-count pinning is platform-fragile**: a gate pinning an exact query-plan step count passes on macOS dev and fails in Linux CI for the same code (Myco 2.0 Plan 2 cost gate, `tests/myco-server/kinds.test.ts`). Assert on index usage (no table scan), not an exact step count.
- **Gates must exercise the deployed entry, and narrowing a gate can silently widen the hole it guards**: a route-auth gate passed while calling an internal request-handler factory instead of the deployed worker entry (which skips middleware the real entry applies); separately, replacing a raw-row gate with a new precondition to fix one failure changed what the gate verifies. Exercise the actual exported handler and re-derive gate coverage after any precondition change.
- **Migration gates that read from the source file, not deployed state, can be spoofed**: editing an already-applied migration step in place and re-emitting it passed verification because gates compared source-to-source instead of source-to-deployed ledger. Verify against actual applied/deployed state. Relatedly, a trailing-slash off-by-one in path slicing (`slice(SRC.length + 1)` on a `SRC` already ending in a slash) can eat the first character of every relative path so no allowlist pattern matches — the gate reports success while checking zero real paths; assert a non-zero file count, not just absence of errors.
- **Planted-negative mutate-restore must not use `git checkout -- <file>`**: it restores from the INDEX, and during a long change the index is usually stale — the "restore" silently reverts real uncommitted work instead of just the test mutation. Snapshot the file before mutating and restore from that snapshot.
- **Worker rollout windows are fail-closed, and `wrangler dev` body-drain is a local-only artifact**: `packages/myco-server/worker/src/auth/tokens.ts:80` strict-equality-checks the stored schema version, throwing a schema-mismatch 503 on any mid-rollout version skew rather than degrading gracefully; separately, `wrangler dev` (4.123, miniflare) throws a network-connection-lost error and exits when a request body never completes — validate incomplete-body handling against a real Cloudflare deployment, not `wrangler dev`. Separately, `String.fromCharCode(...bytes)` spread-argument limits diverge between Bun/JSC and Node/V8-workerd (the production runtime): Bun/JSC tolerates a far larger spread before `RangeError` than Node/V8, which throws around 100,000 arguments — a byte-to-string decode via spread can pass locally on Bun and fail in deployed workerd, so chunk below ~100k arguments or use a non-spread decode path (e.g., `Buffer`/`TextDecoder`).

### Generated Artifact Traps
- **Task definition YAML edits require manual codegen — CI does not catch the gap**: Editing a task definition YAML (e.g., `packages/myco/src/agent/definitions/tasks/skill-evolve.yaml`) does NOT take effect until `npm run codegen` regenerates `packages/myco/src/agent/definitions.generated.ts`. CI does not validate that the generated file matches the source YAML, so a forgotten codegen step ships a stale agent definition silently.
- **`packages/myco/src/ui-assets.generated.ts` stale-binary trap**: `packages/myco/scripts/build-single-target.mjs` (invoked via `npm run build:binary`) bundles `packages/myco/src/ui-assets.generated.ts` AS CHECKED IN — it does not rebuild the UI. Deploying a rig/dogfood binary after reverting or resetting that file (e.g., `git checkout --`) ships the OLD dashboard silently. The file is tracked and must be deliberately regenerated-and-committed in any PR that changes the dashboard UI, since CI's check job and any bare `build:binary` consume the committed copy, not a fresh build.
- **UI typecheck gate gap**: Bun's test runner strips TypeScript types before execution, so `npx tsc --noEmit` errors in `packages/myco/ui` were invisible to CI — there was no dedicated UI typecheck step. Closed by adding `packages/myco/ui/tsconfig.typecheck.json` as a UI-only typecheck boundary plus ambient module declarations for backend modules imported by UI source. Caution: bodyless ambient declarations can mask stale imports and silently erase the exact errors the gate is meant to catch — prefer precise ambient signatures over blanket `declare module '*'` shims.

### Release Workflow Traps
- **npm global installations in CI**: Never `npm install -g npm@latest` - corrupts npm's dependencies
- **Cross-compile assumptions**: Verify all target binaries are created and functional before release
- **Version string testing**: Hardcoded version assertions break on every release - use pattern matching
- **OIDC auth hijacking**: `setup-node@v6` overrides OIDC with token auth - strip `_authToken` from `.npmrc`

### Workspace Management Hazards
- **Lockfile drift**: Nested UI workspaces can create lockfile synchronization issues in git worktrees
- **Audit fix mutations**: `npm audit fix` can introduce unexpected dependency changes - track with git status
- **Build order dependencies**: Shared packages must build before consumers - verify workspace build sequence
- **Dependabot PR accumulation**: Batch multiple Dependabot PRs to reduce testing overhead and merge conflicts
- **`git mv` strands gitignored operational files**: Moving a package directory with `git mv` (e.g. the `packages/myco-server/worker/` → `packages/myco-server/` restructure) only relocates tracked files — gitignored operational files stay behind at the old path, and `git status` shows a clean tree while production is broken. Check `git status --ignored` at the old path before trusting a clean status.

### Test Isolation Hazards
- **MYCO_HOME isolation required**: Any test that touches MYCO_HOME (config loading, grove paths, service directories) must use `sandboxMycoHome()` from `tests/helpers/myco-home-sandbox.ts`. Without isolation, tests write to the real developer home directory and can corrupt live daemon state or config.

### Grove Multi-Tenant Hazards
- **Tenant isolation failures**: Build artifacts must not leak data between projects - validate scoping
- **Configuration contamination**: Project-specific configs can pollute shared components - use explicit tenant context
- **Database migration conflicts**: Multi-tenant schema changes require careful ordering and rollback procedures
- **Public release readiness**: Grove deployments need additional validation for tenant security and isolation
- **Grove enforcement bypassing**: Multi-tenant enforcement patterns can be circumvented without proper validation gates
- **Cross-project contamination**: Grove activation can introduce cross-project dependencies without proper isolation checks
- **Scope iterator misuse**: Direct project iteration bypasses cold gating and can process inactive projects
- **Cache handle leaks**: Unbounded handle accumulation without proper LRU bounds degrades Grove daemon performance
- **Multi-project update failures**: `--all-projects` fan-out can overwhelm system resources without proper chunking and resource management
- **Update isolation breakdown**: One failed project update can cascade to others without proper failure isolation patterns

### Worktree Quality Hazards
- **Vendor cache contamination**: Shared npm cache between worktrees causes dependency conflicts and version mismatches
- **Test database collision**: Shared test databases create race conditions and test failures across worktrees
- **Cleanup failures**: Incomplete worktree cleanup leaves orphaned artifacts and cache directories
- **Resource exhaustion**: Unbounded worktree creation overwhelms disk space and system handles
- **Build artifact conflicts**: Cross-worktree build artifacts contaminate each other causing build failures
- **Nested UI workspace cache conflicts**: UI workspace npm caches contaminate each other across worktrees
- **Worker package dependency drift**: Cloudflare worker dependencies misalign between worktrees causing deployment failures
- **Native vendor cache staleness**: Outdated native cache causes compilation failures in fresh worktrees
- **MCP/capture wiring failures**: Incomplete MCP setup breaks development workflow and capture functionality
- **Smoke test isolation breakdown**: Non-isolated smoke tests pollute each other causing false failures

### Pre-Release Quality Validation Hazards
- **Agent review isolation**: Parallel agent reviews may conflict if run in same working directory
- **Smoke test layer skipping**: Bypassing any of the three smoke test tiers can miss critical failure modes
- **E2E test environment drift**: Manual and synthetic E2E environments diverging causes inconsistent validation
- **Maintainability sweep regression**: /simplify sweeps may introduce bugs while reducing complexity
- **Quality gate ordering**: Running validation techniques in wrong sequence can mask issues
- **Review consolidation failures**: Parallel agent findings may conflict without proper consolidation
