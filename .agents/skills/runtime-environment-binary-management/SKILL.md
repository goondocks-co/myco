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

## Prerequisites

- Myco installation with proper symbiont structure
- Understanding of Myco's Grove multi-project daemon architecture (packages/myco/src/daemon/)
- Access to runtime configuration files (~/.myco/runtime.command, project-level configs)
- Familiarity with Bun compilation and single-file binary patterns
- Knowledge of Grove registration and project binding patterns

## Procedure A: Runtime Command Resolution and Fallback Management

Configure and debug the layered runtime command resolution system with Grove multi-project support.

### Machine-Wide Runtime Pins

1. **Check machine-wide runtime pin**:
   ```bash
   cat ~/.myco/runtime.command
   ```

2. **Set machine-wide pin** (when needed for consistent binary dispatch across all Groves):
   ```bash
   echo "/path/to/preferred/myco/binary" > ~/.myco/runtime.command
   ```

3. **Validate pin target** (ensure the pinned binary exists and is executable):
   ```bash
   ls -la $(cat ~/.myco/runtime.command)
   ```

### Project-Level Override Patterns

1. **Check project-level runtime configuration**:
   ```bash
   # Look for project-specific runtime overrides
   find .myco/ -name "runtime.command" -o -name "*.runtime.conf"
   ```

2. **Implement project override** (when project needs specific binary version):
   ```bash
   # Project-level pin takes precedence over machine-wide
   echo "/project/specific/myco/binary" > .myco/runtime.command
   ```

### Fallback Chain Validation

1. **Test fallback chain resolution**:
   ```bash
   # Verify binary resolution order: project → machine → PATH
   which myco
   echo $PATH | tr ':' '\n' | grep myco
   ```

2. **Debug resolution failures**:
   ```bash
   # Check each step of the fallback chain
   [ -f .myco/runtime.command ] && echo "Project pin: $(cat .myco/runtime.command)"
   [ -f ~/.myco/runtime.command ] && echo "Machine pin: $(cat ~/.myco/runtime.command)"
   which myco || echo "No myco in PATH"
   ```

## Procedure B: Machine-Scoped Runtime Architecture

Manage machine-scoped service coordination and runtime environment resolution in the Grove multi-project architecture.

### Grove Global Daemon Runtime Resolution

1. **Check Grove daemon runtime source status**:
   ```bash
   # Check daemon runtime source via API (Grove global daemon)
   curl -s http://127.0.0.1:20915/api/stats | jq '.runtime'
   ```

2. **Verify machine-scoped configuration with Grove support**:
   ```bash
   # Validate machine-level runtime settings for multi-Grove operation
   ls -la ~/.myco/runtime.command
   myco doctor # Should report runtime source information for all Groves
   ```

### Multi-Project Grove Coordination

1. **Test cross-Grove runtime consistency**:
   ```bash
   # Verify that machine runtime applies across all registered Groves
   myco groves list # List all registered Groves
   cd /path/to/grove1/project1
   myco --version
   cd /path/to/grove2/project2  
   myco --version # Should show same binary unless project-pinned
   ```

2. **Manage multi-Grove updates**:
   ```bash
   # Update all Groves via machine-scoped coordination
   myco update --all-groves
   ```

### Grove Registration Impact on Runtime Resolution

1. **Validate runtime resolution after Grove registration**:
   ```bash
   # Check that newly registered Groves use correct runtime
   myco grove register /path/to/new/grove
   cd /path/to/new/grove/project
   myco --version # Should match machine-wide runtime
   ```

## Procedure C: Binary Masquerade Detection and Prevention

Detect and prevent binary dispatch conflicts between published and development versions across Grove boundaries.

### Version Detection Reliability

1. **Verify binary authenticity across Groves**:
   ```bash
   # Check binary version and source for all Groves
   myco --version
   which myco
   file $(which myco) # Check if it's a compiled binary or script
   ```

2. **Detect masquerade scenarios**:
   ```bash
   # Compare expected vs actual binary paths
   realpath $(which myco)
   # Check for unexpected symlinks or wrappers
   ls -la $(dirname $(which myco))/myco*
   ```

### Re-exec Logic Validation

1. **Test binary re-execution**:
   ```bash
   # Verify that runtime.command pins work correctly
   strace -e execve myco --version 2>&1 | grep execve
   ```

