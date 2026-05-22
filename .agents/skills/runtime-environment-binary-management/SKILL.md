---
name: myco:runtime-environment-binary-management
description: >
  Procedures for managing binary dispatch, runtime environment resolution, and
  machine-scoped coordination in Myco deployments. Covers layered runtime command
  resolution (~/.myco/runtime.command pins, project overrides, fallback chains),
  machine-scoped runtime architecture, binary masquerade detection and prevention,
  update coordination protocols, and Bun compilation deployment patterns. Use when
  setting up environments, troubleshooting binary dispatch issues, managing
  machine-scoped coordination, or implementing system updates, even if the user
  doesn't explicitly ask for runtime environment management.
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

## Procedure E: Bun Compilation and Deployment

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

### Virtual Filesystem Handling for Global Binary Distribution

Bun binaries use a /$bunfs/ virtual filesystem for bundled content. This creates path resolution challenges that require careful native dependency handling, especially for machine-wide deployment.

(Additional procedures and sections would continue...)

## Cross-Cutting Gotchas

**Launcher path quoting gotcha**: Hook dispatcher scripts must use proper shell quoting or direct execution (not through shell) when launching binary paths that contain spaces. Use spawnSync() with shell: false or quote paths explicitly in shell scripts to avoid splitting on spaces.

**Worktree vendor asset loading**: When running development binaries from git worktrees, the package resolution must correctly locate vendor assets. Use resolvePackageRoot() with import.meta.dirname detection to find assets; don't rely on process.cwd() which may be in a different project entirely.