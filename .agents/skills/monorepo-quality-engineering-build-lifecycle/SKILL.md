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

Establish and maintain the distinction between comprehensive build validation (`make build`) versus bundler-only builds (`npm run build`).

### Build Orchestration Strategy

The `make build` workflow provides comprehensive validation:
```bash
# Full quality gate pipeline
make build
# Executes: make check, then npm run build
# Where check = lint + test
```

Versus bundler-only build:
```bash
# Bundler only - skips type checking and tests
npm run build
```

### Implementing Quality Gates

1. **Review Makefile targets** to ensure proper orchestration:
```bash
grep -A 10 "^build:" Makefile
```

2. **Validate stage dependencies** - each stage should fail fast:
   - TypeScript compilation via `tsc --noEmit` in lint
   - Test execution via `node scripts/run-bun-tests.mjs`
   - Bundler compilation via workspace builds
   - Worker validation via `npm run check:workers`

3. **Prevent silent quality failures** in release workflows:
   - Always use `make build` in CI/CD, never `npm run build`
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
npm test              # full test suite
npm run test:fast     # fast profile only
npm run build         # workspace builds only
```

## Procedure 2: Cross-platform Build Validation

Validate artifacts and handle platform-specific native dependencies across build matrices.

### Artifact Validation Patterns

1. **Cross-compile validation**:
```bash
# Validate binary artifacts are created
ls -la dist/bin/
file dist/bin/myco-*  # Check binary format
```

2. **Platform-specific dependency handling**:
```bash
# Handle native dependency conflicts with force flags
npm install --force
# Or rebuild native modules after branch switches
npm rebuild
```

### Tree-Shaking Quality Validation

Tree-shaking can introduce subtle build failures when value imports contaminate package boundaries:

1. **Detect tree-shaking fragility**:
```bash
# Check for value imports of type helpers across package boundaries
grep -r "import.*{.*}" packages/myco-*/src/ | grep -v "type.*{.*}"
# Look for non-type imports that should be type-only
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

## Procedure 4: Release Workflow Hardening

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

**Multi-project update validation checklist**:
- All registered projects in all Groves receive updates
- Failed updates in one project don't block others
- Resource usage stays within system limits during fan-out
- Update status reporting aggregates across all projects
- Machine-scoped runtime.command updates apply consistently

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
- Grove multi-tenant enforcement patterns validated across all package builds

### Package Version Management

1. **Detect hardcoded version references**:
```bash
# Search for potential hardcoded versions
grep -r "0\.[0-9][0-9]\.[0-9]" . --exclude-dir=node_modules --exclude-dir=.git
```

2. **Dynamic version reading patterns**:
```typescript
// BAD: Hardcoded version
expect(version).toBe('0.22.0')

// GOOD: Dynamic version reading
import { version } from '../package.json'
expect(version).toMatch(/^\d+\.\d+\.\d+/)
```

### Multi-Package Publish Pipeline Hardening

Four hidden failure modes affect monorepo package publishing:

1. **Workspace build order dependencies**:
   - Shared packages must build before consumers
   - Verify workspace build sequence in package.json scripts
   - Use `npm ls --depth=0` to validate workspace linking

2. **Tag-based workflow triggering**:
   - Use specific package tag patterns: `myco-package/v*.*.*`
   - Verify workflow triggers at HEAD match tagged commit
   - Check for workflow file presence in tagged commit

3. **Package dependency resolution**:
   - Validate all workspace packages resolve correctly
   - Use `npm pack --dry-run` to preview package contents
   - Check for missing dependencies with `npm ls --production`

4. **Publication auth and registry consistency**:
   - Ensure consistent registry configuration across packages
   - Handle scoped package permissions correctly
   - Test publish permissions with dry-run before actual release

### OIDC Authentication Hardening

GitHub Actions `setup-node@v6` can hijack npm OIDC authentication:

