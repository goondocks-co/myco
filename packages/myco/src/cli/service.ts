import { getServiceManager } from '../service/manager.js';
import { buildServiceSpec } from '../service/spec-builder.js';
import { serviceLabel } from '../service/labels.js';
import type { ServiceVariant } from '../service/types.js';
import { resolveCliEntryPath } from '../hooks/client.js';

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

/** Resolve the executable that should run inside the service. */
export function resolveServiceExecutable(): string {
  const { execPath } = resolveCliEntryPath();
  return execPath;
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
      const spec = buildServiceSpec({ variant: parsed.variant, executable: resolveServiceExecutable() });
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
