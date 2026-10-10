import { afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { assertNoServiceExecutions, consumeServiceExecDenials } from '../../scripts/test-service-exec.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) {
  consumeServiceExecDenials(path.join(root, '.service-exec-guard'));
  fs.rmSync(root, { recursive: true, force: true });
} });
const repo = fileURLToPath(new URL('../../', import.meta.url));
for (const operation of ['inspect', 'prepare', 'recover']) for (const stub of [true, false]) {
  it(`native setup ${operation} ${stub ? 'uses its injected runner' : 'refuses before real platform execution'}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-service-'));
    roots.push(root);
    const env = sandboxChildEnv(root, { MYCO_TEST_RUN_ROOT: root, MYCO_NATIVE_LIFECYCLE_OPERATION: operation,
      ...(stub ? { MYCO_NATIVE_SERVICE_STUB: '1' } : {}) });
    const child = spawnSync(process.execPath, ['test', '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'),
      '--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/setup/fixtures/native_lifecycle_boundary_test.ts')],
    { env, cwd: root, encoding: 'utf8', timeout: 30_000 });
    if (stub) {
      expect({ status: child.status, stderr: child.stderr }).toMatchObject({ status: 0 });
      expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).not.toThrow();
    } else {
      expect(child.status).not.toBe(0);
      expect(child.stderr).toContain('TEST SAFETY');
      expect(() => assertNoServiceExecutions(env.MYCO_TEST_SERVICE_GUARD_DIR!)).toThrow('TEST SAFETY');
    }
  });
}
