import { expect, it } from 'bun:test';
import path from 'node:path';
import { run } from '@myco/cli/server.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, peekLocalPaths } from '@myco/server/local.js';
import { inspectLocal, localServiceSpec } from '@myco/server/local-lifecycle.js';
import { serviceHomeOwnership } from '@myco/server/service.js';
import { nativeServicePlatform } from '../../helpers/native-service-platform.js';

it('CLI installation uses the same resolved Myco home as native setup', async () => {
  process.env.MYCO_HOME = path.join(process.env.HOME!, 'custom-myco');
  const home = path.resolve(process.env.MYCO_HOME);
  const paths = peekLocalPaths(home);
  const native = { library: null, vec0: null };
  createLocalDeployment(DEFAULT_LOCAL_RECORD, native, paths);
  const deps = { native, userHome: process.env.HOME!, binaryPath: path.join(process.env.HOME!, 'bin', 'myco') };
  const spec = localServiceSpec(home, deps);
  const platform = nativeServicePlatform(paths, spec);
  const local = { ...deps, service: { platform: 'darwin' as const, runner: platform.runner },
    fetchImpl: Object.assign(async () => new Response('ok'), { preconnect() {} }) };
  try {
    await run(['install', '--target', 'local'], { local });
    expect(serviceHomeOwnership(spec, local.service)).toBe('same');
    expect(await inspectLocal(home, local)).toMatchObject({ creation: 'complete', serving: { mode: 'service', healthy: true } });
  } finally { platform.dispose(); }
});
