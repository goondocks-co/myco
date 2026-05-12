import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getServiceManager } from '../service/manager.js';
import { buildServiceSpec } from '../service/spec-builder.js';
import { serviceLabel } from '../service/labels.js';
import type { ServiceVariant } from '../service/types.js';
import { isDevServiceMode } from '../grove/paths.js';

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'status';

export interface ParsedServiceArgs {
  action: ServiceAction;
  variant: ServiceVariant;
}

const ACTIONS: ServiceAction[] = ['install', 'uninstall', 'start', 'stop', 'status'];

export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  if (args.length === 0) {
    throw new Error('Usage: myco service <install|uninstall|start|stop|status> [--dev]');
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
 *     `<mycoHome>/<service|service-dev>/daemon.json`). The daemon writes its
 *     own resolved binary path at startup, so this is the authoritative source.
 *  2. `process.execPath` as a fallback. Works for compiled prod binaries; for
 *     dev-mode invocations through bun/node it returns the wrapper path, which
 *     `buildServiceSpec` will reject downstream.
 */
export function resolveServiceExecutable(variant: ServiceVariant): string {
  const recorded = readRecordedDaemonCommand(variant);
  if (recorded) return recorded;
  return process.execPath;
}

function readRecordedDaemonCommand(variant: ServiceVariant): string | null {
  try {
    const mycoHome = process.env.MYCO_HOME?.trim() || path.join(os.homedir(), '.myco');
    const serviceDir = variant === 'dev' ? 'service-dev' : 'service';
    const daemonJsonPath = path.join(mycoHome, serviceDir, 'daemon.json');
    if (!fs.existsSync(daemonJsonPath)) return null;
    const raw = fs.readFileSync(daemonJsonPath, 'utf-8');
    const parsed = JSON.parse(raw) as { command?: string | null };
    return parsed.command ?? null;
  } catch {
    return null;
  }
}

export function detectInstallVariant(): ServiceVariant {
  return isDevServiceMode() ? 'dev' : 'prod';
}

export async function run(args: string[], _vaultDir: string): Promise<void> {
  const parsed = parseServiceArgs(args);
  const mgr = getServiceManager();
  if (!mgr.supported && parsed.action !== 'status') {
    console.error(`Service management not supported on this platform (${mgr.platformName}).`);
    console.error('Run \`myco daemon\` manually instead.');
    process.exit(1);
  }

  const label = serviceLabel(parsed.variant);

  switch (parsed.action) {
    case 'install': {
      const spec = buildServiceSpec({ variant: parsed.variant, executable: resolveServiceExecutable(parsed.variant) });
      await mgr.install(spec);
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
    case 'status': {
      const st = await mgr.status(label);
      console.log(JSON.stringify({ label, platform: mgr.platformName, ...st }, null, 2));
      return;
    }
  }
}
