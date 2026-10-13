import { it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { writeLocalSecrets, readLocalSecrets, createLocalDeployment, DEFAULT_LOCAL_RECORD, peekLocalPaths } from '@myco/server/local.js';
import { inspectLocal, prepareLocal, recoverLocalOwnerLink } from '@myco/server/local-lifecycle.js';
import { defaultSpec, servicePaths, renderUnit } from '@myco/server/service.js';
import { nativeServicePlatform } from '../../helpers/native-service-platform.js';
import { run } from '@myco/cli/setup.js';
import { setupLocalOwner } from '@myco/server/local-owner.js';
import { spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';

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
  const plan = { retryCommand: 'myco server install --target local', port: DEFAULT_LOCAL_RECORD.port, signIn: 'skip' as const, owner: 'skip' as const, serve: 'service' as const };
  try { switch (process.env.MYCO_NATIVE_LIFECYCLE_OPERATION) {
    case 'setup-status':
    case 'setup-create': {
      const status = process.env.MYCO_NATIVE_LIFECYCLE_OPERATION === 'setup-status';
      writeLocalSecrets({ ...readLocalSecrets(peekLocalPaths(home)), GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' }, peekLocalPaths(home));
      const link = await setupLocalOwner(peekLocalPaths(home), deps.native);
      const sqlite = new Database(peekLocalPaths(home).databasePath);
      try { await spendIdentityLinkAuthority(sqliteRelationalStore(sqlite), new URL(link.url).hash.slice(1), '1234', Date.now()); } finally { sqlite.close(); }
      const result = await run([...(status ? ['--status'] : ['--yes']), '--create', 'local', '--serve', 'service', '--no-agents', '--no-runner'], {
        local: deps, mycoHome: home, cwd: process.cwd(), ask: async () => null, agents: () => [], fetch: Object.assign(async () => Response.json({ ok: true, target: 'fixture' }), { preconnect: () => {} }),
        login: async () => { writeDeploymentMembership({ serverUrl: 'http://127.0.0.1:8787', token: 'x'.repeat(43), machineId: 'fixture', joinedAt: 1, updatedAt: 1 }, { mycoHome: home }); return true; },
      });
      expect(result).toBe(status ? 3 : 0);
      break;
    }
    case 'inspect': await inspectLocal(home, deps); break;
    case 'prepare': await prepareLocal(home, plan, deps); break;
    case 'recover': writeLocalSecrets({ ...readLocalSecrets(peekLocalPaths(home)), GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test' }, peekLocalPaths(home)); await recoverLocalOwnerLink(home, { ...plan, owner: 'skip' }, { ...deps,
      registerSignIn: undefined }); break;
    default: throw new Error('unknown lifecycle operation');
  } } finally { fake.dispose(); }
});
