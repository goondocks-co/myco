---
name: myco:runtime-environment-binary-management
description: |
  Procedures for managing binary dispatch, runtime environment resolution, and machine-scoped coordination in Myco deployments. Covers layered runtime command resolution (~/.myco/runtime.command pins, project overrides, fallback chains), machine-scoped runtime architecture, binary masquerade detection and prevention, update coordination protocols, and Bun compilation deployment patterns. Use when setting up environments, troubleshooting binary dispatch issues, managing machine-scoped coordination, or implementing system updates, even if the user doesn't explicitly ask for runtime environment management.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Runtime Environment and Binary Management

Comprehensive procedures for managing Myco's binary dispatch system, runtime environment resolution, and machine-scoped coordination. These procedures ensure reliable binary execution, prevent environment conflicts, and maintain proper isolation across different deployment contexts in the Grove multi-project daemon architecture.

**Architectural shift**: Myco now operates on a **global-first, machine-scoped model** where the machine opts into projects rather than projects configuring themselves. This invertsthe traditional project-centric configuration model — global hooks capture everywhere, runtime configuration is machine-scoped by default, and unknown projects operate in quarantine mode until explicitly registered.

## Prerequisites

- Myco installation with proper symbiont structure
- Understanding of Myco's Grove multi-project daemon architecture (packages/myco/src/daemon/)
- Access to runtime configuration files (~/.myco/runtime.command, project-level configs)
- Familiarity with Bun compilation and single-file binary patterns
- Knowledge of Grove registration and project binding patterns
- Understanding of machine-scoped opt-in model and global capture hooks

## Procedure A: Runtime Command Resolution and Fallback Management

Configure and debug the layered runtime command resolution system with Grove multi-project support and machine-scoped coordination.

### Machine-Scoped Global Runtime Pins

The machine now maintains global runtime configuration that applies to all projects unless explicitly overridden. This supports the global-first model where hooks are installed globally and capture everywhere.

1. **Check machine-wide runtime pin** (primary configuration source):
   ```bash
   cat ~/.myco/runtime.command
   ```

2. **Set machine-wide pin** (affects all projects on the machine):
   ```bash
   echo "/path/to/preferred/myco/binary" > ~/.myco/runtime.command
   ```

3. **Validate pin target** (ensure the pinned binary exists and is executable globally):
   ```bash
   ls -la $(cat ~/.myco/runtime.command)
   # Verify binary works across project boundaries
   $(cat ~/.myco/runtime.command) --version
   ```

### Global Hook Capture Configuration

In the global-first model, hooks are installed machine-wide and capture activity from all projects. Runtime resolution must account for this global capture architecture.

1. **Verify global hook installation** (hooks should be machine-wide, not project-specific):
   ```bash
   # Check for global hook configuration
   ls -la ~/.myco/hooks/
   # Verify hooks point to correct runtime binary
   grep -r "runtime.command\|myco" ~/.myco/hooks/
   ```

2. **Configure global capture environment**:
   ```bash
   # Ensure global hooks use machine-scoped runtime
   myco hooks install --global
   # Verify all symbionts use machine runtime
   myco symbionts list --check-runtime
   ```

### Project-Level Override Patterns (Legacy/Exception Cases)

While the machine-scoped model is primary, some projects may need specific binary versions for compatibility.

1. **Check project-level runtime configuration** (should be rare in global-first model):
   ```bash
   # Look for project-specific runtime overrides (legacy pattern)
   find .myco/ -name "runtime.command" -o -name "*.runtime.conf"
   ```

2. **Implement project override** (only when machine-wide config is insufficient):
   ```bash
   # Project-level pin takes precedence over machine-wide (legacy support)
   echo "/project/specific/myco/binary" > .myco/runtime.command
   # Note: This breaks global-first model; use sparingly
   ```

### Global-First Fallback Chain Validation

The fallback chain now prioritizes machine-scoped configuration over project-specific settings, supporting the global capture architecture.

1. **Test global-first resolution order**:
   ```bash
   # Verify resolution order: project (rare) → machine (primary) → PATH (fallback)
   myco doctor --runtime-resolution
   which myco
   echo $PATH | tr ':' '\n' | grep myco
   ```