2. **Validate update mechanisms**:
   ```bash
   # Check that updates don't break re-exec logic
   myco doctor # Should report consistent binary paths
   ```

## Procedure D: Update Coordination and Environment Management

Coordinate binary updates and environment transitions without disrupting active workflows across multiple Groves.

### Upgrade Path Testing

1. **Test upgrade in isolation**:
   ```bash
   # Create temporary environment for testing
   cp ~/.myco/runtime.command ~/.myco/runtime.command.backup
   echo "/path/to/new/binary" > ~/.myco/runtime.command
   myco --version # Verify new binary works
   ```

2. **Rollback on failure**:
   ```bash
   # Restore previous configuration if upgrade fails
   mv ~/.myco/runtime.command.backup ~/.myco/runtime.command
   ```

### NPM Package Upgrade Handling

1. **Handle Grove daemon binary version mismatches**:
   ```bash
   # After npm install -g @goondocks/myco@latest
   myco doctor # Check for version mismatches
   # Restart Grove global daemon if versions don't match
   myco daemon stop
   myco daemon start
   ```

2. **Validate Grove daemon restart after package updates**:
   ```bash
   # Ensure Grove daemon serves JSON, not HTML after updates
   curl -s http://127.0.0.1:20915/api/stats
   # Should return JSON, not HTML error page
   # Verify all registered Groves are accessible
   myco groves list
   ```

### Daemon Upgrade Failure Recovery

1. **Detect daemon event loop wedge after upgrade**:
   ```bash
   # Check if daemon port is bound but not responding
   netstat -tuln | grep 20915
   curl -s --connect-timeout 3 http://127.0.0.1:20915/api/stats || echo "Daemon wedged"
   
   # Check for stale daemon processes
   ps aux | grep myco | grep -v grep
   ```

2. **Force daemon restart with SIGKILL** (when daemon.stop fails):
   ```bash
   # Get daemon PID holding port 20915
   DAEMON_PID=$(lsof -ti:20915)
   
   # Preserve daemon.json before killing process
   cp ~/.myco/daemon.json ~/.myco/daemon.json.backup 2>/dev/null || true
   
   # Force kill wedged process
   kill -9 $DAEMON_PID
   
   # Verify port is released
   sleep 2
   netstat -tuln | grep 20915 || echo "Port released"
   ```

3. **Handle restart false positives and version-skew detection**:
   ```bash
   # Start daemon and check for version-skew warnings
   myco daemon start
   
   # Verify daemon serves correct version after restart
   BINARY_VERSION=$(myco --version)
   DAEMON_VERSION=$(curl -s http://127.0.0.1:20915/api/stats | jq -r '.version' 2>/dev/null)
   
   if [ "$BINARY_VERSION" != "$DAEMON_VERSION" ]; then
       echo "Version skew detected: binary=$BINARY_VERSION daemon=$DAEMON_VERSION"
       echo "Restarting daemon to sync versions..."
       myco daemon stop
       myco daemon start
   fi
   ```

4. **Restore daemon configuration after forced restart**:
   ```bash
   # Restore daemon.json if it was corrupted during forced kill
   if [ ! -s ~/.myco/daemon.json ] && [ -f ~/.myco/daemon.json.backup ]; then
       cp ~/.myco/daemon.json.backup ~/.myco/daemon.json
       echo "Restored daemon.json from backup"
   fi
   
   # Validate daemon configuration integrity
   myco doctor # Should show no configuration errors
   ```

### Binary Replacement Procedures

1. **Atomic binary replacement**:
   ```bash
   # Replace binary atomically to avoid partial updates
   mv /new/myco/binary /usr/local/bin/myco.new
   mv /usr/local/bin/myco.new /usr/local/bin/myco
   ```

2. **Validate replacement across Grove boundaries**:
   ```bash
   # Ensure new binary works across all Groves
   myco doctor
   ps aux | grep myco # Check running Grove daemon still works
   myco groves list # Verify all Groves remain accessible
   ```

## Procedure E: Bun Compilation and Deployment

Handle Bun-specific compilation constraints, asset bundling strategies, virtual filesystem handling, build artifact packaging, multi-target compilation patterns, and binary entry point dispatch for Grove multi-project architecture.

### Template and Asset Bundling Strategies

Myco uses **filesystem-first + bundled-string fallback** pattern for package assets via generated template modules. Static assets like installer templates must be accessible both during development (filesystem reads) and in compiled binaries (bundled strings).

