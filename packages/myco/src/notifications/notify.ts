/**
 * Internal notification emitter.
 *
 * Domain systems call `notify()` to emit notifications. It checks
 * global + domain config, resolves mode/level from registry defaults,
 * and inserts directly into the DB (no HTTP round-trip).
 */

import crypto from 'node:crypto';
import { loadMergedConfig } from '@myco/config/loader.js';
import { insertNotification } from '@myco/db/queries/notifications.js';
import { resolveRequestContextForVault } from '@myco/tools/request-context.js';
import { getType } from './registry.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import type { NotificationMode, NotificationLevel, CreateNotificationPayload } from './types.js';

/**
 * Notification scope.
 *
 * `'project'` (default) writes a row tagged with the resolved project id —
 * what every per-project subsystem (agent tasks, sessions, skills,
 * mycelium) should use. `'daemon'` writes a row with `project_id = NULL`,
 * intended for daemon-global events (auto-backup failure on a cold
 * Grove, version-sync restart) that should appear regardless of which
 * project the user happens to be viewing.
 */
export type NotifyScope = 'project' | 'daemon';

/**
 * Emit a notification. Returns the notification ID if inserted,
 * or null if suppressed by config or undefined vaultDir.
 *
 * Best-effort — catches and logs errors so callers don't need to handle failures.
 *
 * @param vaultDir — vault directory used to load the merged config and
 *   (for project scope) resolve a fallback project id; pass undefined to
 *   no-op so call sites don't need if-guards.
 * @param payload — notification content.
 * @param config — pre-loaded merged config to avoid redundant disk reads.
 * @param options — explicit `projectId` to skip context resolution, or
 *   `scope: 'daemon'` to write a daemon-scope row (`project_id = NULL`).
 */
export function notify(
  vaultDir: string | undefined,
  payload: CreateNotificationPayload,
  config?: MycoConfig,
  options: {
    projectId?: GroveProjectId;
    scope?: NotifyScope;
  } = {},
): string | null {
  if (!vaultDir) return null;

  try {
    const cfg = config ?? loadMergedConfig(vaultDir);

    if (!cfg.notifications.enabled) return null;

    const domainConfig = cfg.notifications.domains[payload.domain];
    if (domainConfig && !domainConfig.enabled) return null;

    // Resolve mode: payload > domain config > global default > type registry default.
    // The project config is the user's explicit preference; registry defaults are
    // only a fallback for older configs and unconfigured callers.
    const registeredType = getType(payload.type);
    const mode: NotificationMode = payload.mode
      ?? domainConfig?.mode
      ?? cfg.notifications.default_mode
      ?? registeredType?.type.defaultMode;
    const level: NotificationLevel = payload.level
      ?? registeredType?.type.defaultLevel
      ?? 'info';

    // Daemon scope writes project_id = NULL; project scope (default)
    // uses the explicit override or falls back to the request context
    // resolved from the vault dir.
    const projectId: GroveProjectId | null = options.scope === 'daemon'
      ? null
      : options.projectId ?? resolveRequestContextForVault(vaultDir).projectId;

    const id = crypto.randomUUID();

    insertNotification({
      id,
      domain: payload.domain,
      type: payload.type,
      level,
      title: payload.title,
      message: payload.message ?? null,
      mode,
      link: payload.link ?? null,
      metadata: payload.metadata ? JSON.stringify(payload.metadata) : null,
      project_id: projectId,
    });

    return id;
  } catch (err) {
    console.warn('[notify] Failed to emit notification:', err instanceof Error ? err.message : err);
    return null;
  }
}
