import fs from 'node:fs';
import path from 'node:path';
import { getServiceManager } from '../service/manager.js';
import { buildServiceSpec, looksLikeDevBuildExecutable } from '../service/spec-builder.js';
import { serviceLabel } from '../service/labels.js';
import { isDefaultMycoHome, resolveMycoHome, resolveServiceDir, DAEMON_STATE_FILENAME } from '../grove/paths.js';

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status' | 'reconcile';

export interface ParsedServiceArgs {
  action: ServiceAction;
}

const ACTIONS: ServiceAction[] = ['install', 'uninstall', 'start', 'stop', 'restart', 'status', 'reconcile'];

export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  if (args.length === 0) {
    throw new Error('Usage: myco service <install|uninstall|start|stop|restart|status|reconcile>');
  }
  const action = args[0] as ServiceAction;
  if (!ACTIONS.includes(action)) {
    throw new Error(`Unknown service action: ${args[0]}`);
  }
  return { action };
}

/**
 * Resolve the standalone daemon binary path to install into a service unit.
 *
 * Priority order:
 *  1. The currently-running daemon's self-recorded `command` (read from
 *     `<MYCO_HOME>/service/daemon.json`). The daemon writes its own resolved
 *     binary path at startup, so this is the authoritative source.
 *  2. `process.execPath` as a fallback. Works for compiled prod binaries; for
 *     dev-mode invocations through bun/node it returns the wrapper path, which
 *     `buildServiceSpec` will reject downstream.
 */
export function resolveServiceExecutable(mycoHome: string = resolveMycoHome()): string {
  const recorded = readRecordedDaemonCommand(mycoHome);
  if (recorded) return recorded;
  return process.execPath;
}

