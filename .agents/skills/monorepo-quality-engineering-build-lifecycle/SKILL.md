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

### npm Publish Safety

1. **Pre-publication validation**:
```bash
# Validate package structure
npm pack --dry-run
tar -tzf *.tgz | head -20  # Preview package contents

# Validate dependencies are resolved
npm ls --production
```

2. **Workspace build orchestration** follows proper sequence:
```bash
# Root package.json build script order:
# 1. shared package first
# 2. core myco package
# 3. dependent packages (team, collective, hub)
npm run build
```

## Procedure 5: CI/CD Pipeline Robustness

Strengthen CI/CD pipelines against npm publish failures, OIDC issues, and npm self-corruption.

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

## Cross-Cutting Gotchas

### Build System Pitfalls
- **Silent bundler failures**: Always validate that `npm run build` actually created expected artifacts in each workspace
- **Native dependency conflicts**: Use `npm rebuild` after Node version changes or branch switches
- **Workspace hoisting issues**: Some packages may need explicit dependencies even if available in root

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