#### Two-Generator Template System

Myco uses a two-generator system handling different asset types:

```bash
# Generate all template modules at build time
cd packages/myco
npm run codegen

# This runs two generators:
# 1. scripts/gen-hook-config.ts → hook-config.generated.ts & manifests.generated.ts
# 2. scripts/gen-templates.mjs → templates.generated.ts
```

Each generator walks its respective source directory and embeds files:

```javascript
// In scripts/gen-templates.mjs (installer templates)
const files = walk(TEMPLATES_DIR).sort();
const entries = files.map((abs) => {
  const rel = path.relative(TEMPLATES_DIR, abs).split(path.sep).join('/');
  const body = fs.readFileSync(abs, 'utf-8');
  return [rel, body];
});
```

```typescript
// In scripts/gen-hook-config.ts (hook config and manifests)
// Generates both hook-config.generated.ts and manifests.generated.ts
// from src/hooks/ and src/symbionts/manifests/ respectively
```

#### Implement the fallback pattern across asset types

The fallback pattern is implemented consistently across different asset loaders:

```typescript
// In src/symbionts/installer.ts (templates)
private readTemplateFile(relPath: string): string | null {
  // Try filesystem first (development and testing)
  const candidates = [
    path.join(this.packageRoot, TEMPLATES_SUBDIR, relPath),
    path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, relPath),
  ];
  for (const filePath of candidates) {
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { /* try next */ }
  }

  // Fall back to bundled strings (compiled binary)
  if (this.suppressBundledTemplates) return null;
  const key = relPath.split(path.sep).join('/');
  const bundled = BUNDLED_TEMPLATES[key];
  return bundled !== undefined ? bundled : null;
}

// Similar pattern in manifest loader
private readManifestFile(relPath: string): ManifestData | null {
  // Filesystem first, then BUNDLED_MANIFESTS fallback
  const bundled = BUNDLED_MANIFESTS[key];
  return bundled !== undefined ? bundled : null;
}
```

**Critical gotcha**: Each asset loader can return `null` when the filesystem path fails and no bundled fallback exists. Always check for null across all asset types:

```typescript
// BAD: Silent failure across multiple asset types
const template = installer.readTemplateFile('hook-guard.cjs');
const manifest = loader.readManifestFile('claude-code.json');

// GOOD: Explicit checks for all asset types
const template = installer.readTemplateFile('hook-guard.cjs');
if (!template) throw new Error(`Template not found: hook-guard.cjs`);

const manifest = loader.readManifestFile('claude-code.json');  
if (!manifest) throw new Error(`Manifest not found: claude-code.json`);
```

#### Design runtime boundary decisions for multi-asset architecture

**Package assets** (bundled via generators): Installer templates, symbiont manifests, hook configurations, default configs, static strings  
**User assets** (filesystem): User configs, generated files, session data, vault contents, runtime logs

When adding new static assets, decide the boundary and target generator:
- **Installer templates** → add to `src/symbionts/templates/` for `gen-templates.mjs`
- **Symbiont manifests** → add to `src/symbionts/manifests/` for `gen-hook-config.ts` 
- **Hook configurations** → add to `src/hooks/` for `gen-hook-config.ts`
- **User-generated or installation-specific** → read from filesystem at runtime

### Virtual Filesystem Handling

Bun binaries use a `/$bunfs/` virtual filesystem for bundled content. This creates path resolution challenges that require careful native dependency handling.

#### Use resolvePackageRoot() for bundled content

Never rely on `process.cwd()` for package asset resolution. The actual implementation uses import.meta.dirname detection:

```typescript
// In src/symbionts/detect.ts
export function resolvePackageRoot(): string {
  // Try import.meta.dirname first — works in dev and old tsup layout
  if (typeof import.meta.dirname === 'string' && !import.meta.dirname.includes('/$bunfs/')) {
    return path.resolve(import.meta.dirname, '..', '..');
  }
  
  // Fall back to process.execPath resolution — compiled binary case
  if (process.execPath && process.execPath !== process.argv0) {
    return path.dirname(process.execPath);
  }
  
  return process.cwd();
}
```

**Critical gotcha**: Import.meta.dirname detection prevents loading stale `/dist/` artifacts when the binary is run from a development directory with old build output.

#### Handle embedded native dependencies