function readRecordedDaemonCommand(mycoHome: string): string | null {
  try {
    const daemonJsonPath = path.join(resolveServiceDir(mycoHome), DAEMON_STATE_FILENAME);
    if (!fs.existsSync(daemonJsonPath)) return null;
    const raw = fs.readFileSync(daemonJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { command?: string | null };
    return parsed.command ?? null;
  } catch {
    return null;
  }
}

/**
 * Hard fence: a dev-build binary must never manage the DEFAULT-home
 * (`~/.myco`) service — the production install every released user shares.
 *
 * Why this exists: even when the dev binary resolves the correct
 * executable for the prod plist (via daemon.json), `mgr.install`
 * rewrites the plist whenever the rendered content drifts (e.g. when
 * the running binary adds new plist keys like SoftResourceLimits), and
 * the bootout/bootstrap cycle SIGTERMs the running prod daemon
 * mid-flight. The dev binary also has no business uninstalling /
 * restarting / stopping the prod service. Block every mutating verb at
 * the CLI boundary so an accidental `myco service install` from a
 * developer shell can never disturb the default-home daemon. To dogfood,
 * point `MYCO_HOME` at a separate home (e.g. `~/.myco-dev`).
 *
 * Returns a refusal message when the action should be blocked, or null
 * when the action is safe to proceed. Exported for unit tests.
 */
export function assertSafeServiceMutation(
  parsed: ParsedServiceArgs,
  execPath: string,
  mycoHome: string = resolveMycoHome(),
): string | null {
  const mutating: ReadonlySet<ServiceAction> = new Set(['install', 'uninstall', 'start', 'stop', 'restart', 'reconcile']);
  if (!isDefaultMycoHome(mycoHome)) return null;
  if (!mutating.has(parsed.action)) return null;
  if (!looksLikeDevBuildExecutable(execPath)) return null;
  return (
    `Refusing to ${parsed.action} the default-home (~/.myco) service from a dev-build binary (${execPath}). ` +
    `That service must be managed by the globally installed myco. ` +
    `To dogfood, point MYCO_HOME at a separate home (e.g. ~/.myco-dev), or run this command from the installed binary ` +
    `(e.g. /opt/homebrew/lib/node_modules/@goondocks/myco/vendor/<arch>/myco).`
  );
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseServiceArgs(args);
  const mgr = getServiceManager();
  if (!mgr.supported && parsed.action !== 'status') {
    console.error(`Service management not supported on this platform (${mgr.platformName}).`);
    console.error('Run \`myco daemon\` manually instead.');
    process.exit(1);
  }

  const mycoHome = resolveMycoHome();
  const label = serviceLabel(mycoHome);

  const refusal = assertSafeServiceMutation(parsed, process.execPath, mycoHome);
  if (refusal) {
    console.error(refusal);
    process.exit(1);
  }

  // Label-keyed actions act on the OWNING domain (spec R-B1): a boot-scoped
  // daemon's restart must reach the system domain, not a gui/ domain with no
  // job. Install stays login-scoped here; scope transitions are their own
  // operation (`myco service install` reads `daemon.service_scope`).
  const { findInstalledServiceLabel } = await import('../daemon/api/restart.js');
  const owning = async () => (await findInstalledServiceLabel(mgr, mycoHome))?.manager ?? mgr;

  switch (parsed.action) {
    case 'install': {
      const spec = buildServiceSpec({ mycoHome, executable: resolveServiceExecutable(mycoHome) });
      const { loadMachineConfig } = await import('../config/loader.js');
      const {
        getScopedServiceManager, resolveObservedScope, supportsScope, transitionServiceScope,
      } = await import('../service/scoped.js');
      const intent = loadMachineConfig(mycoHome).daemon.service_scope;
      // Refuse root BEFORE anything destructive (round-3 follow-up): on the
      // transition path the renderer's own refusal fires only AFTER the
      // working login unit is uninstalled, and a rollback running as root
      // leaves a root-owned plist in ~/Library/LaunchAgents that the user's
      // daemon can never rewrite again. The renderer check stays as the
      // backstop for every other path.
      if (intent === 'boot' && process.getuid?.() === 0) {
        console.error(
          'Refusing to install a boot-scoped service as root. '
          + 'Run `myco service install` WITHOUT sudo — Myco elevates only the individual steps that need it.',
        );
        process.exit(1);
      }
      const targetScope = { startAt: intent, runAs: 'invoking-user' as const };
      const capability = await supportsScope(targetScope);
      if (!capability.supported) {
        // (Note: `myco service install` is the remediation surface itself —
        // the failure detail explains how to elevate.)
        // §13.8: an unsupported scope THROWS rather than silently doing
        // nothing (a boot option that quietly installs login scope would be
        // the rev-6 defect back again).
        console.error(`Cannot realize service_scope '${intent}' on this machine: ${capability.detail}`);
        process.exit(1);
      }
      const observed = await resolveObservedScope(label);
      const currentScope = observed === 'boot' || observed === 'both'
        ? { startAt: 'boot' as const, runAs: 'invoking-user' as const }
        : { startAt: 'login' as const, runAs: 'invoking-user' as const };
      const target = getScopedServiceManager({ scope: targetScope });
      if (observed === 'none' || currentScope.startAt === intent) {
        if (observed === 'both') {
          console.error(`Both a login and a boot unit exist for ${label}; converging on '${intent}'.`);
        }
        await target.install({ ...spec, scope: targetScope }, { force: true });
        await target.start(label);
        console.log(`Installed ${label} via ${target.platformName}`);
        if (intent === 'boot' && process.platform === 'darwin') {
          console.log(
            'Note: unattended upgrades of a boot-scoped daemon re-run sudo without a terminal. '
            + 'If your user has no passwordless-sudo (NOPASSWD) rule for launchctl/install, restarts '
            + 'after upgrades will need a manual `myco service restart`.',
          );
        }
        return;
      }
      // §13.7: the scope CHANGE is one named operation, CLI-driven. BOTH
      // ends are preflighted (spec M5): boot→login's stop/uninstall need
      // sudo just as much as login→boot's install does.
      if (currentScope.startAt === 'boot' || targetScope.startAt === 'boot') {
        const fromCapability = await supportsScope({ startAt: 'boot', runAs: 'invoking-user' });
        if (!fromCapability.supported) {
          console.error(`Cannot transition service scope: ${fromCapability.detail}`);
          process.exit(1);
        }
      }
      const from = getScopedServiceManager({ scope: currentScope });
      const fromStatus = await from.status(label);
      const { boundedServiceRunner } = await import('../service/scoped.js');
      await transitionServiceScope({
        label,
        spec,
        from: { manager: from, scope: currentScope, unitPath: fromStatus.unitPath ?? '' },
        to: { manager: target, scope: targetScope },
        // Bounded (spec m8/M9): the rollback path re-elevates through this
        // runner; a sudo prompt with no tty must time out, never hang.
        runner: boundedServiceRunner,
        log: (message) => console.log(message),
      });
      console.log(`Transitioned ${label} to ${intent} scope via ${target.platformName}`);
      if (intent === 'boot' && process.platform === 'darwin') {
        // N2: `sudo -n true` passing NOW may be a cached timestamp, not a
        // durable rule — but unattended upgrade restarts re-elevate later
        // with no tty. Disclose instead of discovering it as a fallen-out-
        // of-supervision daemon months from now.
        console.log(
          'Note: unattended upgrades of a boot-scoped daemon re-run sudo without a terminal. '
          + 'If your user has no passwordless-sudo (NOPASSWD) rule for launchctl/install, restarts '
          + 'after upgrades will need a manual `myco service restart`.',
        );
      }
      return;
    }
    case 'uninstall': {
      const target = await owning();
      await target.uninstall(label);
      console.log(`Uninstalled ${label}`);
      return;
    }
    case 'start': {
      const target = await owning();
      await target.start(label);
      console.log(`Started ${label}`);
      return;
    }
    case 'stop': {
      const target = await owning();
      await target.stop(label);
      console.log(`Stopped ${label}`);
      return;
    }
    case 'restart': {
      const target = await owning();
      await target.restart(label);
      console.log(`Restarted ${label}`);
      return;
    }
    case 'status': {
      const target = await owning();
      const st = await target.status(label);
      console.log(JSON.stringify({ label, platform: target.platformName, ...st }, null, 2));
      return;
    }
    case 'reconcile': {
      await reconcile(mgr, mycoHome, label);
      return;
    }
  }
}

/**
 * Re-establish exactly ONE supervisor-tracked daemon for this home, healing a
 * detached/looping state: a daemon that direct-spawned (detached from its
 * launchd job) keeps the lock and serves while the job hot-loops, respawning
 * step-aside daemons.
 *
 * Safe BECAUSE it runs from the CLI (a separate process), so the cooperative
 * shutdown + bootout/bootstrap never targets the caller's own process:
 *   1. Cooperative-shutdown whatever currently holds the port (the detached
 *      usurper) so it drains and releases the lifecycle lock.
 *   2. install(force) re-bootstraps the on-disk (corrected) plist — the loaded
 *      policy becomes current AND a single tracked daemon comes up under it.
 *   3. start ensures it is running; it claims the now-free lock and serves.
 *
 * Exported so the daemon's autonomous detached-state detection and `myco doctor`
 * can drive the same heal.
 */
export async function reconcile(
  mgr: ReturnType<typeof getServiceManager>,
  mycoHome: string,
  label: string,
): Promise<void> {
  const { findInstalledServiceLabel } = await import('../daemon/api/restart.js');
  const found = await findInstalledServiceLabel(mgr, mycoHome);
  if (!found) {
    console.log(`No managed service installed for ${label}; nothing to reconcile.`);
    return;
  }
  if (found.manager !== mgr) {
    // Spec R-B2: reconcile rebuilds a LOGIN unit with force — under boot
    // scope that is exactly the two-units-one-label-two-domains state §13.5
    // forbids, from a daemon-initiated path. Scope changes are operator work.
    console.error(
      `${label} is supervised in the boot domain; \`myco service reconcile\` only manages login-scoped `
      + 'daemons. Use `myco service install` to change scope.',
    );
    process.exit(1);
  }

  const { resolveGlobalDaemonPort } = await import('../daemon/service-state.js');
  const { requestCooperativeShutdown } = await import('../service/cooperative-shutdown.js');
  const port = resolveGlobalDaemonPort(mycoHome);
  const stopped = await requestCooperativeShutdown(port);
  if (!stopped) {
    // The serving daemon did not drain in time. Re-bootstrap still installs the
    // correct policy + a tracked daemon, but if a wedged daemon keeps the lock
    // the fresh one will step aside — surface that rather than claim success.
    console.warn(
      `Warning: daemon on port ${port} did not confirm shutdown; if it is wedged, kill it manually and re-run.`,
    );
  }

  const spec = buildServiceSpec({ mycoHome, executable: resolveServiceExecutable(mycoHome) });
  await mgr.install(spec, { force: true });
  await mgr.start(label);
  console.log(`Reconciled ${label}: one ${mgr.platformName}-tracked daemon.`);
}
