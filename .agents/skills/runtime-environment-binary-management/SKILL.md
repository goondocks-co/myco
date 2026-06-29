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

## Procedure C: Safe Sandbox Environment for Global Smoke Runs

### The non-negotiable rule

When a smoke run may touch **global symbiont config** (`~/.claude/settings.json`, `~/.cursor/hooks.json`, etc.), never sandbox only `MYCO_HOME`. That was the historical escape hatch that wrote temp launchers like `/tmp/myco-*-smoke-*/home/launcher.cjs` into the developer's real global agent config.

The four env vars must move together:

- `MYCO_SANDBOX_ROOT`
- `HOME`
- `MYCO_HOME`
- `MYCO_LAUNCH_AGENTS_DIR`

### Preferred helper

Use the committed helper instead of hand-rolling exports:

```bash
eval "$(scripts/dev/smoke-sandbox-env.sh subagent-smoke)"
```

This emits a fresh temp sandbox root and exports:

- `MYCO_SANDBOX_ROOT=<tmp>`
- `HOME=<tmp>/home`
- `MYCO_HOME=<tmp>/home/.myco`
- `MYCO_LAUNCH_AGENTS_DIR=<tmp>/launchagents`

The helper exists because manual smoke runs on `global-symbiont-install` used temp homes such as `myco-subagent-smoke`, `myco-final-smoke`, and `myco-wave2-smoke`, but left `HOME` pointing at the real user home. Manifest `globalHooksTarget` expansion then escaped into real files under `~/.claude/`, `~/.cursor/`, `~/.codex/`, `~/.copilot/`, and `~/.codeium/windsurf/`.

### Why `MYCO_SANDBOX_ROOT` matters

`packages/myco/src/grove/paths.ts` now enforces a sandbox sentinel: when `MYCO_SANDBOX_ROOT` is set, `expandHome('~/...')` throws unless `HOME` resolves inside that sandbox. The helper codifies the safe shape so ad hoc smoke commands don't have to remember the contract.

### Practical pattern

```bash
eval "$(scripts/dev/smoke-sandbox-env.sh qa-smoke)"
packages/myco-darwin-arm64/bin/myco doctor
```

If the smoke run also needs a temp repo or worktree fixture, create it UNDER `"$MYCO_SANDBOX_ROOT"` or another temp path — but keep `HOME`, `MYCO_HOME`, and `MYCO_LAUNCH_AGENTS_DIR` anchored to the helper's exported root.

### Never do this

```bash
# WRONG — leaks globalHooksTarget writes into the real home
MYCO_HOME=/tmp/myco-something packages/myco-darwin-arm64/bin/myco update
```

That shape is exactly what created the stale escaped global hook entries the one-shot scrub now repairs.

## Procedure D: Dogfood Routing via Dev-Build Self-Detection

### Development Binary Self-Detection Chain

**Problem:** When Myco is in production globally, contributors developing Myco itself need to route hook invocations to their local dev daemon rather than the production system daemon.

**Real API:** `looksLikeDevBuildExecutable(execPath: string): boolean` in `packages/myco/src/service/spec-builder.ts` is the authoritative dev-build detection function. It inspects the executable path to determine whether the running binary is a development build.

**Guard behavior:** The `assertSafeServiceMutation` guard in `packages/myco/src/cli/service.ts` calls `looksLikeDevBuildExecutable(execPath)` and, if the binary is a dev build **and** `MYCO_HOME` resolves to the default (`~/.myco`), it **refuses** service mutation commands (install/uninstall/start/stop/restart/reconcile):

```
Refusing to <action> the default-home (~/.myco) service from a dev-build binary (<path>).
That service must be managed by the globally installed myco.
To dogfood, point MYCO_HOME at a separate home (e.g. ~/.myco-dev), or run this command
from the installed binary (e.g. /opt/homebrew/lib/node_modules/@goondocks/myco/vendor/<arch>/myco).
```

This prevents dev builds from corrupting the production service's daemon state.

### The Dogfooding Route Chain

To develop Myco while also using the production daemon, choose one approach:

1. **Separate MYCO_HOME (recommended):** Set `MYCO_HOME=~/.myco-dev` before running dev-build service commands. The guard allows mutations on non-default homes, so dev and production daemons co-exist without collision.

   ```bash
   MYCO_HOME=~/.myco-dev bun run packages/myco/src/daemon/main.ts start
   ```

2. **Use installed binary for service mutations:** Run production service management commands from the globally installed binary rather than the dev binary.

### Gotchas in Dogfood Routing

**Default-home guard fires unexpectedly:** If you try to restart the daemon from a dev binary while `MYCO_HOME` is unset (defaults to `~/.myco`), the guard in `packages/myco/src/cli/service.ts` will refuse with a descriptive error message. Set `MYCO_HOME` to a separate path before running service mutations from dev binaries.

---

## Procedure E: Beta Channel Global Replacement Strategy

### Decision: Global-Install Beta Model

Under Myco's **global-install architecture**, beta channel switching uses **global replacement**: users run a command to download and install the beta package globally, which replaces the production-installed Myco binary system-wide.

