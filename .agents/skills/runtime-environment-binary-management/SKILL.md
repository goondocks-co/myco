---
name: myco:runtime-environment-binary-management
description: |
  Procedures for managing binary dispatch, runtime environment resolution, and
  machine-scoped coordination in Myco deployments. Covers layered runtime command
  resolution (~/.myco/runtime.command pins, project overrides, fallback chains),
  machine-scoped runtime architecture, binary masquerade detection and prevention,
  update coordination protocols, Bun compilation deployment patterns, dogfood routing
  via dev-build detection, and beta channel global replacement strategy. Use when
  setting up environments, troubleshooting binary dispatch issues, managing machine-scoped
  coordination, or implementing system updates, even if the user doesn't explicitly
  ask for runtime environment management.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Runtime Environment and Binary Management

Comprehensive procedures for managing Myco's binary dispatch system, runtime environment resolution, and machine-scoped coordination. These procedures ensure reliable binary execution, prevent environment conflicts, and maintain proper isolation across different deployment contexts in the Grove multi-project daemon architecture.

**Architectural shift**: Myco now operates on a **global-first, machine-scoped model** where the machine opts into projects rather than projects configuring themselves. This inverts the traditional project-centric configuration model — global hooks capture everywhere, runtime configuration is machine-scoped by default, and unknown projects operate in quarantine mode until explicitly registered.

## Prerequisites

- Myco installation with proper symbiont structure
- Understanding of Myco's Grove multi-project daemon architecture (packages/myco/src/daemon/)
- Access to runtime configuration files (~/.myco/runtime.command, project-level configs)
- Familiarity with Bun compilation and single-file binary patterns
- Knowledge of Grove registration and project binding patterns
- Understanding of machine-scoped opt-in model and global capture hooks

## Procedure D: Dogfood Routing via Dev-Build Self-Detection

### Development Binary Self-Detection Chain

**Problem:** When Myco is in production globally, contributors developing Myco itself need to route hook invocations to their local dev daemon rather than the production system daemon.

**Solution:** The global launcher uses a **dev-build detection chain** to determine whether the running binary is a development build or production, then routes to the appropriate daemon instance.

### The Dogfooding Route Chain

```typescript
// In ~/.myco/launcher.c (global hook bootstrap)
// Step 1: Hook fires from inside the myco project (e.g., Claude Code)
// Step 2: Global launcher dispatches to the appropriate daemon
// Step 3: Daemon identity is determined by detectDevBuild() check

export function selectDaemonForInvocation(): {
  daemonServicePath: string;
  runtimeCommandPath: string;
} {
  // Pattern: detectDevBuild() checks if current binary is dev or production
  const isDevBuild = detectDevBuild();
  
  if (isDevBuild) {
    // Development: use machine-scoped dev daemon
    // ~/.myco/service-dev/ contains daemon.json for development instance
    return {
      daemonServicePath: path.join(os.homedir(), '.myco', 'service-dev', 'daemon.json'),
      runtimeCommandPath: path.join(os.homedir(), '.myco', 'runtime.command')
    };
  } else {
    // Production: use standard service daemon
    // ~/.myco/service/ contains daemon.json for production instance
    return {
      daemonServicePath: path.join(os.homedir(), '.myco', 'service', 'daemon.json'),
      runtimeCommandPath: path.join(os.homedir(), '.myco', 'runtime.command')
    };
  }
}

// Dev-build detection chain
export function detectDevBuild(): boolean {
  // Priority 1: Check if running inside git worktree with compiled binary
  const gitDir = findNearestGitDir();
  const worktreeMarker = path.join(gitDir, '.git', 'worktrees');
  
  // Priority 2: Check for vendor-src directory (dev artifact not in production binary)
  const vendorSrcDir = path.join(process.execPath, '..', 'vendor-src');
  if (fs.existsSync(vendorSrcDir)) {
    return true;
  }
  
  // Priority 3: Check for uncompiled source markers in execution path
  const sourceMarkers = ['src/', 'packages/myco/src', 'tsconfig.json'];
  const execDir = path.dirname(process.execPath);
  for (const marker of sourceMarkers) {
    if (execDir.includes(marker)) return true;
  }
  
  // Default: assume production
  return false;
}
```

