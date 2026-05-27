/**
 * Global launcher install — `~/.myco/launcher.cjs` and
 * `~/.myco/mcp-launcher.cjs`.
 *
 * One template, two installed copies. Both files are written atomically
 * via `atomicWriteFileSync` so a torn write can't leave an agent's hook
 * command pointing at a half-finished file. Permissions: 0o755 so node
 * can spawn them under restrictive umasks.
 *
 * Two call sites:
 *
 *   1. First-start bootstrap: the daemon writes the launchers directly
 *      via `installGlobalLaunchers()`. Safe at first start because no
 *      other daemon owns `~/.myco/` yet — there's no running peer to
 *      race against.
 *
 *   2. Refresh during a running daemon (e.g. version-drift auto-update):
 *      the bootstrap path raises a `refresh-launchers` intent
 *      (intent.refresh-launchers.toml). The daemon's self-reconcile loop
 *      drains the intent and calls `installGlobalLaunchers()` itself, so
 *      writes always happen on the daemon thread — no read/write race
 *      with the hook scripts those launchers serve. Mirrors PR #305's
 *      self-mutation discipline for the existing restart/update intents.
 *
 * Write-ordering invariant: launchers MUST be written before any agent's
 * global config is updated to reference them. Hook config that points at
 * a not-yet-existent launcher leaves a multi-second window where every
 * hook fires `ENOENT` and capture goes silent. Callers responsible for
 * the agent-config write must `await installGlobalLaunchers()` first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { resolveMycoHome } from './paths.js';
import { BUNDLED_TEMPLATES } from '../symbionts/templates.generated.js';
import type { DaemonServiceState } from '../daemon/service-state.js';

const LAUNCHER_TEMPLATE_KEY = '_shared/global-launcher.cjs';

/** Filenames the launcher is installed under (mode is encoded in the basename). */
const LAUNCHER_FILENAMES = ['launcher.cjs', 'mcp-launcher.cjs'] as const;

/**
 * When the daemon is the active process, all launcher refreshes flow
 * through the `refresh-launchers` intent — the daemon's self-reconcile
 * loop drains the intent on its own thread, serializing self-mutation
 * with every other intent (update, restart). Established as a context
 * binding rather than a per-call argument so the install-time bootstrap
 * path (`runGlobalBootstrap` at first daemon start) doesn't need to
 * know about the daemon's intent surface; only the daemon binds the
 * context.
 */
let daemonIntentContext: DaemonServiceState | null = null;

export function bindDaemonForLauncherRefresh(daemonService: DaemonServiceState): void {
  daemonIntentContext = daemonService;
}

export function unbindDaemonForLauncherRefresh(): void {
  daemonIntentContext = null;
}

export interface InstalledLauncherReport {
  /** Absolute paths actually written this call (skipped paths are absent). */
  written: string[];
  /** Absolute paths whose content matched the template already (no write). */
  unchanged: string[];
}

/**
 * Install or refresh `~/.myco/launcher.cjs` and `~/.myco/mcp-launcher.cjs`.
 * Idempotent — a file with content matching the template is skipped.
 * Returns the set of paths actually written and the set skipped so callers
 * (and tests) can assert exactly what happened.
 *
 * When a daemon is running, this routes through the `refresh-launchers`
 * intent so the daemon's main thread does the write — single
 * self-mutation discipline per PR #305. Callers running INSIDE the
 * daemon's reconciler (where the write must actually happen) pass
 * `skipIntent: true` to bypass the intent path and write directly.
 */
export function installGlobalLaunchers(
  mycoHome = resolveMycoHome(),
  options: { skipIntent?: boolean } = {},
): InstalledLauncherReport {
  const template = BUNDLED_TEMPLATES[LAUNCHER_TEMPLATE_KEY];
  if (!template) {
    throw new Error(`Global launcher template missing from bundled assets: ${LAUNCHER_TEMPLATE_KEY}`);
  }
  // `atomicWriteFileSync` opens the temp file in the target dir before
  // rename — mkdir the parent first so a greenfield install (where
  // `~/.myco/` doesn't exist yet) doesn't fail with ENOENT.
  fs.mkdirSync(mycoHome, { recursive: true });
  const report: InstalledLauncherReport = { written: [], unchanged: [] };
  const needsWrite: string[] = [];
  for (const filename of LAUNCHER_FILENAMES) {
    const target = path.join(mycoHome, filename);
    if (readFileQuiet(target) === template) {
      report.unchanged.push(target);
      continue;
    }
    needsWrite.push(target);
  }

  if (needsWrite.length === 0) return report;

  // When a daemon owns this machine's launcher refresh, raise the
  // `refresh-launchers` intent instead of writing directly so the
  // daemon's self-reconcile loop performs the write on its main
  // thread. atomicWriteFileSync already protects against torn reads,
  // but the intent path also serializes against concurrent restart /
  // update intents — single self-mutation discipline (PR #305).
  // Callers running INSIDE the reconciler pass `skipIntent: true`
  // (otherwise the reconciler raises a new intent every time it
  // observes the old one, and the launcher files never get written).
  if (daemonIntentContext && !options.skipIntent) {
    // Defer the import so this module stays loadable in CLI contexts
    // that never touch the daemon state surface.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { writeRefreshLaunchersIntent } = require('../daemon/intent.js') as typeof import('../daemon/intent.js');
    writeRefreshLaunchersIntent(daemonIntentContext, {
      requested_at: new Date().toISOString(),
      reason: 'detection-tick',
    });
    // Report the launchers as "pending write via intent" by leaving
    // them in `report.unchanged` — they'll be (re)written on the next
    // reconciler tick. The intent file is the durable record.
    for (const target of needsWrite) report.unchanged.push(target);
    return report;
  }

  for (const target of needsWrite) {
    atomicWriteFileSync(target, template, { mode: 0o755 });
    report.written.push(target);
  }
  return report;
}

function readFileQuiet(target: string): string | null {
  try {
    return fs.readFileSync(target, 'utf-8');
  } catch {
    return null;
  }
}
