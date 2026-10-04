import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { systemTempDirectories } from '../../scripts/test-temp-root.mjs';
import { installTestTempFence } from '../setup/filesystem-fence.js';

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-temp-fence-'));
const system = path.join(parent, 'system');
const root = path.join(system, 'mt-owned0');
fs.mkdirSync(root, { recursive: true });
const fence = installTestTempFence(root, [system]);
afterAll(() => {
  fence.dispose();
  fs.rmSync(parent, { recursive: true, force: true });
});

describe('process-owned test temp fence', () => {
  it('blocks mkdtemp at its call site when os.tmpdir points to system temp', () => {
    const saved = ['TMPDIR', 'TEMP', 'TMP'].map((key) => [key, process.env[key]] as const);
    try {
      for (const [key] of saved) process.env[key] = system;
      expect(os.tmpdir()).toBe(system);
      let failure: Error | undefined;
      try { fs.mkdtempSync(path.join(os.tmpdir(), 'myco-x-')); }
      catch (error) { failure = error as Error; }
      expect(failure?.message).toContain('fs.mkdtempSync');
      expect(failure?.message).toContain('outside the run root');
      expect(failure?.stack).toContain(import.meta.path);
      expect(fs.readdirSync(system)).toEqual(['mt-owned0']);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('installs the fence for every real system temp directory before tests load', () => {
    const runRoot = fs.realpathSync(process.env.MYCO_TEST_RUN_ROOT!);
    const inherited = JSON.parse(process.env.MYCO_TEST_SYSTEM_TEMP_DIRS!) as string[];
    for (const dir of [...new Set([...inherited, ...systemTempDirectories()])].filter((candidate) => candidate !== runRoot)) {
      const missing = path.join(dir, `myco-uncreated-${randomUUID()}`, 'missing', 'myco-x-');
      expect(fs.existsSync(path.dirname(missing))).toBe(false);
      // mkdtemp requires its parent to exist; this probe cannot create a system entry.
      expect(() => fs.mkdtempSync(missing)).toThrow('outside the run root');
    }
  });

  it('uses the runner system-directory handoff after TMPDIR changes to the run root', () => {
    const worktreeScratch = path.resolve(import.meta.dirname, '../../target');
    fs.mkdirSync(worktreeScratch, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(worktreeScratch, 'temp-fence-handoff-'));
    const owned = path.join(fixture, 'owned');
    fs.mkdirSync(owned);
    const saved = process.env.MYCO_TEST_SYSTEM_TEMP_DIRS;
    process.env.MYCO_TEST_SYSTEM_TEMP_DIRS = JSON.stringify([fixture]);
    const inheritedFence = installTestTempFence(owned);
    try {
      expect(() => fs.mkdtempSync(path.join(fixture, 'myco-x-'))).toThrow('outside the run root');
    } finally {
      inheritedFence.dispose();
      if (saved === undefined) delete process.env.MYCO_TEST_SYSTEM_TEMP_DIRS;
      else process.env.MYCO_TEST_SYSTEM_TEMP_DIRS = saved;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('installs the source fence in standalone test children', () => {
    const script = path.join(root, 'standalone.ts');
    fs.writeFileSync(script, `
      import fs from 'node:fs';
      import path from 'node:path';
      const dirs = JSON.parse(process.env.MYCO_TEST_SYSTEM_TEMP_DIRS!);
      const missing = path.join(dirs[0], 'myco-uncreated-${randomUUID()}', 'missing', 'myco-x-');
      try { fs.mkdtempSync(missing); throw new Error('temp fence missing'); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('outside the run root')) throw error;
        console.log('source attributed');
      }
    `);
    const preload = path.resolve(import.meta.dirname, '../helpers/native-lock-fence.ts');
    const child = spawnSync(process.execPath, ['run', '--preload', preload, script], { encoding: 'utf8' });
    expect({ status: child.status, stderr: child.stderr, stdout: child.stdout.trim() }).toEqual({ status: 0, stderr: '', stdout: 'source attributed' });
  });

  const target = path.join(system, 'myco-target');
  const attempts: Record<string, () => unknown> = {
    mkdir: () => fs.mkdirSync(target),
    callbackMkdtemp: () => fs.mkdtemp(path.join(system, 'mt-x-'), () => {}),
    write: () => fs.writeFileSync(target, 'blocked'),
    callbackWrite: () => fs.writeFile(target, 'blocked', () => {}),
    promiseMkdtemp: () => fs.promises.mkdtemp(path.join(system, 'myco-x-')),
    promiseWrite: () => fs.promises.writeFile(target, 'blocked'),
    open: () => fs.openSync(target, 'w'),
    promiseOpen: () => fs.promises.open(target, 'w'),
    writer: () => fs.createWriteStream(target),
    copy: () => fs.copyFileSync(import.meta.path, target),
    rename: () => fs.renameSync(path.join(root, 'source'), target),
    BunWrite: () => Bun.write(target, 'blocked'),
    BunFileWrite: () => Bun.file(target).write('blocked'),
    BunFileWriter: () => Bun.file(target).writer(),
    BunSliceWrite: () => Bun.file(target).slice().write('blocked'),
    BunFileDestination: () => Bun.write(Bun.file(target).slice(), 'blocked'),
  };
  for (const [name, attempt] of Object.entries(attempts)) {
    it(`blocks ${name} outside this process's run root`, async () => {
      await expect(Promise.resolve().then(attempt)).rejects.toThrow('outside the run root');
      expect(fs.existsSync(target)).toBe(false);
    });
  }

  it('allows owned prefixes and unrelated system entries', () => {
    fs.mkdtempSync(path.join(root, 'myco-owned-'));
    fs.mkdtempSync(path.join(root, 'mt-owned-'));
    const unrelated = path.join(system, 'unrelated');
    fs.writeFileSync(unrelated, 'allowed');
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('allowed');
    fs.unlinkSync(unrelated);
  });

  it('blocks a symlink inside the run root that targets system temp', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(system, alias, 'junction');
    expect(() => fs.mkdirSync(path.join(alias, 'myco-alias'))).toThrow('outside the run root');
    expect(fs.existsSync(path.join(system, 'myco-alias'))).toBe(false);
  });

  it('blocks nested temp entries and recursive parent creation while allowing explicit reports in existing scratch', async () => {
    const enclosing = path.join(system, 'ordinary');
    fs.mkdirSync(enclosing);
    const nested = path.join(enclosing, 'myco-new', 'report');
    expect(() => fs.mkdtempSync(path.join(enclosing, 'mt-x-'))).toThrow('outside the run root');
    expect(() => fs.mkdirSync(nested, { recursive: true })).toThrow('outside the run root');
    await expect(Promise.resolve().then(() => Bun.write(nested, 'blocked'))).rejects.toThrow('outside the run root');
    const existing = path.join(enclosing, 'myco-existing');
    fence.dispose();
    fs.mkdirSync(existing);
    const restored = installTestTempFence(root, [system]);
    try {
      const report = path.join(existing, 'report');
      fs.writeFileSync(report, 'allowed');
      expect(fs.readFileSync(report, 'utf8')).toBe('allowed');
    } finally {
      restored.dispose();
      fs.rmSync(enclosing, { recursive: true, force: true });
    }
  });
});
