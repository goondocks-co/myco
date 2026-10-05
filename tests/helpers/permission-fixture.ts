import { expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type PermissionFixture = 'secret-file' | 'secret-directory';

function privateFixtureDirectory(directory: string): string {
  const canonical = fs.realpathSync(directory);
  const relative = path.relative(fs.realpathSync(os.tmpdir()), canonical);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Permission fixtures require a private directory under the test temp root');
  }
  return canonical;
}

// Permission recovery runs through production code in a child without the test fence.
export function runPermissionFixture(fixture: PermissionFixture, directory: string): void {
  directory = privateFixtureDirectory(directory);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    const directory = ${JSON.stringify(directory)};
    const fixture = ${JSON.stringify(fixture)};
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    assert.deepEqual(fs.readdirSync(directory), []);
    const { createSecretsOperations, readSecrets } = await import(${JSON.stringify(path.resolve('packages/myco/src/config/secrets.ts'))});
    const { createPerUserLockNamespace } = await import(${JSON.stringify(path.resolve('packages/myco/src/utils/per-user-lock-namespace.ts'))});
    const { tightenSecretsPermissions } = createSecretsOperations(createPerUserLockNamespace(() => process.env.MYCO_TEST_PER_USER_LOCKS_ROOT));
    const file = path.join(directory, 'secrets.env');
    const target = fixture === 'secret-file' ? file : directory;
    fs.writeFileSync(file, 'REPAIRED=value\\n', { mode: 0o600 });
    fs.chmodSync(target, 0o000);
    try {
      tightenSecretsPermissions(directory);
      assert.equal(fs.statSync(target).mode & 0o777, fixture === 'secret-file' ? 0o600 : 0o700);
      assert.deepEqual(readSecrets(directory), { REPAIRED: 'value' });
    } finally { fs.chmodSync(target, fixture === 'secret-file' ? 0o600 : 0o700); }
    console.log('permission fixture passed');
  `;
  const home = path.join(directory, 'harness-home');
  const result = spawnSync('bun', ['--no-env-file', '-e', script], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), MYCO_HOME: path.join(home, '.myco') },
  });
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr })
    .toEqual({ error: undefined, status: 0, stderr: '' });
  expect(result.stdout.trim()).toBe('permission fixture passed');
}

// Only private test fixtures may have their permissions changed by a child.
export function setFixturePermissions(target: string, mode: 0o000 | 0o600 | 0o700): void {
  const parent = privateFixtureDirectory(path.dirname(target));
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const target = ${JSON.stringify(target)};
    assert.equal(fs.realpathSync(path.dirname(target)), ${JSON.stringify(parent)});
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);
    fs.chmodSync(target, ${mode});
  `;
  const result = spawnSync('node', ['-e', script], { encoding: 'utf8', timeout: 10_000 });
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr })
    .toEqual({ error: undefined, status: 0, stderr: '' });
}