2. **Debug resolution failures in global context**:
   ```bash
   # Check each step of the global-first fallback chain
   [ -f .myco/runtime.command ] && echo "Project pin (legacy): $(cat .myco/runtime.command)"
   [ -f ~/.myco/runtime.command ] && echo "Machine pin (primary): $(cat ~/.myco/runtime.command)"
   which myco || echo "No myco in PATH (fallback)"
   
   # Verify global hooks point to correct runtime
   myco doctor --global-hooks
   ```

## Procedure B: Machine-Scoped Runtime Architecture

Manage machine-scoped service coordination and runtime environment resolution with global capture hooks and project quarantine mode.

### Grove Global Daemon with Machine-Scoped Runtime

1. **Check Grove daemon runtime source status** (should reflect machine-wide configuration):
   ```bash
   # Check daemon runtime source via API (Grove global daemon)
   curl -s http://127.0.0.1:20915/api/stats | jq '.runtime'
   # Verify machine-scoped settings are active
   myco doctor --machine-scope
   ```

2. **Verify machine-scoped configuration with global capture**:
   ```bash
   # Validate machine-level runtime settings for global operation
   ls -la ~/.myco/runtime.command
   myco doctor # Should report runtime source information for all projects
   # Verify global hooks are properly configured
   myco hooks status --all-projects
   ```

### Global Capture and Project Quarantine Mode

In the global-first model, hooks capture from all projects but unknown projects operate in quarantine mode until explicitly registered.

1. **Check global capture status**:
   ```bash
   # Verify hooks capture from all active projects
   myco capture status --global
   # List projects in quarantine mode
   myco projects list --quarantined
   ```

2. **Manage quarantine mode for unknown projects**:
   ```bash
   # Register project to remove from quarantine
   myco projects register /path/to/project
   # Verify project exits quarantine and uses machine runtime
   cd /path/to/project
   myco --version # Should match machine-wide runtime
   myco status # Should show "registered" not "quarantined"
   ```

### Multi-Project Grove Coordination with Machine-First Model

1. **Test cross-Grove runtime consistency** (machine runtime applies to all registered projects):
   ```bash
   # Verify that machine runtime applies across all registered projects
   myco groves list # List all registered Groves
   # Test runtime consistency across projects
   for project in $(myco projects list --registered); do
     echo "Testing runtime for: $project"
     cd "$project"
     myco --version
   done
   ```

2. **Manage machine-scoped updates across all projects**:
   ```bash
   # Update all projects via machine-scoped coordination
   myco update --machine-wide
   # Verify all registered projects use updated runtime
   myco projects verify-runtime --all
   ```

### Global Hook Registration and Project Opt-In

1. **Validate global hook coverage**:
   ```bash
   # Check that global hooks cover all registered projects
   myco hooks verify-coverage --all-projects
   # Test hook functionality across project boundaries
   myco hooks test --sample-projects
   ```

2. **Handle project registration flow**:
   ```bash
   # Register new project (moves from quarantine to active)
   myco projects register /path/to/new/project
   # Verify project inherits machine-scoped runtime
   cd /path/to/new/project
   myco status # Should show global hook coverage
   myco --version # Should match machine runtime
   ```

## Procedure C: Binary Masquerade Detection and Prevention

Detect and prevent binary dispatch conflicts between published and development versions across the global capture boundary.

### Machine-Scoped Version Detection

1. **Verify binary authenticity across global scope**:
   ```bash
   # Check binary version and source for machine-wide operation
   myco --version
   which myco
   file $(which myco) # Check if it's a compiled binary or script
   
   # Verify consistency across all registered projects
   myco projects verify-binary --all
   ```

2. **Detect masquerade scenarios in global context**:
   ```bash
   # Compare expected vs actual binary paths across projects
   realpath $(which myco)
   # Check for unexpected symlinks or wrappers affecting global hooks
   ls -la $(dirname $(which myco))/myco*
   
   # Verify global hooks use correct binary
   grep -r "myco" ~/.myco/hooks/ | grep -v "runtime.command"
   ```

### Machine-Wide Re-exec Logic Validation

1. **Test binary re-execution across global scope**:
   ```bash
   # Verify that runtime.command pins work correctly for all projects
   strace -e execve myco --version 2>&1 | grep execve
   # Test re-exec consistency across registered projects
   myco projects test-reexec --sample
   ```

