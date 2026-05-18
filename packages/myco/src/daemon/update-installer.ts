/**
 * Update installer — generates and spawns a detached shell script that installs
 * the npm update and restarts the daemon after the current process exits.
 *
 * The script is written to a temp file with mode 0o755, spawned detached with
 * stdio ignored, and unreffed so the parent process can exit immediately.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  MYCO_GLOBAL_DIR,
  UPDATE_ERROR_PATH,
  UPDATE_SCRIPT_DELAY_SECONDS,
  RESTART_REASON_FILENAME,
} from '../constants/update.js';
import {
  resolveMachineRuntimeCommandPath,
  resolveMachineRuntimeDir,
  resolveMachineRuntimeTmpDir,
} from '../grove/paths.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parameters required to generate and spawn an update script. */
export interface InstallParams {
  /** Fully-qualified npm package specs to install globally (e.g. ["@goondocks/myco-team@0.11.0"]). */
  packageSpecs: string[];
  /** Optional core Myco package spec to install into the managed machine runtime. */
  localRuntimeSpec?: string;
  /** Remove the managed machine runtime after a successful stable-channel apply. */
  removeLocalRuntime?: boolean;
  /** Absolute path to the project root the daemon was running from (used as cwd for the respawn). */
  projectRoot: string;
  /** Absolute path to the vault directory the daemon was running against (used as cwd for the respawn). */
  vaultDir: string;
  /**
   * Literal myco binary the script should invoke for the post-install
   * project sync step and the final daemon respawn. Baked into the
   * script at generation time — see `resolveMycoBinary()` in update-checker
   * for how the daemon picks it (dev build CLI entry in dev mode, bare
   * `myco` in prod).
   */
  mycoBinary: string;
  /**
   * Literal shell command that restarts the daemon via the platform
   * service manager (launchctl kickstart / systemctl --user restart).
   * When set, the generated script invokes this command instead of
   * spawning `<mycoBinary> daemon` directly — preventing the
   * thundering-herd race between a manually-spawned daemon child and
   * the service supervisor's KeepAlive/Restart=always policy.
   *
   * Callers should derive this from `ServiceManager.restartShellCommand(label)`
   * only when `detectServiceManagedLabel()` confirms this process is the
   * service-managed daemon.
   */
  serviceRestartCommand?: string;
  /**
   * Canonical daemon port for the variant this update is running against
   * (e.g. 20915 prod, 19344 dev). Used by the post-install readiness
   * probe to skip the supervisor restart when launchd's KeepAlive has
   * already brought the daemon back at the target version. Without this
   * probe, `kickstart -k` unconditionally SIGTERMs the freshly-respawned
   * daemon and forces a redundant cycle through the throttle window.
   */
  daemonPort: number;
  /**
   * The version we expect the daemon to be running after this update
   * (e.g. "0.27.12"). The readiness probe verifies /health.version
   * matches before skipping the supervisor restart.
   */
  targetVersion: string;
}

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

/**
 * Generates a POSIX shell script string that:
 * 1. Waits UPDATE_SCRIPT_DELAY_SECONDS for the daemon to exit.
 * 2. Runs `npm install -g <package>@<version>`.
 * 3. On success: runs `myco update --all-projects` (non-fatal). Iterates
 *    every (Grove, project) registered with this machine's daemon and
 *    syncs each project's symbiont/skill/manifest files to the new
 *    binary's templates. The single-daemon Grove era replaces the old
 *    "each project's daemon syncs itself" loop with this fan-out.
 * 4. On success: clears ~/.myco/update-error.json.
 * 5. On failure: writes error JSON to ~/.myco/update-error.json.
 * 6. Always: `cd <projectRoot> && myco daemon &` so the new daemon's
 *    resolveVaultDir picks up the vault from cwd.
 * 7. Cleans up the script file itself.
 */
