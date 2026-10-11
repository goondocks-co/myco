import { it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { writeLocalSecrets, readLocalSecrets, createLocalDeployment, DEFAULT_LOCAL_RECORD, peekLocalPaths } from '@myco/server/local.js';
import { inspectLocal, prepareLocal, recoverLocalOwnerLink } from '@myco/server/local-lifecycle.js';
import { defaultSpec, servicePaths, renderUnit } from '@myco/server/service.js';
import { nativeServicePlatform } from '../../helpers/native-service-platform.js';

it('routes setup lifecycle service operations through the injected runner', async () => {
  const home = process.env.MYCO_HOME!;
  const binaryPath = path.join(home, 'bin', 'myco');
  const spec = defaultSpec(binaryPath, process.env.HOME!, 'darwin', home);
  const unit = servicePaths(spec, 'darwin').unitFile;
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, renderUnit(spec, servicePaths(spec, 'darwin'), 'darwin'));
  createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, peekLocalPaths(home));
  const fake = nativeServicePlatform(peekLocalPaths(home), spec);
  const deps = { native: { library: null, vec0: null }, binaryPath, userHome: process.env.HOME!,
    service: { platform: 'darwin' as const, ...(process.env.MYCO_NATIVE_SERVICE_STUB === '1' ? { runner: fake.runner } : {}) },
    fetchImpl: Object.assign(async () => new Response('ok'), { preconnect: () => {} }) };
  const plan = { port: DEFAULT_LOCAL_RECORD.port, signIn: 'skip' as const, owner: 'skip' as const, serve: 'service' as const };
  try { switch (process.env.MYCO_NATIVE_LIFECYCLE_OPERATION) {
    case 'inspect': await inspectLocal(home, deps); break;
    case 'prepare': await prepareLocal(home, plan, deps); break;
    case 'recover': writeLocalSecrets({ ...readLocalSecrets(peekLocalPaths(home)), GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' }, peekLocalPaths(home)); await recoverLocalOwnerLink(home, { ...plan, owner: 'skip' }, { ...deps,
      registerSignIn: undefined }); break;
    default: throw new Error('unknown lifecycle operation');
  } } finally { fake.dispose(); }
});
