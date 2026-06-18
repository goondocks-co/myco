/**
 * Daemon intent API — exposes the per-section intent files to the UI
 * and MCP tool layers without requiring callers to touch disk.
 *
 * Routes (all loopback-bearer-gated by the daemon router):
 *   GET    /api/daemon/intent         → { restart }
 *   POST   /api/daemon/intent/restart  → writes [restart]
 *   DELETE /api/daemon/intent/restart  → clears the restart section
 *
 * Mirrors the CLI surface (`myco restart`) so an agent has the same
 * daemon-control affordances a human at the terminal does.
 *
 * The `[update]` intent surface (POST/DELETE /api/daemon/intent/update,
 * requestUpdate/cancelUpdate) was removed in the Task 9 refactor. Binary
 * upgrades are now driven directly by `initiateAdopt` paths via
 * `api/upgrade`. Use `myco upgrade [<version>]` from the CLI.
 */

import type { RouteHandler } from '../router.js';
import {
  readRestartIntent,
  writeRestartIntent,
  clearRestartIntent,
  type RestartIntent,
} from '../intent.js';
import type { DaemonServiceState } from '../service-state.js';

export interface IntentStatusResponse {
  restart: RestartIntent | null;
}

export interface IntentHandlers {
  status: RouteHandler;
  requestRestart: RouteHandler;
  cancelRestart: RouteHandler;
}

export function createIntentHandlers(daemonService: DaemonServiceState): IntentHandlers {
  const status: RouteHandler = async () => {
    const body: IntentStatusResponse = {
      restart: readRestartIntent(daemonService) ?? null,
    };
    return { body };
  };

  const requestRestart: RouteHandler = async (req) => {
    const body = (req.body ?? {}) as { reason?: unknown };
    const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : 'mcp';
    const intent: RestartIntent = {
      requested_at: new Date().toISOString(),
      reason,
    };
    writeRestartIntent(daemonService, intent);
    return { status: 202, body: { ok: true, intent } };
  };

  const cancelRestart: RouteHandler = async () => {
    clearRestartIntent(daemonService);
    return { status: 200, body: { ok: true } };
  };

  return { status, requestRestart, cancelRestart };
}