export function generateUpdateScript(params: InstallParams): string {
  const {
    packageSpecs,
    localRuntimeSpec,
    removeLocalRuntime = false,
    projectRoot,
    mycoBinary,
    serviceRestartCommand,
    daemonPort,
    targetVersion,
  } = params;

  // Use JSON.stringify for safe path quoting (handles spaces, special chars).
  const installArgs = packageSpecs.map((spec) => JSON.stringify(spec)).join(' ');
  const quotedProjectRoot = JSON.stringify(projectRoot);
  const quotedMycoBinary = JSON.stringify(mycoBinary);
  const quotedErrorPath = JSON.stringify(UPDATE_ERROR_PATH);
  const machineRuntimeDir = resolveMachineRuntimeDir();
  const machineRuntimeTmpDir = resolveMachineRuntimeTmpDir();
  const machineRuntimeCommandPath = resolveMachineRuntimeCommandPath();
  const machineRuntimeMyco = path.join(machineRuntimeDir, 'node_modules', '.bin', 'myco');
  const quotedLocalRuntimeSpec = localRuntimeSpec ? JSON.stringify(localRuntimeSpec) : null;
  const quotedLocalRuntimeDir = JSON.stringify(machineRuntimeDir);
  const quotedLocalRuntimeTmpDir = JSON.stringify(machineRuntimeTmpDir);
  const quotedLocalRuntimeCommandPath = JSON.stringify(machineRuntimeCommandPath);
  const quotedLocalRuntimeMyco = JSON.stringify(machineRuntimeMyco);
  const errorJson = JSON.stringify(
    JSON.stringify({ error: `npm install failed for ${[...packageSpecs, localRuntimeSpec].filter(Boolean).join(', ')}` }),
  );

  // Bake the literal myco binary into the script at generation time. Prod
  // installs get `"myco"` (PATH-resolves to the freshly-updated global
  // binary). Dev builds get the CLI entry path recorded in update-checker
  // state, so the restart respawns the same dev binary regardless of what
  // the global install looks like after the upgrade.
  return `#!/bin/sh
set -e
MYCO=${quotedMycoBinary}

# Wait for daemon to exit cleanly
sleep ${UPDATE_SCRIPT_DELAY_SECONDS}

update_failed=0

${quotedLocalRuntimeSpec ? `rm -rf ${quotedLocalRuntimeTmpDir}
if npm install --prefix ${quotedLocalRuntimeTmpDir} ${quotedLocalRuntimeSpec} 2>&1; then
  rm -rf ${quotedLocalRuntimeDir}
  mv ${quotedLocalRuntimeTmpDir} ${quotedLocalRuntimeDir}
  printf '%s\\n' ${quotedLocalRuntimeMyco} > ${quotedLocalRuntimeCommandPath}
  MYCO=${quotedLocalRuntimeMyco}
else
  rm -rf ${quotedLocalRuntimeTmpDir}
  update_failed=1
fi
` : ''}${installArgs ? `if [ "$update_failed" -eq 0 ]; then
  if ! npm install -g ${installArgs} 2>&1; then
    update_failed=1
  fi
fi
` : ''}${removeLocalRuntime ? `if [ "$update_failed" -eq 0 ]; then
  rm -f ${quotedLocalRuntimeCommandPath}
  rm -rf ${quotedLocalRuntimeDir}
  MYCO="myco"
fi
` : ''}if [ "$update_failed" -eq 0 ]; then
  # Fan out per-project sync (gitignore, symbiont registration) across
  # every Grove project registered with this machine.
  "$MYCO" update --all-projects || true
  # Clear any previous error
  rm -f ${quotedErrorPath}
else
  # Write error and attempt restart with old version
  echo ${errorJson} > ${quotedErrorPath}
  MYCO=${quotedMycoBinary}
fi

${buildReadinessGuard(daemonPort, targetVersion)}
${buildRestartTail(serviceRestartCommand, quotedProjectRoot)}

# Clean up this script
rm -f "$0"
`;
}

/**
 * Pre-restart readiness guard. Probes /health on the canonical port; if
 * the daemon already reports the target version, launchd's KeepAlive has
 * brought it back from the freshly-installed binary and we must NOT
 * kickstart — kickstart -k unconditionally SIGTERMs and forces a
 * redundant respawn through launchd's throttle window (~10s of dead
 * daemon for the user).
 *
 * Uses curl + grep so the script stays portable (no jq dependency).
 */
function buildReadinessGuard(daemonPort: number, targetVersion: string): string {
  const url = `http://127.0.0.1:${daemonPort}/health`;
  // grep pattern: match "version":"<target>" with optional whitespace.
  // The daemon's /health body shape is {"myco":true,"version":"X","pid":Y,"uptime":Z}.
  return `# Readiness guard: skip supervisor restart if launchd already brought
# the daemon back at the target version. See generateUpdateScript().
if curl -sf --max-time 2 ${JSON.stringify(url)} 2>/dev/null \\
   | grep -q '"version":"${targetVersion}"'; then
  echo "[update] daemon already on ${targetVersion} — skipping supervisor restart"
  rm -f "$0"
  exit 0
fi`;
}

/**
 * Final-line restart tail for the generated script.
 *
 * - Service-managed: invoke the platform's restart primitive (literal command
 *   pre-resolved at generation time). The supervisor respawns the daemon
 *   from its installed path, which now resolves to the freshly-installed
 *   binary. No `cd` needed — the service definition pins workingDir.
 * - Non-service-managed: `cd <projectRoot> && "$MYCO" daemon &` so the new
 *   daemon's resolveVaultDir picks up the vault from cwd.
 */