Bun's file embedding with `import ... with { type: 'file' }` creates virtual paths that must be materialized:

```typescript
// In src/entries/cli.darwin-arm64.ts
import libsqliteEmbed from '../../vendor-src/libsqlite3/darwin-arm64/libsqlite3.dylib' with { type: 'file' };
import vec0Embed from 'sqlite-vec-darwin-arm64/vec0.dylib' with { type: 'file' };
import ripgrepEmbed from '@vscode/ripgrep/bin/rg' with { type: 'file' };

await registerEmbeddedNativeDeps({
  libsqliteEmbed,    // Resolves to /$bunfs/path at runtime
  vec0Embed,         // Must be extracted to real filesystem
  ripgrepEmbed,
  version: pkg.version,
});
```

The `registerEmbeddedNativeDeps()` function extracts these to temporary files:

```typescript
// In src/runtime/native-deps.ts
export async function registerEmbeddedNativeDeps(deps) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'myco-'));
  
  // Extract each embedded file to temp directory
  const libsqlitePath = path.join(tempDir, 'libsqlite3.dylib');
  await fs.writeFile(libsqlitePath, await fs.readFile(deps.libsqliteEmbed));
  
  // Register with the runtime
  process.env.MYCO_LIBSQLITE_PATH = libsqlitePath;
}
```

### Build Artifact Packaging

Myco's binary packaging uses target-specific entry points with embedded native dependencies and strict build validation.

#### Use target-specific entry points

Each supported platform has a dedicated entry point that embeds the correct native binaries:

```bash
# Entry points for each target
ls packages/myco/src/entries/
# cli.darwin-arm64.ts
# cli.darwin-x64.ts  
# cli.linux-x64.ts
# cli.linux-arm64.ts
# cli.windows-x64.ts
# cli.js (shared logic)
```

Each entry imports platform-specific native dependencies:

```typescript
// cli.darwin-arm64.ts embeds macOS ARM64 binaries
import libsqliteEmbed from '../../vendor-src/libsqlite3/darwin-arm64/libsqlite3.dylib' with { type: 'file' };

// cli.linux-x64.ts embeds Linux x64 binaries  
import libsqliteEmbed from '../../vendor-src/libsqlite3/linux-x64/libsqlite3.so' with { type: 'file' };
```

#### Build single target binaries

The build system creates platform-specific binaries in `vendor/{target}/`:

```bash
# Build for current platform
npm run build:binary

# Build specific target via env var
TARGET=darwin-arm64 npm run build:binary
TARGET=linux-x64 npm run build:binary
TARGET=windows-x64 npm run build:binary

# Build all targets (CI use)
npm run build:binaries
```

This runs `scripts/build-single-target.mjs`:

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

### Multi-Target Compilation Patterns

Building for multiple platforms requires handling native dependency differences and target-specific build constraints.

#### Handle platform-specific native dependencies

Each target needs different native binaries embedded:

```bash
# Install platform-specific dependencies for each target
# Package structure: vendor-src/libsqlite3/{target}/libsqlite3.{ext}

# macOS requires .dylib files
packages/myco/vendor-src/libsqlite3/darwin-arm64/libsqlite3.dylib
packages/myco/vendor-src/libsqlite3/darwin-x64/libsqlite3.dylib

# Linux requires .so files  
packages/myco/vendor-src/libsqlite3/linux-x64/libsqlite3.so
packages/myco/vendor-src/libsqlite3/linux-arm64/libsqlite3.so

# Windows requires .dll files
packages/myco/vendor-src/libsqlite3/windows-x64/sqlite3.dll
```

#### Set up cross-platform CI builds

Use matrix builds to compile all targets:

```yaml
# In .github/workflows/build.yml
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
  - name: Build target
    run: |
      TARGET=${{ matrix.target }} npm run build:binary
      npm run build:verify
```

### Binary Entry Point Dispatch

Myco supports runtime resolution via `.myco/runtime.command` with automatic collision detection through the hook guard system and critical dispatch contract enforcement to prevent version-sync loops.

#### Use the hook guard dispatch pattern

The `.agents/myco-run.cjs` hook guard provides cross-platform entry point resolution:

```javascript
// In .agents/myco-run.cjs
let bin = 'myco';  // Default for global installs
try {
  const aliasPath = path.resolve(__dirname, '..', '.myco', 'runtime.command');
  const alias = fs.readFileSync(aliasPath, 'utf-8').trim();
  if (alias) bin = alias;  // Override with local development binary
} catch { /* missing file → use default */ }

try {
  execFileSync(bin, process.argv.slice(2), { stdio: 'inherit' });
} catch (e) {
  if (e.code === 'ENOENT') process.exit(0);  // Silent no-op for missing myco
  process.exit(e.status ?? 1);
}
```

#### Configure runtime.command for development

Point to development binaries for local testing:

```bash
# For global install users (default)
echo "myco" > .myco/runtime.command

# For local development (make dev-link creates this)
echo "/path/to/myco/packages/myco-darwin-arm64/bin/myco" > .myco/runtime.command

# For npm link workflows  
echo "myco-dev" > .myco/runtime.command
```

#### Handle PATH collision detection

Before installation, check for conflicting binaries:

```typescript
// In src/cli/doctor.ts
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

### Single-File Binary Constraints

1. **Validate Bun compilation output**:
   ```bash
   # Check compiled binary structure using build scripts
   cd packages/myco
   node scripts/build-all-targets.mjs
   file ./dist/myco-*
   ldd ./dist/myco-* 2>/dev/null || echo "Static binaries (expected)"
   ```

2. **Test asset bundling**:
   ```bash
   # Verify required assets are bundled
   strings ./dist/myco-linux | grep -E "\.(json|sql|md)$" | head -10
   ```

3. **Build for different platforms**:
   ```bash
   # Use the established build script for multi-target compilation
   make build # Uses bun build --compile for all targets
   ls -la ./dist/myco-*
   ```

4. **Validate cross-platform deployment**:
   ```bash
   # Test that each binary works on its target platform
   file ./dist/myco-* 
   # Deploy with platform-specific runtime.command pins
   ```

## Cross-Cutting Gotchas

**Runtime command masquerade**: Machine-wide pins in `~/.myco/runtime.command` can mask local development binaries. Always check `which myco` vs pinned path when debugging unexpected behavior across multiple Groves.

**NPM package upgrade stale Grove daemon**: After `npm install -g @goondocks/myco@latest`, the Grove global daemon may continue running with the old binary, causing context-switch requests to serve HTML instead of JSON. Always restart the Grove daemon after package upgrades.

**Binary replacement during active sessions**: Replacing binaries while Grove daemon processes are running can cause undefined behavior across all registered Groves. Stop all myco processes before binary updates.

**Bun asset bundling gaps**: Not all file types are automatically detected for bundling. Use the established build scripts in `packages/myco/scripts/` to ensure proper asset inclusion in single-file outputs.

**Update coordination race conditions**: Multiple processes trying to update runtime.command simultaneously can corrupt the file. Use atomic writes (write to temp file, then rename) for runtime configuration changes.

**Machine-scoped runtime persistence**: The runtime.command file has been moved from project-scoped (`.myco/runtime.command`) to machine-scoped (`~/.myco/runtime.command`). Procedures must account for this architectural change when managing multi-Grove environments.

**Grove registration runtime inheritance**: When registering new Groves, they inherit the machine-wide runtime configuration. Ensure the machine-wide runtime.command is properly set before Grove registration to avoid runtime resolution issues.

**Event loop wedge after daemon upgrades**: Post-upgrade daemons can enter an event loop wedge where the port is bound but the daemon is unresponsive. This requires SIGKILL termination followed by daemon restart. Always preserve daemon.json during forced restarts to avoid configuration corruption.

**Restart false positives during version-skew**: Daemon restart commands may report success even when the daemon failed to start due to version mismatches between the binary and cached daemon state. Always verify daemon responsiveness after restart and check for version-skew between `myco --version` and daemon API responses.

**Asset loader null returns**: Each asset loader (templates, manifests, hooks) can return `null` when the filesystem path fails and no bundled fallback exists. Always check for null across all asset types to prevent silent failures in compiled binaries.

**Virtual filesystem path resolution**: Bun binaries use `/$bunfs/` virtual paths that require special handling. Never rely on `process.cwd()` for package asset resolution — use `resolvePackageRoot()` with import.meta.dirname detection.

**Native dependency materialization**: Embedded native dependencies must be extracted to temporary files before use. The `registerEmbeddedNativeDeps()` function handles this for libsqlite3, sqlite-vec, and ripgrep binaries across all platforms.