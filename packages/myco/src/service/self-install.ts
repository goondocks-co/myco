import fs from 'node:fs';
import os from 'node:os';
import { getServiceManager } from './manager.js';
import { buildServiceSpec } from './spec-builder.js';
import { serviceLabel } from './labels.js';
import { isDevServiceMode } from '../grove/paths.js';
import { managedBinaryPath } from '../install/managed-binary.js';
import type { ServiceManager, ServiceVariant } from './types.js';

interface MinimalLogger {
  debug(kind: string, message: string, meta?: Record<string, unknown>): void;
  info(kind: string, message: string, meta?: Record<string, unknown>): void;
  warn(kind: string, message: string, meta?: Record<string, unknown>): void;
}

export interface SelfInstallOptions {
  /** Override the binary path the service should run. Defaults to `process.execPath`. */
  executable?: string;
  /** Override the manager factory (used by tests). */
  manager?: ServiceManager;
  /** Override the variant resolver (used by tests). */
  variant?: ServiceVariant;
}

/**
 * Returns the executable path the OS service should use.
 *
 * For the prod variant, prefers the managed binary at `~/.myco/bin/myco` when
 * it exists — so a self-update's in-place swap of that binary takes effect on
 * the next supervisor restart without the service unit needing rewriting.
 *
 * The dev variant ALWAYS returns `process.execPath` (the dev-build binary).
 * This is a correctness requirement, not an optimisation: if a prod install
 * also exists on the same machine, a dogfood `service-dev` daemon must never
 * have its unit re-pointed at the prod `~/.myco/bin/myco` — that would
 * silently run released code as the `service-dev` unit, violating strict
 * variant isolation (AGENTS.md).
 *
 * `home` and `platform` are injectable for deterministic testing.
 */
export function defaultServiceExecutable(
  variant: ServiceVariant,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (variant === 'prod') {
    const managed = managedBinaryPath(home, platform);
    if (fs.existsSync(managed)) return managed;
  }
  return process.execPath;
}

/**
 * Ensure the running daemon is installed as a managed OS service.
 *
 * The daemon owns its own service lifecycle: at startup it checks whether the
 * platform supervisor (launchd on macOS, systemd --user on Linux) already has
 * a unit for this variant. If not, it installs one pointing at the running
 * binary. Subsequent startups see the unit present and no-op.
 *
 * Idempotent — relies on `ServiceManager.install`'s content-compare, so a
 * machine that already has the right unit incurs only a status check.
 * Non-fatal — any failure logs at warn level and returns; lazy spawn keeps
 * the daemon usable while doctor surfaces the gap.
 */
export async function ensureSelfInstalledAsService(
  logger: MinimalLogger,
  opts: SelfInstallOptions = {},
): Promise<void> {
  try {
    const mgr = opts.manager ?? getServiceManager();
    if (!mgr.supported) {
      logger.info('daemon.service_install', `Skipping service install (${mgr.platformName})`);
      return;
    }

    const variant = opts.variant ?? (isDevServiceMode() ? 'dev' : 'prod');
    const label = serviceLabel(variant);
    const wasInstalled = await mgr.isInstalled(label);

    const executable = opts.executable ?? defaultServiceExecutable(variant);
    const spec = buildServiceSpec({ variant, executable });

    // `force: true` would terminate the calling daemon.
    const result = await mgr.install(spec);

    if (!result.changed) {
      logger.debug('daemon.service_install', `Managed service ${label} unchanged`, {
        variant, platform: mgr.platformName, executable,
      });
      return;
    }
    if (!wasInstalled) {
      logger.info('daemon.service_install', `Installed managed service ${label}`, {
        variant, platform: mgr.platformName, executable,
      });
      return;
    }
    logger.info('daemon.service_install', `Wrote updated managed service ${label}`, {
      variant,
      platform: mgr.platformName,
      executable,
      supervisor_reloaded: result.supervisorReloaded,
    });
  } catch (err) {
    logger.warn('daemon.service_install', 'Service install skipped', {
      error: (err as Error).message,
    });
  }
}