### Machine-Scoped Service Selection Pattern

```typescript
// In packages/myco/src/grove/paths.ts
export class ServicePaths {
  /**
   * Production service daemon lives at ~/.myco/service/daemon.json
   * Development service daemon lives at ~/.myco/service-dev/daemon.json
   * 
   * The selection happens once at process startup (after detectDevBuild())
   * and is immutable per process instance.
   */
  private static selectedServiceDir: string | null = null;
  
  static selectServiceDirectory(): string {
    if (ServicePaths.selectedServiceDir !== null) {
      return ServicePaths.selectedServiceDir;
    }
    
    // Determine at startup (after detectDevBuild())
    const isDev = detectDevBuild();
    const baseDir = path.join(os.homedir(), '.myco');
    
    ServicePaths.selectedServiceDir = isDev 
      ? path.join(baseDir, 'service-dev')
      : path.join(baseDir, 'service');
    
    return ServicePaths.selectedServiceDir;
  }
  
  static getDaemonJsonPath(): string {
    return path.join(ServicePaths.selectServiceDirectory(), 'daemon.json');
  }
}

// Usage in daemon startup
export async function loadDaemonIdentity(): Promise<DaemonRecord> {
  const daemonJsonPath = ServicePaths.getDaemonJsonPath();
  const content = await fs.promises.readFile(daemonJsonPath, 'utf-8');
  return JSON.parse(content);
}
```

### Gotchas in Dogfood Routing

**Stale hook gotcha:** Hooks installed globally may be outdated if Myco binary is updated. Ensure global hooks are regenerated on production upgrade and again on dev-build downgrades.

**Dev-only service directory:** Contributors running dev builds must ensure `~/.myco/service-dev/` exists and is owned by the development daemon, not the production service.

---

## Procedure E: Beta Channel Global Replacement Strategy

### Decision: Global-Install Beta Model

Under Myco's **global-install architecture**, beta channel switching uses **global replacement**: users run a command to download and install the beta package globally, which replaces the production-installed Myco binary system-wide.

**Rationale:**
- Global installation means Myco operates as a system-wide tool, not per-project
- Beta testers opt in by running a global replacement command
- No project-level .myco directory changes; only the global installation is affected
- Rollback is clean: reinstall the last production release to revert

### Global Beta Channel Workflow

#### User Initiates Beta Join

```bash
# User runs command to switch to beta channel
myco install:beta

# Internally, this invokes the global upgrade path:
# 1. Download beta-tagged release from artifact store
# 2. Verify checksum matches expected beta build
# 3. Stop running service daemon (if any)
# 4. Replace global Myco binary with beta build
# 5. Restart daemon to load new binary
```

#### Implementation Pattern

