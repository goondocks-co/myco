import fs from 'node:fs';
import { getServiceManager } from './manager.js';
import { buildServiceSpec } from './spec-builder.js';
import { serviceLabel } from './labels.js';
import { isDefaultMycoHome, resolveMycoHome } from '../grove/paths.js';
import { managedBinaryPath } from '../install/managed-binary.js';
import type { ServiceManager } from './types.js';

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
  /** Override MYCO_HOME (used by tests). Defaults to the live resolver. */
  mycoHome?: string;
}

/**
 * Returns the executable path the OS service should use.
 *
 * For the DEFAULT home (`~/.myco`), prefers the managed binary at
 * `~/.myco/bin/myco` when it exists — so a self-update's in-place swap of that
 * binary takes effect on the next supervisor restart without the service unit
 * needing rewriting.
 *
 * A non-default home (dogfood, e.g. `~/.myco-dev`) ALWAYS returns
 * `process.execPath` (the running dev-build binary). This is a correctness
 * requirement, not an optimisation: a dogfood daemon must never have its unit
 * re-pointed at the default home's `~/.myco/bin/myco` — that would silently run
 * released code as the dogfood unit, violating home isolation (AGENTS.md).
 *
 * `mycoHome` and `platform` are injectable for deterministic testing.
 */
export function defaultServiceExecutable(
  mycoHome: string = resolveMycoHome(),
  platform: NodeJS.Platform = process.platform,
): string {
  if (isDefaultMycoHome(mycoHome)) {
    const managed = managedBinaryPath(mycoHome, platform, process.env.LOCALAPPDATA);
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

    const mycoHome = opts.mycoHome ?? resolveMycoHome();
    const label = serviceLabel(mycoHome);

    // §13.5: the daemon is a READ-ONLY OBSERVER of boot scope on macOS —
    // realizing it needs sudo the daemon does not have, and rebuilding the
    // default login spec here would create two units, one label, two
    // domains. It refrains from the PRIVILEGED step only (spec R-M2): on
    // Linux boot+invoking-user the unit is the ordinary user unit, and this
    // very install is what keeps it current across binary swaps — only the
    // linger enable is operator work. On platforms where boot is
    // unsupported (win32), a stray `service_scope: boot` keeps realizing
    // login scope; the doctor scope row reports the mismatch.
    if (process.platform === 'darwin') {
      try {
        const { loadMachineConfig } = await import('../config/loader.js');
        const { resolveObservedScope } = await import('./scoped.js');
        const intent = loadMachineConfig(mycoHome).daemon.service_scope;
        if (intent === 'boot') {
          const observed = await resolveObservedScope(label);
          if (observed === 'boot' || observed === 'both') {
            // Realized boot scope: the daemon refrains — refreshing would
            // rebuild a login unit beside the LaunchDaemon (§13.5).
            logger.debug('daemon.service_install', 'Boot-scoped install observed; daemon refrains from self-install', {
              home: mycoHome,
            });
            return;
          }
          // Intent declared but NOT yet realized (observed login/none): the
          // LOGIN unit is still the live scope — keep refreshing it (this
          // install is what re-points it across binary swaps; going stale
          // here is spec M8's finding) and warn about the divergence.
          logger.warn('daemon.service_install', 'service_scope intent is boot but the boot unit is missing — run `myco service install` (the daemon cannot elevate); keeping the login unit current meanwhile', {
            home: mycoHome, intent, observed,
          });
        }
      } catch (err) {
        logger.debug('daemon.service_install', 'Scope-intent read skipped', {
          error: (err as Error).message,
        });
      }
    }

    const wasInstalled = await mgr.isInstalled(label);

    const executable = opts.executable ?? defaultServiceExecutable(mycoHome);
    const spec = buildServiceSpec({ mycoHome, executable });

    // `force: true` would terminate the calling daemon.
    const result = await mgr.install(spec);

    // Sweep superseded sibling units whose target binary is gone (old version
    // dirs, removed dev-build worktrees) so the supervisor stops respawning dead
    // units. Best-effort and never touches our own label (passed as keepLabel).
    try {
      const pruned = (await mgr.pruneSupersededUnits?.(label)) ?? [];
      if (pruned.length > 0) {
        logger.info('daemon.service_install', `Pruned ${pruned.length} superseded service unit(s)`, {
          home: mycoHome, platform: mgr.platformName, pruned,
        });
      }
    } catch (err) {
      logger.debug('daemon.service_install', 'Superseded-unit prune skipped', {
        error: (err as Error).message,
      });
    }

    if (!result.changed) {
      logger.debug('daemon.service_install', `Managed service ${label} unchanged`, {
        home: mycoHome, platform: mgr.platformName, executable,
      });
      return;
    }
    if (!wasInstalled) {
      logger.info('daemon.service_install', `Installed managed service ${label}`, {
        home: mycoHome, platform: mgr.platformName, executable,
      });
      return;
    }
    logger.info('daemon.service_install', `Wrote updated managed service ${label}`, {
      home: mycoHome,
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