function buildRestartTail(
  serviceRestartCommand: string | undefined,
  quotedProjectRoot: string,
): string {
  if (serviceRestartCommand) {
    return `# Restart via platform service manager (no parallel daemon spawn).
${serviceRestartCommand}`;
  }
  return `# Restart daemon (works whether install succeeded or failed)
cd ${quotedProjectRoot} && "$MYCO" daemon &`;
}

// ---------------------------------------------------------------------------
// Script spawning
// ---------------------------------------------------------------------------

/**
 * Writes a script to a temp file, spawns it detached, and unrefs the child
 * so the parent process can exit without waiting.
 */
function spawnDetachedScript(namePrefix: string, content: string): string {
  const scriptPath = path.join(os.tmpdir(), `${namePrefix}-${Date.now()}.sh`);
  fs.writeFileSync(scriptPath, content, { encoding: 'utf-8', mode: 0o755 });

  const child = spawn('/bin/sh', [scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return scriptPath;
}

/**
 * Generates and spawns the update script. Returns the script path.
 */
export function spawnUpdateScript(params: InstallParams): string {
  // Ensure ~/.myco/ exists before writing the error path or checking state.
  fs.mkdirSync(MYCO_GLOBAL_DIR, { recursive: true });
  return spawnDetachedScript('myco-update', generateUpdateScript(params));
}

// ---------------------------------------------------------------------------
// Restart script (no npm install — just restart + conditional local update)
// ---------------------------------------------------------------------------

/** Parameters for a restart-only script (no global npm install). */
export interface RestartParams {
  /** Absolute path to the project root the daemon was running from (used as cwd for the respawn). */
  projectRoot: string;
  /** Absolute path to the vault directory (used to write restart-reason.json). */
  vaultDir: string;
  /** Whether to run `myco update --all-projects` before restarting. */
  runLocalUpdate: boolean;
  /** The version currently running (baked into the script to avoid shell interpolation). */
  fromVersion: string;
  /** The version that will be running after restart (baked into the script). */
  toVersion: string;
  /**
   * Literal myco binary the script should invoke for the optional
   * project sync step and the final daemon respawn. Baked into the
   * script at generation time; see `resolveMycoBinary()` in
   * update-checker for how callers pick it.
   */
  mycoBinary: string;
  /**
   * Literal shell command that restarts the daemon via the platform
   * service manager (launchctl kickstart / systemctl --user restart).
   * See `InstallParams.serviceRestartCommand` for the full rationale —
   * same fix shape.
   */
  serviceRestartCommand?: string;
  /** Canonical daemon port for the readiness guard. See InstallParams. */
  daemonPort: number;
}

/**
 * Generates a POSIX shell script that:
 * 1. Waits for the daemon to exit.
 * 2. Optionally runs `myco update --all-projects` when runLocalUpdate is
 *    true — fans the per-project sync out across every Grove project.
 * 3. Writes restart-reason.json into the vault.
 * 4. `cd <projectRoot> && myco daemon &` so resolveVaultDir picks up the vault.
 * 5. Cleans up the script file.
 */
export function generateRestartScript(params: RestartParams): string {
  const {
    projectRoot,
    vaultDir,
    runLocalUpdate,
    fromVersion,
    toVersion,
    mycoBinary,
    serviceRestartCommand,
    daemonPort,
  } = params;
  const quotedProjectRoot = JSON.stringify(projectRoot);
  const quotedMycoBinary = JSON.stringify(mycoBinary);
  const reasonFile = JSON.stringify(path.join(vaultDir, RESTART_REASON_FILENAME));

  // Bake version strings and reason JSON from Node to avoid shell interpolation
  // in heredocs — prevents JSON corruption from unexpected characters.
  const reasonJson = JSON.stringify(JSON.stringify({
    reason: 'version_sync',
    from_version: fromVersion,
    to_version: toVersion,
    local_update_ran: runLocalUpdate,
  }));

  const updateBlock = runLocalUpdate
    ? `
# Fan out per-project sync (hooks, symbionts, gitignore) across every Grove
"$MYCO" update --all-projects || true`
    : '';

  // MYCO is baked as a literal at generation time — see InstallParams
  // docstring for the dev vs prod binary selection rationale.
  return `#!/bin/sh
set -e
MYCO=${quotedMycoBinary}

# Wait for daemon to exit cleanly
sleep ${UPDATE_SCRIPT_DELAY_SECONDS}
${updateBlock}

# Write restart reason for the new daemon to pick up
echo ${reasonJson} > ${reasonFile}

${buildReadinessGuard(daemonPort, toVersion)}
${buildRestartTail(serviceRestartCommand, quotedProjectRoot)}

# Clean up this script
rm -f "$0"
`;
}

/**
 * Generates and spawns the restart script. Returns the script path.
 */
export function spawnRestartScript(params: RestartParams): string {
  return spawnDetachedScript('myco-restart', generateRestartScript(params));
}
