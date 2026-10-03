import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { protectedAgentPaths } from '../setup/protected-agent-paths.js';

const REAL_HOME = (globalThis as Record<string, unknown>).__MYCO_TEST_REAL_HOME__ as string;

describe('sandbox preload — redirect', () => {
  it('os.homedir() is NOT the real home', () => {
    expect(typeof REAL_HOME).toBe('string');
    expect(REAL_HOME).not.toBe(process.env.MYCO_TEST_RUN_HOME);
    expect(process.env.MYCO_TEST_REAL_HOME).toBeDefined();
    expect(REAL_HOME).toBe(process.env.MYCO_TEST_REAL_HOME!);
    expect(os.homedir()).not.toBe(REAL_HOME);
  });
  it('os.userInfo().homedir is redirected too', () => {
    expect(os.userInfo().homedir).not.toBe(REAL_HOME);
  });
});

describe('sandbox preload — fence (live-config writes throw)', () => {
  const probe = (rel: string) => path.join(REAL_HOME, rel);
  it('writeFileSync to ~/.myco throws', () => {
    expect(() => fs.writeFileSync(probe('.myco/__leak_probe__'), 'x')).toThrow(/TEST SAFETY/);
  });
  it('mkdirSync under ~/.myco-team throws', () => {
    expect(() => fs.mkdirSync(probe('.myco-team/teams/x'), { recursive: true })).toThrow(/TEST SAFETY/);
  });
  it('renameSync moving ~/.myco/teams aside throws', () => {
    expect(() => fs.renameSync(probe('.myco/teams'), probe('.myco/teams.bak'))).toThrow(/TEST SAFETY/);
  });
  it('rmSync of ~/.myco throws', () => {
    expect(() => fs.rmSync(probe('.myco'), { recursive: true, force: true })).toThrow(/TEST SAFETY/);
  });
  it('copyFileSync into ~/.myco-collective throws', () => {
    const src = path.join(os.tmpdir(), 'probe-src'); fs.writeFileSync(src, 'x');
    expect(() => fs.copyFileSync(src, probe('.myco-collective/x'))).toThrow(/TEST SAFETY/);
  });
  it('writes OUTSIDE the real myco namespace are allowed', () => {
    const ok = path.join(os.tmpdir(), 'myco-sandbox-ok-' + process.pid);
    expect(() => { fs.mkdirSync(ok, { recursive: true }); fs.writeFileSync(path.join(ok, 'f'), 'x'); fs.rmSync(ok, { recursive: true, force: true }); }).not.toThrow();
  });
  it('createWriteStream into ~/.myco throws', () => {
    expect(() => fs.createWriteStream(probe('.myco/__leak__'))).toThrow(/TEST SAFETY/);
  });
  it('callback-form fs.writeFile into ~/.myco throws synchronously', () => {
    expect(() => fs.writeFile(probe('.myco/__leak__'), 'x', () => {})).toThrow(/TEST SAFETY/);
  });
  it('callback-form fs.mkdir into ~/.myco-team throws', () => {
    expect(() => fs.mkdir(probe('.myco-team/x'), { recursive: true }, () => {})).toThrow(/TEST SAFETY/);
  });
});