1. **Detect OIDC override**:
```bash
# Check for _authToken injection in .npmrc
cat .npmrc | grep _authToken
```

2. **Fix OIDC hijacking**:
```yaml
# In GitHub Actions workflow, after setup-node:
- name: Strip authToken for OIDC
  run: |
    # Remove injected _authToken line to enable OIDC
    sed -i '/_authToken=/d' .npmrc
    cat .npmrc  # Verify removal
```

3. **Verify OIDC functionality**:
```bash
# Test npm authentication without tokens
npm whoami  # Should work with OIDC, not token auth
```

## Procedure 5: CI/CD Pipeline Robustness

Strengthen CI/CD pipelines against npm publish failures, OIDC issues, and npm self-corruption.

### Grove CI/CD Multi-Tenant Enforcement

Add multi-tenant validation to CI/CD pipelines:

```yaml
# GitHub Actions Grove validation
- name: Validate Multi-Tenant Build
  run: |
    # Test tenant isolation
    npm run test:tenant-isolation
    
    # Validate project-scoped configs
    npm run validate:grove-configs
    
    # Test database migration safety
    npm run test:migration-safety
    
    # Validate Grove enforcement patterns
    npm run test:grove-enforcement
```

**Grove CI/CD enforcement patterns**:
- Project-scoped build artifact validation
- Multi-tenant database schema safety checks
- Cross-project isolation boundary testing
- Grove-specific configuration validation
- Tenant security and access control verification

### Pipeline Error Patterns

1. **Comprehensive error capture**:
```bash
# Set strict error handling
set -euo pipefail

# Capture and log errors with context
trap 'echo "Error on line $LINENO. Exit code: $?"' ERR
```

2. **npm Global Installation Gotcha**:
```bash
# BAD: Never upgrade npm in CI - corrupts dependencies
# npm install -g npm@latest

# GOOD: Use Node.js bundled npm version
# Node 22's bundled npm 10.x already supports OIDC
which npm
npm --version
```

### npm Publish CI Pitfalls

Three independent failure modes affect `npm publish` in GitHub Actions:

1. **OIDC auth hijacking**:
   - `setup-node@v6` injects `_authToken=${NODE_AUTH_TOKEN}` into `.npmrc`
   - This overrides npm's native OIDC trusted publisher flow
   - Symptoms: 401 Unauthorized even with correct OIDC setup
   - Fix: Remove `_authToken` line from `.npmrc` before publish

2. **npm self-corruption**:
   - `npm install -g npm@latest` in CI corrupts npm's own dependencies
   - Node's bundled npm already supports needed features (OIDC)
   - Symptoms: npm commands fail with module resolution errors
   - Fix: Never upgrade npm globally in CI environments

3. **Package propagation delays**:
   - npm registry may have eventual consistency delays
   - Dependent installs may fail immediately after publish
   - Symptoms: 404 errors on `npm install` right after successful publish
   - Fix: Add retry logic or brief delays for dependent installs

### Bun Test Integration

1. **Test runner configuration**:
```bash
# Use project's test runner script
node scripts/run-bun-tests.mjs

# Profile-based testing
MYCO_TEST_PROFILE=fast node scripts/run-bun-tests.mjs
MYCO_TEST_PROFILE=integration node scripts/run-bun-tests.mjs
```

## Procedure 6: Build Artifact Management

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

## Procedure 7: Grove Multi-Project Infrastructure Quality

Validate Grove daemon multi-project fan-out patterns, scope iteration infrastructure, and runtime cache management for quality engineering.

### Multi-Project Update Fan-Out Quality Patterns

Grove daemon `myco update --all-projects` requires robust fan-out quality validation:

1. **Update fan-out validation**:
```bash
# Test multi-project update fan-out under load
npm run test:multi-project-update-fanout

# Validate update isolation and resource management
npm run test:update-concurrency-bounds
```

