import { expect } from 'bun:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { requireOwnedFixtureAllocation } from '../support/owned-fixtures.js';
import { assertUnfencedFixtureMutationAllowed } from '../setup/filesystem-fence.js';

const FIXTURE_PERMISSION_MODES = new Set([0o000, 0o600, 0o700]);

function withAuthorizedFixture(target: string, runtime: 'bun' | 'node', body: string): void {
  const allocation = requireOwnedFixtureAllocation(target);
  const canonical = assertUnfencedFixtureMutationAllowed(target);
  const { dev, ino } = fs.lstatSync(target);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    const fixtureTarget = ${JSON.stringify(canonical)};
    const allocation = ${JSON.stringify(allocation)};
    const rootStat = fs.lstatSync(allocation.root);
    assert.equal(rootStat.isDirectory(), true);
    assert.equal(rootStat.dev, allocation.dev);
    assert.equal(rootStat.ino, allocation.ino);
    for (let ancestor = fixtureTarget; ; ancestor = path.dirname(ancestor)) {
      assert.equal(fs.lstatSync(ancestor).isSymbolicLink(), false);
      if (path.dirname(ancestor) === ancestor) break;
    }
    assert.equal(path.join(fs.realpathSync(path.dirname(fixtureTarget)), path.basename(fixtureTarget)), fixtureTarget);
    const targetStat = fs.lstatSync(fixtureTarget);
    assert.equal(targetStat.dev, ${dev});
    assert.equal(targetStat.ino, ${ino});
    assert.ok(targetStat.isDirectory() || targetStat.nlink === 1);
    ${body}
    console.log('permission fixture passed');
  `;
  const home = path.join(allocation.root, 'harness-home');
  const args = runtime === 'bun' ? ['--no-env-file', '-e', script] : ['--input-type=module', '-e', script];
  const result = childProcess.spawnSync(runtime, args, {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'), MYCO_HOME: path.join(home, '.myco') },
  });
  expect({ error: result.error?.message, status: result.status, stderr: result.stderr })
    .toEqual({ error: undefined, status: 0, stderr: '' });
  expect(result.stdout.trim()).toBe('permission fixture passed');
}

export function setFixturePermissions(target: string, mode: 0o000 | 0o600 | 0o700): void {
  if (!FIXTURE_PERMISSION_MODES.has(mode)) throw new Error('TEST SAFETY: unsupported fixture permission mode');
  withAuthorizedFixture(target, 'node', `fs.chmodSync(fixtureTarget, ${JSON.stringify(mode)});`);
}
