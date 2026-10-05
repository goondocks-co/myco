import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { setFixturePermissions } from '../helpers/permission-fixture.js';

function probe(lookup: 'realpathSync' | 'readlinkSync', code: string, interruptions: number, faultInLinkTarget = false) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fence-eintr-'));
  const source = path.resolve('tests/setup/filesystem-fence.ts');
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    const scratch = ${JSON.stringify(scratch)};
    const home = path.join(scratch, 'home');
    const storage = path.join(scratch, 'storage');
    const protectedRoot = path.join(home, '.codex');
    const alias = path.join(scratch, 'alias');
    fs.mkdirSync(home);
    fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage, 'keep'), 'private');
    const destination = ${faultInLinkTarget} || ${JSON.stringify(lookup)} === 'readlinkSync' ? path.join(storage, 'pending') : storage;
    const faultTarget = ${faultInLinkTarget} ? destination : protectedRoot;
    fs.symlinkSync(destination, protectedRoot, 'dir');
    fs.symlinkSync(storage, alias, 'dir');
    const original = fs[${JSON.stringify(lookup)}];
    const failure = Object.assign(new Error('injected metadata failure'), { code: ${JSON.stringify(code)} });
    const paths = [];
    let enabled = true;
    fs[${JSON.stringify(lookup)}] = function (...args) {
      if (enabled && args[0] === faultTarget) {
        paths.push(args[0]);
        if (paths.length <= ${interruptions}) throw failure;
      }
      return original.apply(this, args);
    };
    const { installFilesystemFence } = await import(${JSON.stringify(source)});
    let fence;
    let caught;
    try { fence = installFilesystemFence(home); }
    catch (error) { caught = error; }
    if (${JSON.stringify(code)} === 'EINTR' && ${interruptions} < 3) {
      assert.equal(caught, undefined);
      assert.ok(fence);
      assert.equal(paths.length, ${interruptions + 1});
      const aliasTarget = path.join(alias, path.relative(storage, destination), 'config.toml');
      assert.throws(() => fs.writeFileSync(aliasTarget, 'overwrite'), /TEST SAFETY/);
      assert.throws(() => fs.rmSync(alias, { recursive: true, force: true }), /TEST SAFETY/);
      assert.throws(() => fs.rmSync(storage, { recursive: true, force: true }), /TEST SAFETY/);
      assert.throws(() => fs.rmSync(home, { recursive: true, force: true }), /TEST SAFETY/);
      assert.equal(fs.readFileSync(path.join(storage, 'keep'), 'utf8'), 'private');
      fence.dispose();
    } else {
      assert.equal(fence, undefined);
      assert.equal(caught, failure);
      assert.equal(paths.length, ${JSON.stringify(code)} === 'EINTR' ? 3 : 1);
    }
    assert.ok(paths.every(target => target === faultTarget));
    enabled = false;
    console.log('metadata gate passed');
  `;
  try {
    const home = path.join(scratch, 'harness-home');
    const result = spawnSync('bun', ['--no-env-file', '-e', script], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'), MYCO_HOME: path.join(home, '.myco') },
    });
    expect({ error: result.error?.message, status: result.status, stderr: result.stderr })
      .toEqual({ error: undefined, status: 0, stderr: '' });
    expect(result.stdout.trim()).toBe('metadata gate passed');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

describe('filesystem fence metadata retries', () => {
  it('propagates a permanent realpath EINVAL from a dangling symlink destination', () => {
    probe('realpathSync', 'EINVAL', Number.MAX_SAFE_INTEGER, true);
  });
  for (const lookup of ['realpathSync', 'readlinkSync'] as const) {
    it(`${lookup}: one EINTR preserves symlink and parent protection`, () => probe(lookup, 'EINTR', 1));
    it(`${lookup}: retries through the last allowed attempt`, () => probe(lookup, 'EINTR', 2));
    it(`${lookup}: repeated EINTR fails closed after three attempts`, () => probe(lookup, 'EINTR', Number.MAX_SAFE_INTEGER));
    for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP']) {
      it(`${lookup}: ${code} fails closed without retry`, () => probe(lookup, code, Number.MAX_SAFE_INTEGER));
    }
  }
});

describe('permission fixture boundary', () => {
  it('refuses to change permissions directly in the test temp root', () => {
    expect(() => setFixturePermissions(path.join(os.tmpdir(), 'not-a-private-fixture'), 0o600))
      .toThrow(/private directory under the test temp root/);
  });
  it('refuses to change permissions outside the test temp root', () => {
    const directory = fs.mkdtempSync(path.resolve('target/permission-fixture-'));
    const file = path.join(directory, 'fixture');
    fs.writeFileSync(file, 'private fixture', { mode: 0o644 });
    const mode = fs.statSync(file).mode;
    try {
      expect(() => setFixturePermissions(file, 0o600)).toThrow(/private directory under the test temp root/);
      expect(fs.statSync(file).mode).toBe(mode);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