2. **Fan-out resource management**:
```typescript
// BAD: Unbounded update fan-out accumulates system pressure
const allProjects = await getAllProjects();
await Promise.all(allProjects.map(project => updateProject(project)));

// GOOD: Bounded update with resource management
const projectChunks = chunk(allProjects, 4); // Process in chunks of 4
for (const chunk of projectChunks) {
  await Promise.all(chunk.map(project => updateProject(project)));
  // Allow system recovery between chunks
  await new Promise(resolve => setImmediate(resolve));
}
```

**Multi-project update fan-out patterns**:
- **Chunked processing**: Break large update fan-outs into manageable chunks
- **Failure isolation**: One project failure doesn't block others
- **Resource relief points**: Allow system recovery between update chunks
- **Progress reporting**: Aggregate update status across all projects
- **Bounded concurrency**: Limit concurrent updates to prevent system overload

### Scope Iterator Validation

Grove daemon uses three-tier scope iterators for multi-project operations. Validate proper implementation:

1. **Scope iterator testing**:
```bash
# Test Grove scope iteration patterns
npm run test:scope-iterators

# Validate three-tier fan-out: forEachGrove -> forEachProject -> forEachProjectCold
npm run test:multi-project-fanout
```

2. **Scope iterator patterns**:
```typescript
// Validate proper scope iteration implementation
import { forEachGrove, forEachProject, forEachProjectCold } from './scope-iteration';

// BAD: Direct iteration without cold gating
projects.forEach(project => processProject(project));

// GOOD: Proper scope iteration with cold gating
await forEachProjectCold(cache, logger, async (projectId, projectRoot) => {
  await processProject(projectId, projectRoot);
}, { maxConcurrency: 4 });
```

### Grove Runtime Cache Quality Validation

Grove daemon maintains bounded LRU caches for database and embedding handles. Validate cache behavior:

1. **Cache bounds validation**:
```bash
# Test Grove runtime cache bounds
npm run test:grove-cache-bounds

# Monitor cache handle accumulation
npm run monitor:grove-handles
```

2. **Cache invalidation patterns**:
```typescript
// Validate proper cache invalidation on config changes
// BAD: Unbounded handle accumulation
const dbHandle = await openDatabase(projectRoot);

// GOOD: Bounded LRU with re-resolution
const dbHandle = await cache.resolveDatabase(projectId, projectRoot);
```

## Procedure 8: Feature Branch Worktree Quality Engineering

Comprehensive quality validation for feature branch worktree workflows with vendor cache isolation, testing patterns, and provisioning checklist management.

### Worktree Vendor Cache Isolation

Implement vendor cache isolation to prevent cross-branch contamination in feature workflows:

1. **Isolated vendor cache setup**:
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

2. **Vendor cache validation patterns**:
```bash
# Validate vendor cache isolation between worktrees
find ../myco-* -name "node_modules" -type d
find ../myco-* -name ".npm-cache" -type d

# Check for cache cross-contamination
ls -la ../myco-main/node_modules/.bin/ 
ls -la ../myco-feature-name/node_modules/.bin/
# Should contain different/isolated executables
```

**Vendor cache isolation checklist**:
- Each worktree has isolated `node_modules/` directory
- NPM cache directory (`NPM_CONFIG_CACHE`) is worktree-scoped
- No symlinks between worktree caches
- Package lock files are independent per worktree
- Binary executables in `.bin/` are worktree-specific

### Worktree Testing Patterns

Implement comprehensive testing patterns for worktree-isolated development:

1. **Cross-worktree test validation**:
```bash
# Test suite validation across multiple worktrees
./scripts/test-worktree-isolation.sh

# Run tests in parallel across worktrees
parallel --bar 'cd ../myco-{} && npm test' ::: main feature-auth feature-db

# Validate test database isolation
parallel --bar 'cd ../myco-{} && npm run test:db-isolation' ::: main feature-auth
```

