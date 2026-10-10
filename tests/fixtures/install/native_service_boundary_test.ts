import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { defaultSpec, installService, startService, stopService, uninstallService, servicePaths, type ServiceOptions } from '@myco/server/service.js';
import { recordingPlatform } from '../../helpers/fake-service-manager.js';

it('native lifecycle uses the supplied platform runner', () => {
  const home = process.env.HOME!;
  const spec = defaultSpec(path.join(home, 'bin', 'myco'), home, 'darwin');
  const platform = recordingPlatform();
  const options: ServiceOptions = { platform: 'darwin', ...(process.env.MYCO_NATIVE_SERVICE_STUB === '1' ? { runner: platform.runner } : {}) };
  const operation = process.env.MYCO_NATIVE_SERVICE_OPERATION;
  if (operation !== 'install') {
    const unitFile = servicePaths(spec, 'darwin').unitFile;
    fs.mkdirSync(path.dirname(unitFile), { recursive: true });
    fs.writeFileSync(unitFile, 'fixture unit');
  }
  if (operation === 'install') expect(installService(spec, options).running).toBe(true);
  else if (operation === 'start') expect(startService(spec, options).running).toBe(true);
  else if (operation === 'stop') stopService(spec, options);
  else if (operation === 'uninstall') uninstallService(spec, options);
  else throw new Error('Unknown fixture operation');
  expect(platform.commands.length).toBeGreaterThan(0);
});