**Rationale:**
- Global installation means Myco operates as a system-wide tool, not per-project
- Beta testers opt in by running a global replacement command
- No project-level .myco directory changes; only the global installation is affected
- Rollback is clean: reinstall the last production release to revert

### Upgrade Module Architecture

The upgrade implementation lives in `packages/myco/src/upgrade/`. Key exports from `packages/myco/src/upgrade/spawn.ts`:

- `spawnUpdateScript(params: InstallParams)` — spawns a detached script that downloads and installs the new binary
- `spawnApplyUpgrade(namePrefix, params)` — spawns a detached apply script for binary replacement
- `spawnRestartScript(params: RestartParams)` — spawns the restart orchestration after binary swap
- `resolveOrchestratorBinary()` — resolves the binary used to run the orchestrator script

The orchestrator pattern (`packages/myco/src/upgrade/orchestrator.ts`) separates parameter writing from execution: the daemon writes orchestration params to a temp JSON file, then spawns a detached script that reads those params and performs installation + restart, allowing the parent daemon to exit cleanly before the swap completes.

### Beta Channel Workflow

```bash
# User initiates beta channel switch
myco update --channel beta

# Internally:
# 1. Download beta-tagged release from artifact store
# 2. Verify checksum
# 3. spawnApplyUpgrade() / spawnUpdateScript() runs detached
# 4. Daemon exits; detached script performs binary swap + restart
```

### Beta Channel Configuration State

Beta channel preference is stored in `~/.myco/myco.yaml` as a machine-scoped setting (not project-level). Daemon update_channel is machine-scoped — there is no project-level override for the channel setting.

### Gotchas in Beta Channel Switching

**Daemon restart timing gotcha:** On macOS/Linux, the service daemon may be lingering from the old binary. The upgrade scripts handle stopping the daemon before binary replacement to avoid ETXTBSY ("text file busy") errors on Linux.

**Backup path gotcha:** The upgrade module saves a backup of the current binary before replacement. Verify a backup exists before performing manual binary operations.

**Checksum verification gotcha:** Always verify the beta release checksum before performing binary replacement. Never skip this step even during manual testing.

---

## Procedure F: Bun Compilation and Deployment

### Launcher Script Quoting and Path Handling

**Critical issue**: Hook dispatcher scripts (.agents/myco-run.cjs) must properly quote the runtime.command binary path to handle spaces and special characters in launcher paths.

#### Quoted Binary Path Pattern

```javascript
// In .agents/myco-run.cjs (global hook guard)
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

let bin = 'myco';  // Default for global installs
try {
  const aliasPath = path.resolve(__dirname, '..', '.myco', 'runtime.command');
  const alias = fs.readFileSync(aliasPath, 'utf-8').trim();
  if (alias) bin = alias;  // Override with machine-scoped development binary
} catch { /* missing file → use default for global operation */ }

// CRITICAL: Use spawnSync with shell: false to avoid splitting on spaces
try {
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

#### Virtual Filesystem Handling for Global Binary Distribution

Bun binaries use a /$bunfs/ virtual filesystem for bundled content. This creates path resolution challenges that require careful native dependency handling, especially for machine-wide deployment.

## Cross-Cutting Gotchas

**Launcher path quoting gotcha**: Hook dispatcher scripts must use proper shell quoting or direct execution (not through shell) when launching binary paths that contain spaces. Use spawnSync() with shell: false or quote paths explicitly in shell scripts to avoid splitting on spaces.

**Worktree vendor asset loading**: When running development binaries from git worktrees, the package resolution must correctly locate vendor assets. Use import.meta.dirname detection to find assets; don't rely on process.cwd() which may be in a different project entirely.

**Dev-build service isolation**: Dev builds are refused from mutating the default `~/.myco` service by the guard in `packages/myco/src/cli/service.ts`. Use `MYCO_HOME=~/.myco-dev` to run a separate dev daemon alongside the production service. Selection happens via `looksLikeDevBuildExecutable()` + `isDefaultMycoHome()` at command time.

**Beta channel backup safeguard**: Always keep a backup of the production binary before beta channel switching. The upgrade module handles this, but verify the backup exists before manual binary operations.

**`~/.myco/logs/launcher.log` is the first hook failure diagnostic:** The global launcher appends a timestamped one-line record to `~/.myco/logs/launcher.log` on every launch failure — signal kills, `ENOENT`, path-resolution errors, binary exec errors. Check this file before inspecting daemon logs when hooks silently fail to fire. The launcher never throws on log-write failure, so absence of the file means zero hook launch failures (not a broken log path).

**Detached upgrade scripts rewrite hooks before daemon restart:** The upgrade module (`packages/myco/src/upgrade/spawn.ts`) generates scripts spawned detached from the daemon (stdio ignored, unreffed so the parent exits immediately). Within the script, npm installation and hook/plugin file rewriting happen before the daemon respawn — ensuring hooks and daemon always co-ship at the updated version. This is the source of the no-protocol-skew guarantee in capture hooks.