```typescript
// In packages/myco/src/cli/install.ts (or daemon API endpoint)
export async function switchToBetaChannel(): Promise<{ success: boolean; message: string }> {
  // Step 1: Fetch beta release metadata
  const betaRelease = await fetchBetaReleaseMetadata();
  if (!betaRelease) {
    throw new Error('No beta release available');
  }

  // Step 2: Download beta artifact
  const betaPath = await downloadBinaryRelease(betaRelease.downloadUrl, {
    checksumExpected: betaRelease.sha256,
    tempDir: path.join(os.homedir(), '.myco', 'tmp')
  });

  // Step 3: Stop production daemon before binary replacement
  // Use graceful shutdown with timeout (critical to avoid ETXTBSY on Windows)
  await stopDaemonWithTimeout({ timeoutMs: 30000 });

  // Step 4: Global replacement - swap binary atomically
  const globalBinPath = path.join(os.homedir(), '.myco', 'bin', 'myco');
  const backupPath = path.join(os.homedir(), '.myco', 'bin', 'myco.production');
  
  await fsAtomicReplace(globalBinPath, betaPath, {
    backupPath,  // Save production binary for rollback
    mode: 0o755
  });

  // Step 5: Restart daemon with new beta binary
  // Service daemon will auto-restart via systemd/launchd
  await startDaemon({
    waitForHealthy: true,
    timeoutMs: 30000
  });

  return {
    success: true,
    message: `Switched to beta channel. Running ${betaRelease.version}`
  };
}

// Atomic replacement with backup pattern
async function fsAtomicReplace(
  targetPath: string,
  sourcePath: string,
  opts: { backupPath: string; mode: number }
): Promise<void> {
  // Pattern: Backup original, move new to target, verify
  
  if (fs.existsSync(targetPath)) {
    await fs.promises.rename(targetPath, opts.backupPath);
  }
  
  try {
    await fs.promises.copyFile(sourcePath, targetPath);
    await fs.promises.chmod(targetPath, opts.mode);
    
    // Verify new binary is executable
    const isExecutable = await isFileExecutable(targetPath);
    if (!isExecutable) {
      throw new Error(`New binary not executable: ${targetPath}`);
    }
  } catch (err) {
    // Rollback to backup on failure
    if (fs.existsSync(opts.backupPath)) {
      await fs.promises.rename(opts.backupPath, targetPath);
    }
    throw err;
  }
}
```

### Beta Channel Rollback Pattern

```typescript
export async function rollbackBetaToPrevious(): Promise<{ success: boolean; version: string }> {
  const backupPath = path.join(os.homedir(), '.myco', 'bin', 'myco.production');
  const globalBinPath = path.join(os.homedir(), '.myco', 'bin', 'myco');

  if (!fs.existsSync(backupPath)) {
    throw new Error('No production backup available for rollback');
  }

  // Stop daemon before rollback
  await stopDaemonWithTimeout({ timeoutMs: 30000 });

  // Restore production binary
  await fs.promises.rename(backupPath, globalBinPath);
  await fs.promises.chmod(globalBinPath, 0o755);

  // Restart with production binary
  await startDaemon({ waitForHealthy: true });

  // Verify version
  const versionOutput = await execSync('myco --version');
  return {
    success: true,
    version: parseVersionFromOutput(versionOutput)
  };
}
```

### Beta Channel Configuration State

```typescript
// In ~/.myco/myco.yaml
export interface BetaChannelState {
  enabled: boolean;
  currentRelease: string;       // e.g., "2.15.0-beta.2"
  productionBackupPath: string; // Path to production binary backup
  switchedAt: number;           // Unix timestamp
  canRollback: boolean;
}

// Query current channel
export async function getCurrentChannel(): Promise<'production' | 'beta'> {
  const config = await loadConfig();
  return config.beta?.enabled ? 'beta' : 'production';
}
```

### Gotchas in Beta Channel Switching

**Daemon restart timing gotcha:** On macOS/Linux, the service daemon may be lingering from the old binary. Use `launchctl unload` or `systemctl stop` before binary replacement to avoid ETXTBSY ("text file busy") errors.

**Backup path gotcha:** The backup production binary must be saved before replacement and stored outside the executable location to prevent accidental cleanup. Use `~/.myco/bin/myco.production` as the canonical backup location.

**Checksum verification gotcha:** Always verify the beta release checksum before performing binary replacement. Use SHA-256 hashes published alongside the release.

---

## Procedure F: Bun Compilation and Deployment

### Launcher Script Quoting and Path Handling

**Critical issue**: Hook dispatcher scripts (.agents/myco-run.cjs) must properly quote the runtime.command binary path to handle spaces and special characters in launcher paths.

#### Quoted Binary Path Pattern