2. **Validate update mechanisms with global hooks**:
   ```bash
   # Check that updates don't break re-exec logic for any project
   myco doctor # Should report consistent binary paths
   myco hooks verify-reexec # Ensure hooks use updated binary
   ```

## Procedure D: Update Coordination and Environment Management

Coordinate binary updates and environment transitions without disrupting active workflows across the global capture architecture.

### Machine-Wide Upgrade Path Testing

1. **Test upgrade in isolated machine context**:
   ```bash
   # Create temporary environment for testing machine-wide changes
   cp ~/.myco/runtime.command ~/.myco/runtime.command.backup
   echo "/path/to/new/binary" > ~/.myco/runtime.command
   myco --version # Verify new binary works
   
   # Test across all registered projects
   myco projects verify-runtime --all
   ```

2. **Rollback on failure affecting any project**:
   ```bash
   # Restore previous configuration if upgrade fails for any project
   mv ~/.myco/runtime.command.backup ~/.myco/runtime.command
   # Verify rollback worked across all projects
   myco projects verify-runtime --all
   ```

### NPM Package Upgrade Handling with Global Hooks

1. **Handle Grove daemon binary version mismatches with global impact**:
   ```bash
   # After npm install -g @goondocks/myco@latest
   myco doctor # Check for version mismatches affecting all projects
   # Restart Grove global daemon if versions don't match
   myco daemon stop
   myco daemon start
   
   # Verify global hooks use updated binary
   myco hooks verify-binary --all
   ```

2. **Validate machine-wide daemon restart after package updates**:
   ```bash
   # Ensure Grove daemon serves JSON, not HTML after updates
   curl -s http://127.0.0.1:20915/api/stats
   # Should return JSON, not HTML error page
   # Verify all registered projects are accessible with global hooks
   myco projects list --verify-capture
   ```

### Daemon Upgrade Failure Recovery with Global Scope

1. **Detect daemon event loop wedge affecting all projects**:
   ```bash
   # Check if daemon port is bound but not responding to any project
   netstat -tuln | grep 20915
   curl -s --connect-timeout 3 http://127.0.0.1:20915/api/stats || echo "Daemon wedged"
   
   # Check for stale daemon processes affecting global capture
   ps aux | grep myco | grep -v grep
   # Verify global hook functionality
   myco hooks test --quick
   ```

2. **Force daemon restart with SIGKILL** (affects all projects with global hooks):
   ```bash
   # Get daemon PID holding port 20915
   DAEMON_PID=$(lsof -ti:20915)
   
   # Preserve daemon.json before killing process
   cp ~/.myco/daemon.json ~/.myco/daemon.json.backup 2>/dev/null || true
   
   # Force kill wedged process (affects all global hook functionality)
   kill -9 $DAEMON_PID
   
   # Verify port is released and global hooks can reconnect
   sleep 2
   netstat -tuln | grep 20915 || echo "Port released"
   ```

3. **Handle restart false positives and version-skew detection with global impact**:
   ```bash
   # Start daemon and check for version-skew warnings affecting all projects
   myco daemon start
   
   # Verify daemon serves correct version for all projects
   BINARY_VERSION=$(myco --version)
   DAEMON_VERSION=$(curl -s http://127.0.0.1:20915/api/stats | jq -r '.version' 2>/dev/null)
   
   if [ "$BINARY_VERSION" != "$DAEMON_VERSION" ]; then
       echo "Version skew detected: binary=$BINARY_VERSION daemon=$DAEMON_VERSION"
       echo "This affects all projects with global hooks"
       echo "Restarting daemon to sync versions..."
       myco daemon stop
       myco daemon start
       
       # Verify global hooks reconnected successfully
       myco hooks verify-connection --all
   fi
   ```

4. **Restore machine-wide daemon configuration after forced restart**:
   ```bash
   # Restore daemon.json if it was corrupted during forced kill
   if [ ! -s ~/.myco/daemon.json ] && [ -f ~/.myco/daemon.json.backup ]; then
       cp ~/.myco/daemon.json.backup ~/.myco/daemon.json
       echo "Restored daemon.json from backup"
   fi
   
   # Validate daemon configuration integrity for all projects
   myco doctor # Should show no configuration errors
   myco projects verify-connection --all # Test all global hook connections
   ```

### Binary Replacement Procedures with Global Hook Updates

