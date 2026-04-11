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
  NPM_PACKAGE_NAME,
  MYCO_GLOBAL_DIR,
  UPDATE_ERROR_PATH,
  UPDATE_SCRIPT_DELAY_SECONDS,
  RESTART_REASON_FILENAME,
} from '../constants/update.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parameters required to generate and spawn an update script. */
export interface InstallParams {
  /** The target version to install (e.g. "0.11.0"). */
  targetVersion: string;
  /** Absolute path to the project root for `myco update --project`. */
  projectRoot: string;
  /** Absolute path to the vault directory for `myco daemon --vault`. */
  vaultDir: string;
}

// ---------------------------------------------------------------------------
// Script generation
// ---------------------------------------------------------------------------

/**
 * Generates a POSIX shell script string that:
 * 1. Waits UPDATE_SCRIPT_DELAY_SECONDS for the daemon to exit.
 * 2. Runs `npm install -g <package>@<version>`.
 * 3. On success: runs `myco update --project <projectRoot>` (non-fatal).
 * 4. On success: clears ~/.myco/update-error.json.
 * 5. On failure: writes error JSON to ~/.myco/update-error.json.
 * 6. Always: starts `myco daemon --vault <vaultDir>` in background.
 * 7. Cleans up the script file itself.
 */
export function generateUpdateScript(params: InstallParams): string {
  const { targetVersion, projectRoot, vaultDir } = params;

  // Use JSON.stringify for safe path quoting (handles spaces, special chars).
  const packageSpec = `${NPM_PACKAGE_NAME}@${targetVersion}`;
  const quotedProjectRoot = JSON.stringify(projectRoot);
  const quotedVaultDir = JSON.stringify(vaultDir);
  const quotedErrorPath = JSON.stringify(UPDATE_ERROR_PATH);
  const errorJson = JSON.stringify(
    JSON.stringify({ error: `npm install failed for ${packageSpec}` }),
  );

  // Use ${MYCO_CMD:-myco} so dev environments (myco-dev) survive the restart.
  // Matches the myco-run pattern: exec "${MYCO_CMD:-myco}" "$@"
  return `#!/bin/sh
set -e
MYCO="\${MYCO_CMD:-myco}"

# Wait for daemon to exit cleanly
sleep ${UPDATE_SCRIPT_DELAY_SECONDS}

# Attempt the update
if npm install -g ${packageSpec} 2>&1; then
  # Sync project files (gitignore, symbiont registration)
  "$MYCO" update --project ${quotedProjectRoot} || true
  # Clear any previous error
  rm -f ${quotedErrorPath}
else
  # Write error and attempt restart with old version
  echo ${errorJson} > ${quotedErrorPath}
fi

# Restart daemon (works whether install succeeded or failed)
"$MYCO" daemon --vault ${quotedVaultDir} &

# Clean up this script
rm -f "$0"
`;
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
  /** Absolute path to the project root for `myco update --project`. */
  projectRoot: string;
  /** Absolute path to the vault directory for `myco daemon --vault`. */
  vaultDir: string;
  /** Whether to run `myco update --project` before restarting. */
  runLocalUpdate: boolean;
  /** The version currently running (baked into the script to avoid shell interpolation). */
  fromVersion: string;
  /** The version that will be running after restart (baked into the script). */
  toVersion: string;
}

/**
 * Generates a POSIX shell script that:
 * 1. Waits for the daemon to exit.
 * 2. Optionally runs `myco update --project` when runLocalUpdate is true.
 * 3. Writes restart-reason.json into the vault.
 * 4. Starts `myco daemon --vault` in background.
 * 5. Cleans up the script file.
 */
export function generateRestartScript(params: RestartParams): string {
  const { projectRoot, vaultDir, runLocalUpdate, fromVersion, toVersion } = params;
  const quotedProjectRoot = JSON.stringify(projectRoot);
  const quotedVaultDir = JSON.stringify(vaultDir);
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
# Run local project update (hooks, symbionts, gitignore)
"$MYCO" update --project ${quotedProjectRoot} || true`
    : '';

  return `#!/bin/sh
set -e
MYCO="\${MYCO_CMD:-myco}"

# Wait for daemon to exit cleanly
sleep ${UPDATE_SCRIPT_DELAY_SECONDS}
${updateBlock}

# Write restart reason for the new daemon to pick up
echo ${reasonJson} > ${reasonFile}

# Restart daemon
"$MYCO" daemon --vault ${quotedVaultDir} &

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