```javascript
// In .agents/myco-run.cjs (global hook guard)
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

let bin = 'myco';  // Default for global installs
try {
  const aliasPath = path.resolve(__dirname, '..', '.myco', 'runtime.command');
  const alias = fs.readFileSync(aliasPath, 'utf-8').trim();
  if (alias) bin = alias;  // Override with machine-scoped development binary
} catch { /* missing file → use default for global operation */ }

// CRITICAL: Quote the binary path to handle spaces
try {
  // WRONG: Binary path with spaces will be split into multiple args
  execFileSync(bin, process.argv.slice(2), { stdio: 'inherit' });
  
  // RIGHT: Use shell quoting for binary paths with spaces
  const { spawnSync } = require('child_process');
  spawnSync(bin, process.argv.slice(2), {
    stdio: 'inherit',
    shell: false, // Direct execution, not through shell
    windowsHide: true
  });
} catch (e) {
  if (e.code === 'ENOENT') process.exit(0);  // Silent no-op for missing myco in global context
  process.exit(e.status ?? 1);
}
```

#### Worktree Vendor Assets and Path Resolution

**Issue**: When Myco is run from a git worktree with development assets, the runtime.command binary must correctly locate and load vendor assets (libsqlite3, sqlite-vec, ripgrep) from the development binary's directory.

```typescript
// In src/runtime/resolve-package.ts (package root discovery for worktree)
export function resolvePackageRoot(): string {
  // Pattern: Try import.meta.dirname first (works in dev and compiled),
  // then fallback to process.execPath (for compiled binaries),
  // then process.cwd() (last resort)
  
  // 1. Development: import.meta.dirname points to source directory
  if (typeof import.meta.dirname === 'string' && !import.meta.dirname.includes('/$bunfs/')) {
    return path.resolve(import.meta.dirname, '..', '..');
  }
  
  // 2. Compiled binary: process.execPath points to binary location
  if (process.execPath && process.execPath !== process.argv0) {
    return path.dirname(process.execPath);
  }
  
  // 3. Last resort: working directory (may not have vendor assets)
  return process.cwd();
}

// In src/daemon/main.ts (vendor asset loading for global operation)
export async function loadVendorAssets() {
  const pkgRoot = resolvePackageRoot();
  const vendorDir = path.join(pkgRoot, 'vendor-src');
  
  // Load embedded native dependencies from vendor directory
  const libsqlitePath = path.join(vendorDir, 'libsqlite3', 'darwin-arm64', 'libsqlite3.dylib');
  process.env.MYCO_LIBSQLITE_PATH = libsqlitePath;
  
  // Verify vendor assets exist (critical for global deployment)
  if (!fs.existsSync(libsqlitePath)) {
    throw new Error(`Vendor asset not found: ${libsqlitePath}`);
  }
}
```

#### Virtual Filesystem Handling for Global Binary Distribution

Bun binaries use a /$bunfs/ virtual filesystem for bundled content. This creates path resolution challenges that require careful native dependency handling, especially for machine-wide deployment.

## Cross-Cutting Gotchas

**Launcher path quoting gotcha**: Hook dispatcher scripts must use proper shell quoting or direct execution (not through shell) when launching binary paths that contain spaces. Use spawnSync() with shell: false or quote paths explicitly in shell scripts to avoid splitting on spaces.

**Worktree vendor asset loading**: When running development binaries from git worktrees, the package resolution must correctly locate vendor assets. Use resolvePackageRoot() with import.meta.dirname detection to find assets; don't rely on process.cwd() which may be in a different project entirely.

**Service directory isolation**: Dev and production service daemons must use separate directories (~/.myco/service-dev/ and ~/.myco/service/) to prevent state conflicts. The service directory selection happens once at process startup and is immutable for that instance.

**Beta channel backup safeguard**: Always keep a backup of the production binary before beta channel switching. The backup path (~/.myco/bin/myco.production) must be outside normal executable locations to prevent accidental deletion or overwriting.