1. **Atomic binary replacement affecting all projects**:
   ```bash
   # Replace binary atomically to avoid partial updates affecting global hooks
   mv /new/myco/binary /usr/local/bin/myco.new
   mv /usr/local/bin/myco.new /usr/local/bin/myco
   
   # Update global hooks to use new binary
   myco hooks update-binary-refs --all
   ```

2. **Validate replacement across global scope**:
   ```bash
   # Ensure new binary works across all projects
   myco doctor
   ps aux | grep myco # Check running Grove daemon still works
   myco projects list --verify-all # Verify all projects remain accessible
   
   # Test global hook functionality with new binary
   myco hooks test --comprehensive
   ```

## Procedure E: Bun Compilation and Deployment

Handle Bun-specific compilation constraints, asset bundling strategies, virtual filesystem handling, build artifact packaging, multi-target compilation patterns, and binary entry point dispatch for Grove multi-project architecture with machine-scoped global hooks.

### Template and Asset Bundling Strategies for Global Deployment

Myco uses **filesystem-first + bundled-string fallback** pattern for package assets via generated template modules. Static assets like installer templates must be accessible both during development (filesystem reads) and in compiled binaries (bundled strings) across the global capture architecture.

#### Two-Generator Template System for Machine-Scoped Deployment

Myco uses a two-generator system handling different asset types, optimized for machine-wide deployment:

```bash
# Generate all template modules at build time for global deployment
cd packages/myco
npm run codegen

# This runs two generators:
# 1. scripts/gen-hook-config.ts → hook-config.generated.ts & manifests.generated.ts
# 2. scripts/gen-templates.mjs → templates.generated.ts
```

Each generator walks its respective source directory and embeds files for global deployment:

```javascript
// In scripts/gen-templates.mjs (installer templates for global hooks)
const files = walk(TEMPLATES_DIR).sort();
const entries = files.map((abs) => {
  const rel = path.relative(TEMPLATES_DIR, abs).split(path.sep).join('/');
  const body = fs.readFileSync(abs, 'utf-8');
  return [rel, body];
});
```

```typescript
// In scripts/gen-hook-config.ts (global hook config and manifests)
// Generates both hook-config.generated.ts and manifests.generated.ts
// from src/hooks/ and src/symbionts/manifests/ respectively
```

#### Implement the fallback pattern for global scope

The fallback pattern is implemented consistently across different asset loaders, supporting both project-specific and machine-wide deployment:

```typescript
// In src/symbionts/installer.ts (templates for global hook installation)
private readTemplateFile(relPath: string): string | null {
  // Try filesystem first (development and testing)
  const candidates = [
    path.join(this.packageRoot, TEMPLATES_SUBDIR, relPath),
    path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, relPath),
  ];
  for (const filePath of candidates) {
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { /* try next */ }
  }

  // Fall back to bundled strings (compiled binary for global deployment)
  if (this.suppressBundledTemplates) return null;
  const key = relPath.split(path.sep).join('/');
  const bundled = BUNDLED_TEMPLATES[key];
  return bundled !== undefined ? bundled : null;
}

// Similar pattern in manifest loader for global hooks
private readManifestFile(relPath: string): ManifestData | null {
  // Filesystem first, then BUNDLED_MANIFESTS fallback for global deployment
  const bundled = BUNDLED_MANIFESTS[key];
  return bundled !== undefined ? bundled : null;
}
```

**Critical gotcha for global deployment**: Each asset loader can return `null` when the filesystem path fails and no bundled fallback exists. Always check for null across all asset types, especially when installing global hooks:

```typescript
// BAD: Silent failure affecting global hook installation
const template = installer.readTemplateFile('hook-guard.cjs');
const manifest = loader.readManifestFile('claude-code.json');

// GOOD: Explicit checks for global deployment
const template = installer.readTemplateFile('hook-guard.cjs');
if (!template) throw new Error(`Template not found: hook-guard.cjs (required for global hooks)`);

const manifest = loader.readManifestFile('claude-code.json');  
if (!manifest) throw new Error(`Manifest not found: claude-code.json (required for global capture)`);
```

#### Design runtime boundary decisions for global architecture

**Package assets** (bundled via generators for machine-wide deployment): Global hook templates, symbiont manifests, hook configurations, default configs, static strings  
**User assets** (filesystem, project-specific): User configs, generated files, session data, vault contents, runtime logs

