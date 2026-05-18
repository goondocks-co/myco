/**
 * Daemon intent API — exposes the per-section intent files to the UI
 * and MCP tool layers without requiring callers to touch disk.
 *
 * Routes (all loopback-bearer-gated by the daemon router):
 *   GET    /api/daemon/intent        → { restart, update }
 *   POST   /api/daemon/intent/restart → writes [restart]
 *   POST   /api/daemon/intent/update  → writes [update] with target_version
 *   DELETE /api/daemon/intent/restart → clears the restart section
 *   DELETE /api/daemon/intent/update  → clears the update section
 *
 * Mirrors the CLI surface (`myco restart`, `myco update --target-version`,
 * `myco update --cancel-update`) so an agent has the same daemon-control
 * affordances a human at the terminal does.
 */

import type { RouteHandler } from '../router.js';
import {
  readRestartIntent,
  readUpdateIntent,
  writeRestartIntent,
  writeUpdateIntent,
  clearIntentSection,
  type RestartIntent,
  type UpdateIntent,
} from '../intent.js';
import type { DaemonServiceState } from '../service-state.js';

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface IntentStatusResponse {
  restart: RestartIntent | null;
  update: UpdateIntent | null;
}

export interface IntentHandlers {
  status: RouteHandler;
  requestRestart: RouteHandler;
  requestUpdate: RouteHandler;
  cancelRestart: RouteHandler;
  cancelUpdate: RouteHandler;
}

export function createIntentHandlers(daemonService: DaemonServiceState): IntentHandlers {
  const status: RouteHandler = async () => {
    const body: IntentStatusResponse = {
      restart: readRestartIntent(daemonService) ?? null,
      update: readUpdateIntent(daemonService) ?? null,
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

  const requestUpdate: RouteHandler = async (req) => {
    const body = (req.body ?? {}) as { target_version?: unknown };
    const target = body.target_version;
    if (typeof target !== 'string' || target.trim().length === 0) {
      return { status: 400, body: { error: 'target_version is required (semver string)' } };
    }
    if (!SEMVER_RE.test(target)) {
      // Defense against npm-spec injection: the reconciler interpolates
      // target_version into `${NPM_PACKAGE_NAME}@<value>` for `npm install -g`.
      // npm accepts file:, http:, ssh:, git+ssh: which would steer the
      // install at attacker-controlled packages. Strict semver here OR
      // at the CLI write boundary — both is belt-and-suspenders.
      return {
        status: 400,
        body: {
          error: `target_version must be a strict semver (e.g. 0.27.11); got '${target}'`,
        },
      };
    }
    const intent: UpdateIntent = {
      target_version: target,
      requested_at: new Date().toISOString(),
    };
    writeUpdateIntent(daemonService, intent);
    return { status: 202, body: { ok: true, intent } };
  };

  const cancelRestart: RouteHandler = async () => {
    clearIntentSection(daemonService, 'restart');
    return { status: 200, body: { ok: true } };
  };

  const cancelUpdate: RouteHandler = async () => {
    clearIntentSection(daemonService, 'update');
    return { status: 200, body: { ok: true } };
  };

  return { status, requestRestart, requestUpdate, cancelRestart, cancelUpdate };
}
