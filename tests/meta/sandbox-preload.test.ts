import { assertTestPath } from '../../scripts/test-environment.mjs';
import { afterAll, describe, expect, it } from 'bun:test';
import os from 'node:os';
import fs from 'node:fs';
import bareFs from 'fs';
import promisesFs from 'node:fs/promises';
import barePromisesFs from 'fs/promises';
import { writeFile as promiseWriteFile, rm as promiseRm } from 'node:fs/promises';
import * as namespacePromisesFs from 'node:fs/promises';
import fencedFs, { rmSync, writeFileSync } from '../support/fenced-fs.mjs';
import * as namespaceFs from '../support/fenced-fs.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { installFilesystemFence } from '../setup/filesystem-fence.js';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-fence-'));
const fixture = installFilesystemFence(fakeHome);
afterAll(() => {
  fixture.dispose();
  fs.rmSync(fakeHome, { recursive: true, force: true });
});
const probe = (relative: string) => path.join(fakeHome, relative);
const target = probe('.codex/probe');
const requireFs = require('node:fs') as typeof fs;
const requireBareFs = require('fs') as typeof fs;
const requireWrapper = require('../support/fenced-fs.mjs') as typeof namespaceFs;

function assertManifestCoverage(value: unknown): void {
  if (typeof value === 'string' && value.startsWith('~/')) {
    const declared = path.join(fakeHome, value.slice(2));
    expect(fixture.protectedRoots.some((root) => declared === root || declared.startsWith(root + path.sep))).toBe(true);
  } else if (Array.isArray(value)) value.forEach(assertManifestCoverage);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(assertManifestCoverage);
}

