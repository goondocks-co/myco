import { expect, it } from 'bun:test';
import path from 'node:path';
import os from 'node:os';
import { workerRigConfigFromEnv, workerRigSpec } from '../../scripts/smoke-worker-service.ts';

const root = path.join(os.tmpdir(), 'myco-worker-rig-contract');
const env = {
  MYCO_SMOKE_BINARY: path.join(root, 'bin/myco'), MYCO_HOME: path.join(root, 'member'),
  MYCO_SMOKE_ROOT: path.join(root, 'rig'), MYCO_SMOKE_SERVER: 'https://deployment.example',
  MYCO_SMOKE_HARNESS: 'codex', MYCO_SMOKE_START_AT: 'login', PATH: path.join(root, 'bin'),
};
it.each(['MYCO_HOME', 'MYCO_SMOKE_ROOT'])('requires explicit %s', (key) => {
  expect(() => workerRigConfigFromEnv({ ...env, [key]: undefined })).toThrow(`Set ${key} explicitly`);
});
it.each([
  { server: 'https://user:password@deployment.example' },
  { server: 'https://deployment.example?token=fixture' },
  { harness: '' }, { binary: 'relative/myco' }, { startAt: 'boot' as const },
])('refuses unsafe rig input %j', (input) => {
  expect(() => workerRigSpec({ ...workerRigConfigFromEnv(env), ...input }, path.join(root, 'user'))).toThrow();
});
it('names separate login services for each Deployment and membership home', () => {
  const config = workerRigConfigFromEnv(env);
  const first = workerRigSpec(config, path.join(root, 'user'));
  const second = workerRigSpec({ ...config, server: 'https://second.example' }, path.join(root, 'user'));
  const third = workerRigSpec({ ...config, mycoHome: path.join(root, 'other-member') }, path.join(root, 'user'));
  expect(new Set([first, second, third].map(spec => spec.unit.label)).size).toBe(3);
  expect(first.unit.args).toEqual(['worker', '--server', config.server, '--harness', 'codex']);
  expect(first.env.MYCO_HOME).toBe(config.mycoHome);
});
