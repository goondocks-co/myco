import fs from 'node:fs';
import path from 'node:path';
import { getServiceManager } from '../service/manager.js';
import { buildServiceSpec, looksLikeDevBuildExecutable } from '../service/spec-builder.js';
import { serviceLabel } from '../service/labels.js';
import type { ServiceVariant } from '../service/types.js';
import { isDefaultMycoHome, resolveMycoHome, resolveServiceDir, DAEMON_STATE_FILENAME } from '../grove/paths.js';

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status';

export interface ParsedServiceArgs {
  action: ServiceAction;
  variant: ServiceVariant;
}

const ACTIONS: ServiceAction[] = ['install', 'uninstall', 'start', 'stop', 'restart', 'status'];

export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  if (args.length === 0) {
    throw new Error('Usage: myco service <install|uninstall|start|stop|restart|status> [--dev]');
  }
  const action = args[0] as ServiceAction;
  if (!ACTIONS.includes(action)) {
    throw new Error(`Unknown service action: ${args[0]}`);
  }
  const variant: ServiceVariant = args.includes('--dev') ? 'dev' : 'prod';
  return { action, variant };
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
  const mutating: ReadonlySet<ServiceAction> = new Set(['install', 'uninstall', 'start', 'stop', 'restart']);
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

  switch (parsed.action) {
    case 'install': {
      const spec = buildServiceSpec({ mycoHome, executable: resolveServiceExecutable(mycoHome) });
      await mgr.install(spec, { force: true });
      await mgr.start(label);
      console.log(`Installed ${label} via ${mgr.platformName}`);
      return;
    }
    case 'uninstall':
      await mgr.uninstall(label);
      console.log(`Uninstalled ${label}`);
      return;
    case 'start':
      await mgr.start(label);
      console.log(`Started ${label}`);
      return;
    case 'stop':
      await mgr.stop(label);
      console.log(`Stopped ${label}`);
      return;
    case 'restart':
      await mgr.restart(label);
      console.log(`Restarted ${label}`);
      return;
    case 'status': {
      const st = await mgr.status(label);
      console.log(JSON.stringify({ label, platform: mgr.platformName, ...st }, null, 2));
      return;
    }
  }
}