describe('sandbox preload', () => {
  it('keeps the account home private and redirects home lookups', () => {
    const accountHome = execFileSync('node', ['-e', 'process.stdout.write(require("node:os").userInfo().homedir)'], { encoding: 'utf8' });
    expect(process.env.MYCO_TEST_REAL_HOME).toBeUndefined();
    expect(Object.values(process.env)).not.toContain(accountHome);
    expect(Object.values(globalThis)).not.toContain(accountHome);
    expect((globalThis as Record<string, unknown>).__MYCO_TEST_REAL_HOME__).toBeUndefined();
    expect(os.homedir()).not.toBe(accountHome);
    expect(os.userInfo().homedir).toBe(os.homedir());
    expect(process.env.HOME).toBe(os.homedir());
    expect(process.env.CODEX_HOME).toBe(path.join(os.homedir(), '.codex'));
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), '.claude'));
  });

  it('covers paths independently read from every manifest', () => {
    const dir = fileURLToPath(new URL('../../packages/myco/src/symbionts/manifests/', import.meta.url));
    for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
      assertManifestCoverage(parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    }
    expect(fixture.protectedRoots).toContain(probe('.codex'));
    expect(fixture.protectedRoots).toContain(probe('.agents'));
  });

  it('rejects a manifest declaration outside installed protection', () => {
    expect(() => assertManifestCoverage(parse('config: "~/.unprotected-fixture/settings.json"'))).toThrow();
  });

  for (const [form, imported] of Object.entries({ default: fs, bare: bareFs, wrapperDefault: fencedFs,
    named: { rmSync, writeFileSync }, namespace: namespaceFs, require: requireFs, requireBare: requireBareFs, requireWrapper })) {
    it(`fences ${form} imports`, () => {
      expect(() => imported.rmSync(probe('.codex'), { recursive: true, force: true })).toThrow(/TEST SAFETY/);
      expect(() => imported.writeFileSync(target, 'x')).toThrow(/TEST SAFETY/);
    });
  }

  for (const [form, imported] of Object.entries({ default: promisesFs, bare: barePromisesFs,
    named: { writeFile: promiseWriteFile, rm: promiseRm }, namespace: namespacePromisesFs,
    require: require('node:fs/promises') as typeof promisesFs, requireBare: require('fs/promises') as typeof promisesFs })) {
    it(`fences promise ${form} imports`, () => {
      expect(() => imported.rm(probe('.codex'), { recursive: true, force: true })).toThrow(/TEST SAFETY/);
      expect(() => imported.writeFile(target, 'x')).toThrow(/TEST SAFETY/);
    });
  }

  for (const root of fixture.protectedRoots) {
    it(`fences writing, deletion and rename in ${path.relative(fakeHome, root)}`, () => {
      const file = path.join(root, 'probe');
      expect(() => fs.writeFileSync(file, 'x')).toThrow(/TEST SAFETY/);
      expect(() => fs.unlinkSync(file)).toThrow(/TEST SAFETY/);
      expect(() => fs.rmSync(root, { recursive: true, force: true })).toThrow(/TEST SAFETY/);
      expect(() => fs.renameSync(root, probe('moved'))).toThrow(/TEST SAFETY/);
      expect(() => fs.renameSync(probe('source'), file)).toThrow(/TEST SAFETY/);
    });
  }

  const attempts: Record<string, () => unknown> = {
    mkdtempSync: () => fs.mkdtempSync(probe('.codex/prefix-')),
    mkdtempCallback: () => fs.mkdtemp(probe('.codex/prefix-'), () => {}),
    createWriteStream: () => fs.createWriteStream(target),
    writeFileCallback: () => fs.writeFile(target, 'x', () => {}),
    utimes: () => fs.promises.utimes(target, new Date(), new Date()),
    mkdtemp: () => fs.promises.mkdtemp(probe('.codex/prefix-')),
    promiseWrite: () => fs.promises.writeFile(target, 'x'),
    promiseRemove: () => fs.promises.rm(target, { force: true }),
    promiseOpen: () => fs.promises.open(target, 'w'),
    nativeWrite: () => Bun.write(target, 'x'),
    nativeFileWrite: () => Bun.file(target).write('x'),
    nativeFileDelete: () => Bun.file(target).delete(),
    nativeFileUnlink: () => Bun.file(target).unlink(),
    nativeWriter: () => Bun.file(target).writer(),
    nativeSlicedWrite: () => Bun.file(target).slice().write('x'),
    nativeSlicedDelete: () => Bun.file(target).slice().delete(),
    nativeSlicedUnlink: () => Bun.file(target).slice().unlink(),
    nativeSlicedWriter: () => Bun.file(target).slice().writer(),
    nativeSlicedDestination: () => Bun.write(Bun.file(target).slice(), 'x'),
    nativeFileDestination: () => Bun.write(Bun.file(target), 'x'),
    hardlink: () => fs.linkSync(target, probe('alias')),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    it(`fences ${name}`, () => { expect(attempt).toThrow(/TEST SAFETY/); });
  }

  it('fences symlink aliases and parent removal', () => {
    const alias = probe('alias');
    fs.symlinkSync(probe('.codex'), alias);
    expect(() => fs.writeFileSync(path.join(alias, 'probe'), 'x')).toThrow(/TEST SAFETY/);
    expect(() => fs.rmSync(probe('.config'), { recursive: true, force: true })).toThrow(/TEST SAFETY/);
    expect(() => fs.renameSync(probe('.config'), probe('moved'))).toThrow(/TEST SAFETY/);
  });

  it('cannot resolve an installed Myco through PATH or a child shell', () => {
    expect(Bun.which('myco')).toBeNull();
    expect(Bun.which('myco-dev')).toBeNull();
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      expect(() => assertTestPath(process.env.MYCO_TEST_RUN_ROOT!, dir, 'PATH')).not.toThrow();
    }
    expect(execFileSync('/bin/sh', ['-c', 'command -v myco || true'], { encoding: 'utf8' }).trim()).toBe('');
    expect(Bun.which('git')).not.toBeNull();
  });

  it('loads the fence through the Vitest setup', () => {
    const source = fs.readFileSync(new URL('../setup/vitest.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/import ['"]\.\/sandbox-preload\.js['"]/);
  });
});