When adding new static assets for global deployment, decide the boundary and target generator:
- **Global hook templates** → add to `src/symbionts/templates/` for `gen-templates.mjs`
- **Symbiont manifests for global capture** → add to `src/symbionts/manifests/` for `gen-hook-config.ts` 
- **Global hook configurations** → add to `src/hooks/` for `gen-hook-config.ts`
- **Project-specific or installation-specific** → read from filesystem at runtime

### Virtual Filesystem Handling for Global Binary Distribution

Bun binaries use a `/$bunfs/` virtual filesystem for bundled content. This creates path resolution challenges that require careful native dependency handling, especially for machine-wide deployment.

#### Use resolvePackageRoot() for machine-scoped bundled content

Never rely on `process.cwd()` for package asset resolution in global deployment. The actual implementation uses import.meta.dirname detection:

```typescript
// In src/symbionts/detect.ts (machine-scoped package resolution)
export function resolvePackageRoot(): string {
  // Try import.meta.dirname first — works in dev and old tsup layout
  if (typeof import.meta.dirname === 'string' && !import.meta.dirname.includes('/$bunfs/')) {
    return path.resolve(import.meta.dirname, '..', '..');
  }
  
  // Fall back to process.execPath resolution — compiled binary case for global deployment
  if (process.execPath && process.execPath !== process.argv0) {
    return path.dirname(process.execPath);
  }
  
  return process.cwd();
}
```

**Critical gotcha for global deployment**: Import.meta.dirname detection prevents loading stale `/dist/` artifacts when the global binary is run from a development directory with old build output.

#### Handle embedded native dependencies for machine-wide operation

Bun's file embedding with `import ... with { type: 'file' }` creates virtual paths that must be materialized for global operation:

```typescript
// In src/entries/cli.darwin-arm64.ts (global binary entry point)
import libsqliteEmbed from '../../vendor-src/libsqlite3/darwin-arm64/libsqlite3.dylib' with { type: 'file' };
import vec0Embed from 'sqlite-vec-darwin-arm64/vec0.dylib' with { type: 'file' };
import ripgrepEmbed from '@vscode/ripgrep/bin/rg' with { type: 'file' };

await registerEmbeddedNativeDeps({
  libsqliteEmbed,    // Resolves to /$bunfs/path at runtime
  vec0Embed,         // Must be extracted to real filesystem for global operation
  ripgrepEmbed,
  version: pkg.version,
});
```

The `registerEmbeddedNativeDeps()` function extracts these to temporary files for machine-wide operation:

```typescript
// In src/runtime/native-deps.ts (machine-scoped native dependency management)
export async function registerEmbeddedNativeDeps(deps) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-'));
  
  // Extract each embedded file to temp directory for global operation
  const libsqlitePath = path.join(tempDir, 'libsqlite3.dylib');
  await fs.writeFile(libsqlitePath, await fs.readFile(deps.libsqliteEmbed));
  
  // Register with the runtime for machine-wide availability
  process.env.MYCO_LIBSQLITE_PATH = libsqlitePath;
}
```

### Build Artifact Packaging for Global Distribution

Myco's binary packaging uses target-specific entry points with embedded native dependencies and strict build validation for machine-wide deployment.

#### Use target-specific entry points for global deployment

Each supported platform has a dedicated entry point that embeds the correct native binaries for global operation:

```bash
# Entry points for each target (global deployment)
ls packages/myco/src/entries/
# cli.darwin-arm64.ts
# cli.darwin-x64.ts  
# cli.linux-x64.ts
# cli.linux-arm64.ts
# cli.windows-x64.ts
# cli.js (shared logic)
```

Each entry imports platform-specific native dependencies for machine-wide operation:

```typescript
// cli.darwin-arm64.ts embeds macOS ARM64 binaries for global deployment
import libsqliteEmbed from '../../vendor-src/libsqlite3/darwin-arm64/libsqlite3.dylib' with { type: 'file' };

// cli.linux-x64.ts embeds Linux x64 binaries for global deployment
import libsqliteEmbed from '../../vendor-src/libsqlite3/linux-x64/libsqlite3.so' with { type: 'file' };
```

#### Build single target binaries for machine-wide installation

The build system creates platform-specific binaries in `vendor/{target}/` for global deployment:

```bash
# Build for current platform (global deployment)
npm run build:binary

# Build specific target via env var for machine-wide distribution
TARGET=darwin-arm64 npm run build:binary
TARGET=linux-x64 npm run build:binary
TARGET=windows-x64 npm run build:binary

# Build all targets (CI use for global distribution)
npm run build:binaries
```

This runs `scripts/build-single-target.mjs` for global deployment:

```javascript
const target = process.env.TARGET ?? detectHostTarget();
const entry = path.join(pkgRoot, 'src', 'entries', `cli.${target}.ts`);
const outputDir = path.join(pkgRoot, 'vendor', target);
const binaryName = target.startsWith('windows-') ? 'myco.exe' : 'myco';
const outfile = path.join(outputDir, binaryName);

const result = spawnSync(
  'bun',
  ['build', '--compile', `--target=bun-${target}`, entry, '--outfile', outfile],
  { stdio: 'inherit', cwd: pkgRoot }
);
```

### Multi-Target Compilation Patterns for Global Distribution

Building for multiple platforms requires handling native dependency differences and target-specific build constraints for machine-wide deployment.

#### Handle platform-specific native dependencies for global operation

Each target needs different native binaries embedded for global deployment:

```bash
# Install platform-specific dependencies for each target (global deployment)
# Package structure: vendor-src/libsqlite3/{target}/libsqlite3.{ext}

# macOS requires .dylib files for global deployment
packages/myco/vendor-src/libsqlite3/darwin-arm64/libsqlite3.dylib
packages/myco/vendor-src/libsqlite3/darwin-x64/libsqlite3.dylib

# Linux requires .so files for global deployment
packages/myco/vendor-src/libsqlite3/linux-x64/libsqlite3.so
packages/myco/vendor-src/libsqlite3/linux-arm64/libsqlite3.so

# Windows requires .dll files for global deployment
packages/myco/vendor-src/libsqlite3/windows-x64/sqlite3.dll
```

#### Set up cross-platform CI builds for global distribution

Use matrix builds to compile all targets for machine-wide deployment:

```yaml
# In .github/workflows/build.yml (global distribution)
strategy:
  matrix:
    include:
      - target: darwin-arm64
        os: macos-latest
      - target: linux-x64  
        os: ubuntu-latest
      - target: windows-x64
        os: windows-latest

steps:
  - name: Build target for global deployment
    run: |
      TARGET=${{ matrix.target }} npm run build:binary
      npm run build:verify
```

### Binary Entry Point Dispatch for Global Hooks

Myco supports runtime resolution via `.myco/runtime.command` with automatic collision detection through the global hook guard system and critical dispatch contract enforcement to prevent version-sync loops across the global capture architecture.

#### Use the global hook guard dispatch pattern

The `.agents/myco-run.cjs` hook guard provides cross-platform entry point resolution for global hooks:

```javascript
// In .agents/myco-run.cjs (global hook guard)
let bin = 'myco';  // Default for global installs
try {
  const aliasPath = path.resolve(__dirname, '..', '.myco', 'runtime.command');
  const alias = fs.readFileSync(aliasPath, 'utf-8').trim();
  if (alias) bin = alias;  // Override with machine-scoped development binary
} catch { /* missing file → use default for global operation */ }

try {
  execFileSync(bin, process.argv.slice(2), { stdio: 'inherit' });
} catch (e) {
  if (e.code === 'ENOENT') process.exit(0);  // Silent no-op for missing myco in global context
  process.exit(e.status ?? 1);
}
```

#### Configure runtime.command for machine-wide development

Point to development binaries for local testing across all projects:

```bash
# For global install users (default machine-wide configuration)
echo "myco" > ~/.myco/runtime.command

# For local development affecting all projects (make dev-link creates this)
echo "/path/to/myco/packages/myco-darwin-arm64/bin/myco" > ~/.myco/runtime.command

# For npm link workflows affecting global hooks
echo "myco-dev" > ~/.myco/runtime.command
```

#### Handle PATH collision detection for global deployment

Before installation, check for conflicting binaries affecting global hooks:

```typescript
// In src/cli/doctor.ts (global collision detection)
export function detectPathCollisions(binaryName: string): string[] {
  const collisions: string[] = [];
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  
  for (const dir of pathDirs) {
    const candidates = process.platform === 'win32' 
      ? [`${binaryName}.exe`, `${binaryName}.cmd`, `${binaryName}.bat`]
      : [binaryName];
      
    for (const candidate of candidates) {
      const binaryPath = path.join(dir, candidate);
      if (fs.existsSync(binaryPath)) {
        collisions.push(binaryPath);
      }
    }
  }
  
  return collisions;
}
```

### Single-File Binary Constraints for Global Operation

1. **Validate Bun compilation output for machine-wide deployment**:
   ```bash
   # Check compiled binary structure using build scripts
   cd packages/myco
   node scripts/build-all-targets.mjs
   file ./dist/myco-*
   ldd ./dist/myco-* 2>/dev/null || echo "Static binaries (expected for global deployment)"
   ```

2. **Test asset bundling for global hooks**:
   ```bash
   # Verify required assets are bundled for global operation
   strings ./dist/myco-linux | grep -E "\\.(json|sql|md)$" | head -10
   ```

3. **Build for different platforms with global deployment support**:
   ```bash
   # Use the established build script for multi-target compilation
   make build # Uses bun build --compile for all targets
   ls -la ./dist/myco-*
   ```

4. **Validate cross-platform deployment for global hooks**:
   ```bash
   # Test that each binary works on its target platform with global hooks
   file ./dist/myco-* 
   # Deploy with machine-scoped runtime.command pins
   # Test global hook functionality on each platform
   ```

## Cross-Cutting Gotchas

**Machine-scoped runtime masquerade**: Machine-wide pins in `~/.myco/runtime.command` now affect all projects globally. Always check `which myco` vs pinned path when debugging unexpected behavior, as it impacts all registered projects simultaneously.

**Global hook binary synchronization**: After `npm install -g @goondocks/myco@latest`, all global hooks must use the updated binary. The Grove global daemon may continue running with the old binary, causing all projects to serve HTML instead of JSON. Always restart the Grove daemon and verify global hook binary references after package upgrades.

**Machine-wide binary replacement impact**: Replacing binaries while Grove daemon processes are running affects all registered projects simultaneously due to global hook architecture. Stop all myco processes before binary updates to prevent undefined behavior across the entire global capture scope.

**Global-first quarantine mode**: Unknown projects operate in quarantine mode until explicitly registered. Attempting to use myco commands in unregistered projects may fail or provide limited functionality. Always register new projects with `myco projects register` to enable full global hook coverage.

**Machine-scoped configuration inheritance**: Project-level runtime configuration overrides are now anti-pattern in the global-first model. Prefer machine-scoped configuration that applies to all projects unless specific compatibility requirements demand project-level overrides.

**Global hook capture coordination**: When multiple projects are active simultaneously, global hooks coordinate capture through the single machine-scoped daemon. Binary updates, daemon restarts, or configuration changes affect all active projects, not just the current working directory.

**Quarantine mode binary resolution**: Projects in quarantine mode may use different binary resolution logic than registered projects. This can cause confusion when the same machine-scoped binary behaves differently across quarantined vs registered project boundaries.

**Machine-scoped runtime persistence**: The runtime.command file operates at machine scope (`~/.myco/runtime.command`) affecting all global hooks. Project-scoped runtime configuration (`.myco/runtime.command`) is now legacy fallback only. Procedures must prioritize machine-scoped configuration in the global-first model.

**Global capture state coordination**: Multiple registered projects share the same global capture infrastructure. Daemon issues, hook failures, or configuration problems affect all projects simultaneously rather than being isolated to individual project boundaries.

**Asset loader null returns in global context**: Each asset loader (templates, manifests, hooks) can return `null` when the filesystem path fails and no bundled fallback exists. This particularly affects global hook installation where missing assets prevent proper global capture setup.

**Virtual filesystem path resolution for global deployment**: Bun binaries use `/$bunfs/` virtual paths that require special handling for machine-wide deployment. Never rely on `process.cwd()` for package asset resolution in global hooks — use `resolvePackageRoot()` with import.meta.dirname detection.

**Native dependency materialization for machine scope**: Embedded native dependencies must be extracted to temporary files before use across the global architecture. The `registerEmbeddedNativeDeps()` function handles this for libsqlite3, sqlite-vec, and ripgrep binaries across all platforms, ensuring machine-wide availability.