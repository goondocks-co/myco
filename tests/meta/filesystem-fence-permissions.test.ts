import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function probe(code: string) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fence-permissions-'));
  const source = path.resolve('tests/setup/filesystem-fence.ts');
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    const scratch = ${JSON.stringify(scratch)};
    const storage = path.join(scratch, 'storage');
    const home = path.join(scratch, 'home');
    fs.mkdirSync(storage);
    fs.symlinkSync(storage, home, 'dir');
    const root = path.join(home, '.codex');
    const file = path.join(root, 'keep');
    const sourceFile = path.join(scratch, 'source');
    fs.mkdirSync(root);
    fs.writeFileSync(file, 'private');
    fs.writeFileSync(sourceFile, 'source');
    const original = fs.realpathSync;
    const failure = Object.assign(new Error('injected metadata failure'), { code: ${JSON.stringify(code)} });
    let calls = 0;
    fs.realpathSync = function (target, ...args) {
      if (target === root || target.startsWith(root + path.sep)) {
        calls += 1;
        throw failure;
      }
      return original.call(this, target, ...args);
    };
    const { installFilesystemFence } = await import(${JSON.stringify(source)});
    if (['EPERM', 'EACCES'].includes(${JSON.stringify(code)})) {
      const fence = installFilesystemFence(home);
      assert.equal(calls, 1);
      for (const protectedRoot of [root, path.join(storage, '.codex')]) {
        const protectedFile = path.join(protectedRoot, 'keep');
        assert.throws(() => fs.writeFileSync(protectedFile, 'overwrite'), /TEST SAFETY/);
        assert.throws(() => fs.unlinkSync(protectedFile), /TEST SAFETY/);
        assert.throws(() => fs.rmSync(protectedRoot, { recursive: true, force: true }), /TEST SAFETY/);
        assert.throws(() => fs.renameSync(protectedRoot, path.join(scratch, 'moved')), /TEST SAFETY/);
        assert.throws(() => fs.renameSync(sourceFile, protectedFile), /TEST SAFETY/);
      }
      assert.throws(() => fs.rmSync(home, { recursive: true, force: true }), /TEST SAFETY/);
      assert.throws(() => fs.rmSync(storage, { recursive: true, force: true }), /TEST SAFETY/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'private');
      assert.equal(fs.readFileSync(sourceFile, 'utf8'), 'source');
      fence.dispose();
    } else {
      assert.throws(() => installFilesystemFence(home), error => error === failure);
      assert.equal(calls, 1);
    }
    console.log('permission gate passed');
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
    expect(result.stdout.trim()).toBe('permission gate passed');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

describe('protected root resolution permissions', () => {
  for (const code of ['EPERM', 'EACCES']) {
    it(`${code}: installs and fences literal paths and resolved parent aliases`, () => probe(code));
  }
  for (const code of ['EIO', 'ELOOP', 'EINVAL']) {
    it(`${code}: aborts installation with the original error`, () => probe(code));
  }
});