describe('sandbox preload — agent configuration', () => {
  const protectedPaths = protectedAgentPaths(REAL_HOME);
  it('covers every manifest home config path and the shared skills folder', () => {
    const dir = fileURLToPath(new URL('../../packages/myco/src/symbionts/manifests/', import.meta.url));
    const covered = (target: string) => protectedPaths.some((root) => target === root || target.startsWith(root + path.sep));
    const check = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('~/')) {
        expect(covered(path.join(REAL_HOME, value.slice(2)))).toBe(true);
      } else if (Array.isArray(value)) value.forEach(check);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(check);
    };
    for (const name of fs.readdirSync(dir).filter((name) => name.endsWith('.yaml'))) {
      const manifest = parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      expect(typeof manifest.detectionDir).toBe('string');
      check(manifest);
    }
    expect(protectedPaths).toContain(path.join(REAL_HOME, '.codex'));
    expect(protectedPaths).toContain(path.join(REAL_HOME, '.agents'));
  });

  for (const root of protectedPaths) {
    it(`blocks writing, deleting and renaming ${path.relative(REAL_HOME, root)}`, () => {
      const target = path.join(root, '__myco_test_fence_probe__');
      expect(() => fs.writeFileSync(target, 'x')).toThrow(/TEST SAFETY/);
      expect(() => fs.appendFileSync(target, 'x')).toThrow(/TEST SAFETY/);
      expect(() => fs.unlinkSync(target)).toThrow(/TEST SAFETY/);
      expect(() => fs.rmSync(root, { recursive: true, force: true })).toThrow(/TEST SAFETY/);
      expect(() => fs.renameSync(root, path.join(os.homedir(), 'moved'))).toThrow(/TEST SAFETY/);
      expect(() => fs.renameSync(path.join(os.homedir(), 'source'), target)).toThrow(/TEST SAFETY/);
      expect(() => fs.writeFile(target, 'x', () => {})).toThrow(/TEST SAFETY/);
      expect(() => fs.promises.writeFile(target, 'x')).toThrow(/TEST SAFETY/);
      expect(() => fs.promises.rm(root, { recursive: true, force: true })).toThrow(/TEST SAFETY/);
      expect(() => fs.promises.rename(root, path.join(os.homedir(), 'moved'))).toThrow(/TEST SAFETY/);
      expect(() => fs.promises.open(target, 'w')).toThrow(/TEST SAFETY/);
      expect(() => Bun.write(target, 'x')).toThrow(/TEST SAFETY/);
      expect(() => Bun.write(Bun.file(target), 'x')).toThrow(/TEST SAFETY/);
      expect(() => Bun.file(target).writer()).toThrow(/TEST SAFETY/);
      expect(() => fs.linkSync(target, path.join(os.homedir(), 'hard-alias'))).toThrow(/TEST SAFETY/);
      expect(() => fs.link(target, path.join(os.homedir(), 'hard-alias'), () => {})).toThrow(/TEST SAFETY/);
      expect(() => fs.promises.link(target, path.join(os.homedir(), 'hard-alias'))).toThrow(/TEST SAFETY/);
    });
  }

  it('blocks mutations through sandbox symlink aliases', () => {
    const alias = path.join(os.homedir(), 'codex-alias');
    fs.symlinkSync(path.join(REAL_HOME, '.codex'), alias);
    const target = path.join(alias, '__myco_test_fence_probe__');
    expect(() => fs.writeFileSync(target, 'x')).toThrow(/TEST SAFETY/);
    expect(() => fs.rmSync(target, { force: true })).toThrow(/TEST SAFETY/);
    expect(() => fs.renameSync(target, path.join(os.homedir(), 'moved'))).toThrow(/TEST SAFETY/);
  });

  it('blocks deleting and renaming parents of protected agent folders', () => {
    const parent = path.join(REAL_HOME, '.config');
    expect(() => fs.rmSync(parent, { recursive: true, force: true })).toThrow(/TEST SAFETY/);
    expect(() => fs.renameSync(parent, path.join(os.homedir(), 'moved'))).toThrow(/TEST SAFETY/);
  });

  it('sandboxes HOME and harness config overrides for child processes', () => {
    expect(process.env.HOME).toBe(os.homedir());
    expect(process.env.CODEX_HOME).toBe(path.join(os.homedir(), '.codex'));
    expect(process.env.CLAUDE_CONFIG_DIR).toBe(path.join(os.homedir(), '.claude'));
    const home = execFileSync(process.execPath, ['-e', 'console.log(require("node:os").homedir())'], { encoding: 'utf8' }).trim();
    expect(home).toBe(process.env.MYCO_TEST_RUN_HOME ?? os.homedir());
  });

  it('cannot resolve an installed Myco through PATH, including in a child shell', () => {
    expect(Bun.which('myco')).toBeNull();
    expect(Bun.which('myco-dev')).toBeNull();
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      expect(dir.startsWith(os.homedir() + path.sep)).toBe(true);
    }
    expect(execFileSync('/bin/sh', ['-c', 'command -v myco || true'], { encoding: 'utf8' }).trim()).toBe('');
    expect(Bun.which('git')).not.toBeNull();
  });
});
