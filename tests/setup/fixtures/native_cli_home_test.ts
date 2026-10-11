import { expect, it, mock } from 'bun:test';
import path from 'node:path';
import * as service from '@myco/server/service.js';

it('CLI installation uses the same resolved Myco home as native setup', async () => {
  process.env.MYCO_HOME = path.join(process.env.HOME!, 'custom-myco');
  let installed = false;
  mock.module('@myco/server/service.js', () => ({
    ...service,
    installService(spec: service.ServiceSpec) {
      installed = true;
      expect(spec.env.MYCO_HOME).toBe(path.resolve(process.env.MYCO_HOME!));
      expect(spec.logDir).toBe(path.join(path.resolve(process.env.MYCO_HOME!), 'logs'));
      return { unitFile: path.join(process.env.HOME!, 'fake-unit'), loaded: true, running: true, changed: true };
    },
  }));
  const { run } = await import('@myco/cli/server.js');
  await run(['install', '--target', 'local']);
  expect(installed).toBe(true);
});