2. **Worktree test isolation patterns**:
```bash
# Isolated test database per worktree
export MYCO_TEST_DB_PATH="$(pwd)/.myco/test.db"
export MYCO_VAULT_DIR="$(pwd)/.myco"

# Validate test isolation
npm run test:parallel-worktree
# Should pass without test database conflicts
```

**Worktree testing validation checklist**:
- Test databases are worktree-scoped (no shared `.myco/test.db`)
- Test artifacts don't cross-contaminate between branches
- Parallel test runs across worktrees don't conflict
- Test coverage reports are worktree-isolated
- Mock services use worktree-specific ports

### Feature Branch Provisioning Checklist

Comprehensive provisioning checklist for feature branch worktree setup:

1. **Worktree provisioning automation**:
```bash
# Automated feature branch provisioning script
./scripts/provision-feature-branch.sh feature-name

# Manual provisioning steps
git worktree add ../myco-feature-name feature/feature-name
cd ../myco-feature-name
npm install
npm run build
npm test
```

2. **Provisioning validation checklist**:
```bash
# Validate complete worktree provisioning
./scripts/validate-worktree-setup.sh ../myco-feature-name
```

**Feature branch provisioning checklist**:
- [ ] Git worktree created successfully: `../myco-feature-name`
- [ ] NPM cache isolation configured: `NPM_CONFIG_CACHE`
- [ ] Dependencies installed: `npm install` completed
- [ ] Build artifacts generated: `npm run build` passed
- [ ] Test suite passes: `npm test` all green
- [ ] Vendor cache isolated: no cross-worktree contamination
- [ ] Database isolation verified: `.myco/test.db` is worktree-scoped
- [ ] Configuration isolation: `.myco/config.yaml` is worktree-specific
- [ ] Binary executables isolated: `node_modules/.bin/` is worktree-scoped
- [ ] Service ports available: no conflicts with main branch services
- [ ] Development environment variables set correctly
- [ ] Grove context configured if applicable

### Worktree Quality Gate Integration

Integrate worktree quality validation into standard quality gates:

1. **Worktree-aware build validation**:
```bash
# Multi-worktree build validation
make build-all-worktrees

# Validates: all worktrees build successfully, no cross-contamination
for worktree in ../myco-*; do
  echo "Building $worktree..."
  (cd "$worktree" && make build) || exit 1
done
```

2. **Worktree cleanup validation**:
```bash
# Cleanup validation for removed worktrees
./scripts/cleanup-worktree-artifacts.sh feature-name

# Remove worktree and validate cleanup
git worktree remove ../myco-feature-name
rm -rf ../myco-feature-name/.npm-cache
```

**Worktree quality patterns**:
- **Isolation verification**: No shared artifacts between worktrees
- **Cleanup validation**: Complete artifact removal on worktree deletion
- **Parallel safety**: Multiple worktrees can build/test simultaneously
- **Resource management**: Worktree creation doesn't exhaust system resources
- **Cache efficiency**: Vendor cache isolation balanced with disk usage

## Cross-Cutting Gotchas

### Build System Pitfalls
- **Silent bundler failures**: Always validate that `npm run build` actually created expected artifacts in each workspace
- **Native dependency conflicts**: Use `npm rebuild` after Node version changes or branch switches
- **Workspace hoisting issues**: Some packages may need explicit dependencies even if available in root
- **Tree-shaking fragility**: Value imports of type helpers contaminate package bundles and break platform boundaries - use type-only imports
- **Platform boundary contamination**: Cross-package value imports break tree-shaking and create platform-specific build failures

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
- **Port conflicts**: Multiple worktree development servers bind to same ports causing service startup failures
- **Configuration leaks**: Shared configuration files pollute worktree-specific settings
- **Cleanup failures**: Incomplete worktree cleanup leaves orphaned artifacts and cache directories
- **Resource exhaustion**: Unbounded worktree creation overwhelms disk space and system handles
- **Build artifact conflicts**: Cross-worktree build artifacts contaminate each other causing build failures