import { getServiceManager } from './manager.js';
import { buildServiceSpec } from './spec-builder.js';
import { serviceLabel } from './labels.js';
import { isDevServiceMode } from '../grove/paths.js';
import type { ServiceManager, ServiceVariant } from './types.js';

interface MinimalLogger {
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
    const status = await mgr.status(label);
    if (status.installed) return;

    const executable = opts.executable ?? process.execPath;
    const spec = buildServiceSpec({ variant, executable });
    await mgr.install(spec);
    logger.info('daemon.service_install', `Installed managed service ${label}`, {
      variant,
      platform: mgr.platformName,
      executable,
    });
  } catch (err) {
    logger.warn('daemon.service_install', 'Service install skipped', {
      error: (err as Error).message,
    });
  }
}
