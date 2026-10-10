import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  defaultSpec, installService, startService, stopService, uninstallService,
  statusOfService, reloadServiceDetached, servicePaths,
  type ServiceOptions,
} from '@myco/server/service.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';

it('native service operations require an injected platform', () => {
  const platform = process.env.MYCO_NATIVE_SERVICE_PLATFORM;
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') throw new Error('unknown native service platform');
  const spec = defaultSpec(path.join(process.env.MYCO_HOME!, 'bin', 'myco'), process.env.HOME!, platform, process.env.MYCO_HOME!);
  const paths = servicePaths(spec, platform);
  fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true });
  fs.writeFileSync(paths.unitFile, 'fixture unit');
  const fake = recordingPlatform();
  const stub = process.env.MYCO_NATIVE_SERVICE_STUB === '1';
  const options: ServiceOptions = { platform, ...(stub ? { runner: fake.runner } : {}) };
  switch (process.env.MYCO_NATIVE_SERVICE_OPERATION) {
    case 'install': installService(spec, options); break;
    case 'start': startService(spec, options); break;
    case 'stop': stopService(spec, options); break;
    case 'uninstall': uninstallService(spec, options); break;
    case 'status': statusOfService(spec, options); break;
    case 'reload':
      expect(reloadServiceDetached(spec, { ...options, ...(stub ? { spawnDetached: () => { fake.commands.push('detached reload'); return true; } } : {}) })).toBe(true);
      break;
    default: throw new Error('unknown native service operation');
  }
  expect(fake.commands.length).toBeGreaterThan(0);
});
