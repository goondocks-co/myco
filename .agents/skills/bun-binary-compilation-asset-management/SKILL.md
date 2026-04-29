---
name: myco:bun-binary-compilation-asset-management
description: |
  Procedures for Bun binary compilation, asset bundling strategies, virtual filesystem 
  handling, build artifact packaging, multi-target compilation patterns, and binary 
  entry point dispatch in Myco's build system. Use when compiling static binaries with 
  Bun, managing package assets vs user files, resolving virtual filesystem paths, 
  handling cross-platform builds, or debugging binary packaging issues, even if the 
  user doesn't explicitly ask for Bun compilation help.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Bun Binary Compilation and Asset Management

Myco uses Bun's static compilation to produce standalone binaries with embedded native dependencies and bundled assets. This involves complex target-specific entry points, virtual filesystem navigation, template bundling workflows, and cross-platform build orchestration. These procedures address the fundamental boundary between package-owned assets (bundled into the binary) and user-owned files (read from disk at runtime).

## Prerequisites

- Bun installed and available in PATH
- Understanding of Myco's project structure (`src/`, `vendor/`, `.myco/`, `packages/`)
- Familiarity with per-target compilation and npm workspace patterns
- Basic knowledge of TypeScript import resolution and file embedding

## Template and Asset Bundling Strategies

Myco uses **filesystem-first + bundled-string fallback** pattern for package assets via generated template modules. Static assets like installer templates must be accessible both during development (filesystem reads) and in compiled binaries (bundled strings).

### Two-Generator Template System

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

### Implement the fallback pattern across asset types

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

### Design runtime boundary decisions for multi-asset architecture

**Package assets** (bundled via generators): Installer templates, symbiont manifests, hook configurations, default configs, static strings  
**User assets** (filesystem): User configs, generated files, session data, vault contents, runtime logs

When adding new static assets, decide the boundary and target generator:
- **Installer templates** → add to `src/symbionts/templates/` for `gen-templates.mjs`
- **Symbiont manifests** → add to `src/symbionts/manifests/` for `gen-hook-config.ts` 
- **Hook configurations** → add to `src/hooks/` for `gen-hook-config.ts`
- **User-generated or installation-specific** → read from filesystem at runtime

## Virtual Filesystem Handling

Bun binaries use a `/$bunfs/` virtual filesystem for bundled content. This creates path resolution challenges that require careful native dependency handling.

### Use resolvePackageRoot() for bundled content

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

### Handle embedded native dependencies

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

### Debug virtual filesystem access patterns

When filesystem operations fail in Bun binaries, check if the path is virtual:

```bash
# Debug embedded file paths
node -e "console.log(process.execPath)"
ls -la $(dirname $(which myco))/

# Check if assets were bundled properly across all generators
grep -r "BUNDLED_TEMPLATES" packages/myco/src/symbionts/templates.generated.ts
grep -r "BUNDLED_MANIFESTS" packages/myco/src/symbionts/manifests.generated.ts  
grep -r "HOOK_CONFIG" packages/myco/src/hooks/hook-config.generated.ts
```

## Build Artifact Packaging

Myco's binary packaging uses target-specific entry points with embedded native dependencies and strict build validation.

### Use target-specific entry points

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

### Build single target binaries

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

### Validate build artifacts

Add build verification to catch missing native dependencies or entry points:

```javascript
// In scripts/verify-build.mjs
function validateBuildArtifacts(target) {
  const binaryPath = path.join('vendor', target, target.startsWith('windows-') ? 'myco.exe' : 'myco');
  
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Missing binary: ${binaryPath}`);
  }
  
  // Test that the binary starts without errors
  const result = spawnSync(binaryPath, ['--version'], { timeout: 10000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Binary validation failed: ${binaryPath}`);
  }
}
```

## Multi-Target Compilation Patterns

Building for multiple platforms requires handling native dependency differences and target-specific build constraints.

### Handle platform-specific native dependencies

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

### Set up cross-platform CI builds

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

### Handle Bun vs Node.js compatibility

Different runtimes require different handling patterns:

```typescript
// Detect runtime environment
export function getCompilationContext(): 'bun-dev' | 'bun-compiled' | 'node' {
  if (typeof Bun !== 'undefined') {
    return process.argv[1]?.includes('/$bunfs/') ? 'bun-compiled' : 'bun-dev';
  }
  return 'node';
}

// Adjust behavior based on context
switch (getCompilationContext()) {
  case 'bun-compiled':
    // Use embedded native deps and bundled templates
    break;
  case 'bun-dev':
    // Use filesystem native deps and templates
    break;
  case 'node':
    // Use traditional Node.js require patterns
    break;
}
```

### Implement retry patterns for build failures

Multi-target builds often hit transient network or filesystem issues:

```bash
# Add retry logic to CI builds
for attempt in 1 2 3; do
  TARGET=$target npm run build:binary && break
  echo "Build attempt $attempt failed, retrying..."
  sleep $((attempt * 5))
done
```

## Binary Entry Point Dispatch

Myco supports runtime resolution via `.myco/runtime.command` with automatic collision detection through the hook guard system and critical dispatch contract enforcement to prevent version-sync loops.

### Use the hook guard dispatch pattern

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

### Configure runtime.command for development

Point to development binaries for local testing:

```bash
# For global install users (default)
echo "myco" > .myco/runtime.command

# For local development (make dev-link creates this)
echo "/path/to/myco/vendor/darwin-arm64/myco" > .myco/runtime.command

# For npm link workflows  
echo "myco-dev" > .myco/runtime.command
```

### Handle PATH collision detection

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

### Ensure executable resolution portability

Binary resolution must work across different installation patterns:

```typescript
// Check multiple resolution strategies
export function resolveBinary(name: string): string | null {
  // 1. Check runtime.command override
  try {
    const aliasPath = path.join(process.cwd(), '.myco', 'runtime.command');
    const alias = fs.readFileSync(aliasPath, 'utf-8').trim();
    if (alias && fs.existsSync(alias)) return alias;
  } catch { /* continue */ }
  
  // 2. Check PATH resolution
  const resolved = which(name);
  if (resolved) return resolved;
  
  // 3. Check common local install paths
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', name),
    path.join('/usr', 'local', 'bin', name),
  ];
  
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  
  return null;
}
```

### Implement runtime.command dispatch contract

**Critical dispatch contract invariant**: The binary referenced by `runtime.command` must match the binary performing version-sync operations, otherwise infinite restart loops occur.

```typescript
// Version-sync dispatch contract validation
export function validateDispatchContract(currentBinary: string, runtimeCommand: string): boolean {
  // Resolve both paths to canonical forms for comparison
  const currentResolved = path.resolve(currentBinary);
  const commandResolved = path.resolve(runtimeCommand);
  
  // Contract satisfied if they point to the same binary
  return currentResolved === commandResolved;
}

// Three runtime modes requiring different dispatch strategies
export type RuntimeMode = 'global' | 'linked' | 'development';

export function detectRuntimeMode(): RuntimeMode {
  const currentBinary = process.execPath;
  
  // Development mode: running from source via Bun/Node
  if (currentBinary.includes('bun') || currentBinary.includes('node')) {
    return 'development';
  }
  
  // Linked mode: npm link or local binary
  if (currentBinary.includes(os.homedir()) || currentBinary.includes('.local')) {
    return 'linked';
  }
  
  // Global mode: system-wide install
  return 'global';
}

// Version-sync loop prevention during runtime transitions
export async function safeVersionSync(targetVersion: string): Promise<void> {
  const currentBinary = getCurrentBinary();
  const runtimeCommand = readRuntimeCommand();
  
  // Prevent loops: ensure dispatch contract holds
  if (!validateDispatchContract(currentBinary, runtimeCommand)) {
    console.warn(`Dispatch contract violation - stepping aside for binary: ${runtimeCommand}`);
    return; // Let the correct binary handle version sync
  }
  
  // Safe to proceed with version sync
  await performVersionSync(targetVersion);
}
```

### Handle runtime mode transitions

Different runtime modes require coordination during updates:

```typescript
// Coordinate handoff between runtime modes
export async function coordinateRuntimeTransition(
  fromMode: RuntimeMode, 
  toMode: RuntimeMode
): Promise<void> {
  switch (`${fromMode}->${toMode}`) {
    case 'development->global':
      // Update runtime.command to point to global binary
      await updateRuntimeCommand('myco');
      break;
      
    case 'global->development':  
      // Update runtime.command to point to development binary
      const devBinary = path.join(getProjectRoot(), 'vendor', getHostTarget(), 'myco');
      await updateRuntimeCommand(devBinary);
      break;
      
    case 'linked->global':
      // Remove runtime.command override to use global default
      await removeRuntimeCommand();
      break;
  }
  
  // Restart daemon with new runtime mode
  await restartDaemonWithNewRuntime();
}
```

## Asset Access Pattern Migration

When migrating existing Node.js filesystem code to Bun-compatible patterns, follow these systematic steps for package vs user asset boundaries.

### Audit existing filesystem operations

Identify all filesystem reads and categorize by ownership:

```bash
# Find all filesystem read operations in the codebase
grep -r "readFileSync\|createReadStream" packages/myco/src/
grep -r "existsSync\|statSync" packages/myco/src/

# Focus on asset loading patterns across all asset types
grep -r "templates\|manifests\|hooks" packages/myco/src/
```

Categorize each by ownership:
- **Package-owned**: Templates, manifests, hook configs, defaults → should be bundled via appropriate generator
- **User-owned**: Configs, data, sessions, plans → should stay filesystem

### Convert package assets to bundled access

For each package-owned asset, update the loading pattern and target the correct generator:

1. **Add to appropriate template directory**:
```bash
# Installer templates
mv src/config/default.template.json src/symbionts/templates/config/default.template.json

# Symbiont manifests
mv src/manifests/new-agent.json src/symbionts/manifests/new-agent.json

# Hook configurations  
mv src/hooks/new-hook.ts src/hooks/new-hook.ts
```

2. **Regenerate bundled modules**:
```bash
npm run codegen  # Regenerates all *.generated.ts files
```

3. **Update asset loading code**:
```typescript
// Before: Direct filesystem reads
const template = readFileSync('./config/default.template.json', 'utf-8');
const manifest = readFileSync('./manifests/new-agent.json', 'utf-8');

// After: Use appropriate bundled fallback patterns
const installer = new SymbiontInstaller(manifest, projectRoot, packageRoot);
const template = installer.readTemplateFile('config/default.template.json');
if (!template) throw new Error('Default template not found');

const manifestLoader = new ManifestLoader(packageRoot);
const manifest = manifestLoader.readManifestFile('new-agent.json');
if (!manifest) throw new Error('Manifest not found');
```

### Test both access paths

Ensure the migration works in all runtime contexts:

```bash
# Test development mode with filesystem assets
cd packages/myco
bun run src/main.ts

# Test compiled binary mode with bundled assets
npm run build:binary
./vendor/$(node -e "console.log(process.platform + '-' + process.arch)")/myco --version

# Test missing asset scenario for each asset type (should fail gracefully)
rm src/symbionts/templates/config/default.template.json
rm src/symbionts/manifests/new-agent.json
npm run codegen
./vendor/*/myco --version  # Should show appropriate error for each missing type
```

### Handle virtual filesystem diagnostics

Create clear error messages for common virtual filesystem issues:

```typescript
export function diagnoseBunfsError(filePath: string, error: Error): Error {
  if (filePath.includes('/$bunfs/') && error.message.includes('ENOENT')) {
    return new Error(
      `Virtual filesystem access failed: ${filePath}\n` +
      `This usually means the asset was not bundled at build time.\n` +
      `For package assets, add to the appropriate directory and run 'npm run codegen':\n` +
      `  - Templates: src/symbionts/templates/ (gen-templates.mjs)\n` +
      `  - Manifests: src/symbionts/manifests/ (gen-hook-config.ts)\n` +  
      `  - Hook Config: src/hooks/ (gen-hook-config.ts)\n` +
      `For user assets, ensure the path points to a real filesystem location.`
    );
  }
  
  return error;
}

// Usage in asset loading across all types
try {
  return fs.readFileSync(virtualPath, 'utf-8');
} catch (error) {
  throw diagnoseBunfsError(virtualPath, error);
}
```

### Validate the bundling boundary

Ensure package vs user boundaries are correctly implemented across all asset types:

```bash
# Verify package assets are bundled in all generated files
grep -c "src/symbionts/templates" packages/myco/src/symbionts/templates.generated.ts
grep -c "src/symbionts/manifests" packages/myco/src/symbionts/manifests.generated.ts
grep -c "src/hooks" packages/myco/src/hooks/hook-config.generated.ts

# Verify user assets stay on filesystem  
find .myco/ -name "*.json" -o -name "*.yaml" | head -5

# Check no package assets leak to user directories
! find .myco/ -name "manifests" -o -name "templates" -o -name "hooks"
```