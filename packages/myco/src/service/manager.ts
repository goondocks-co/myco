import { LaunchdServiceManager } from './launchd.js';
import { SystemdUserServiceManager } from './systemd.js';
import { UnsupportedServiceManager } from './unsupported.js';
import { resolveServiceUnitDir } from './paths.js';
import type { ServiceManager } from './types.js';

export interface GetServiceManagerOptions {
  platform?: NodeJS.Platform;
}

export function getServiceManager(opts: GetServiceManagerOptions = {}): ServiceManager {
  const platform = opts.platform ?? process.platform;
  switch (platform) {
    case 'darwin':
      return new LaunchdServiceManager({ agentsDir: resolveServiceUnitDir({ platform }) });
    case 'linux':
      return new SystemdUserServiceManager({ unitDir: resolveServiceUnitDir({ platform }) });
    default:
      return new UnsupportedServiceManager(platform);
  }
}
