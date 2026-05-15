/**
 * Integration test for `myco init --worktree`.
 *
 * Sets up a real git main repo + worktree on disk, plants a minimal Myco
 * vault in the main repo, then invokes the worktree-bootstrap path and
 * asserts the hook bootstrap files land at the worktree's root.
 *
 * Closes #290 — auto-bootstrap hooks for new git worktrees.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import { run as runInit } from '@myco/cli/init.js';
import { loadManifests } from '@myco/symbionts/detect.js';

let tmpDir: string;
let mainRepo: string;
let worktreePath: string;
let originalCwd: string;

function initRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'README.md'), '# t\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
}

/** Minimal vault setup: just enough that loadMergedConfig works. */
function plantMainVault(repoRoot: string, symbionts: string[]): void {
  const vaultDir = path.join(repoRoot, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  const config: Record<string, unknown> = { version: 3 };
  if (symbionts.length > 0) {
    config.symbionts = Object.fromEntries(symbionts.map((s) => [s, { enabled: true }]));
  }
  fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
}

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-init-wt-')));
  mainRepo = path.join(tmpDir, 'main');
  worktreePath = path.join(tmpDir, 'wt');
  fs.mkdirSync(mainRepo);
  initRepo(mainRepo);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('myco init --worktree', () => {
  it('writes the claude-code hook bootstrap files at the worktree root', async () => {
    plantMainVault(mainRepo, ['claude-code']);
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'feature'], { cwd: mainRepo });
    process.chdir(worktreePath);

    await runInit(['--worktree']);

    // The hook guard lands inside the worktree, not the main repo.
    expect(fs.existsSync(path.join(worktreePath, '.agents', 'myco-run.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(worktreePath, '.claude', 'settings.json'))).toBe(true);

    // The main repo's hook stack is untouched (and probably absent — we
    // didn't actually run a full `myco init` there, only planted a vault).
    expect(fs.existsSync(path.join(mainRepo, '.agents', 'myco-run.cjs'))).toBe(false);
  });

  it('mirrors a project-scoped runtime.command pin from main into the worktree', async () => {
    plantMainVault(mainRepo, ['claude-code']);
    fs.writeFileSync(path.join(mainRepo, '.myco', 'runtime.command'), '/abs/path/to/myco-dev\n');
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'feature'], { cwd: mainRepo });
    process.chdir(worktreePath);

    await runInit(['--worktree']);

    const mirrored = path.join(worktreePath, '.myco', 'runtime.command');
    expect(fs.existsSync(mirrored)).toBe(true);
    expect(fs.readFileSync(mirrored, 'utf-8')).toBe('/abs/path/to/myco-dev\n');
  });

  it('bootstraps every enabled symbiont (full manifest set, derived from loadManifests)', async () => {
    // Drive coverage off the manifest registry itself — no hardcoded
    // per-symbiont strings. Every manifest with a registration.hooksTarget
    // must produce that file at the worktree's root after bootstrap. If
    // someone adds a new symbiont to manifests/, this test exercises it
    // automatically; if they remove one, the loop shrinks. No magic-string
    // drift between the manifest and the test.
    const allManifests = loadManifests();
    const symbiontsWithHooks = allManifests.filter((m) => !!m.registration?.hooksTarget);
    expect(symbiontsWithHooks.length).toBeGreaterThan(0);

    plantMainVault(mainRepo, symbiontsWithHooks.map((m) => m.name));
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'feature'], { cwd: mainRepo });
    process.chdir(worktreePath);

    await runInit(['--worktree']);

    for (const manifest of symbiontsWithHooks) {
      const relPath = manifest.registration!.hooksTarget!;
      const abs = path.join(worktreePath, relPath);
      if (!fs.existsSync(abs)) console.error(`missing ${manifest.name} hooksTarget at ${relPath}`);
      expect(fs.existsSync(abs)).toBe(true);
    }

    // The shared hook guard is written exactly once regardless of symbiont count.
    expect(fs.existsSync(path.join(worktreePath, '.agents', 'myco-run.cjs'))).toBe(true);
  });

  it('does no symbiont work when the main config has none enabled', async () => {
    plantMainVault(mainRepo, []);
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'feature'], { cwd: mainRepo });
    process.chdir(worktreePath);

    await runInit(['--worktree']);

    // No symbionts enabled → no hook guard written.
    expect(fs.existsSync(path.join(worktreePath, '.agents', 'myco-run.cjs'))).toBe(false);
  });

  it('exits with an error when cwd is not inside a worktree', async () => {
    plantMainVault(mainRepo, ['claude-code']);
    process.chdir(mainRepo);

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as never;

    try {
      await runInit(['--worktree']).catch(() => undefined);
      expect(exitCode).toBe(1);
    } finally {
      process.exit = originalExit;
    }
  });

  it('exits with an error when the main repo has no Myco vault', async () => {
    // No plantMainVault — main has no .myco at all.
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'feature'], { cwd: mainRepo });
    process.chdir(worktreePath);

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as never;

    try {
      await runInit(['--worktree']).catch(() => undefined);
      expect(exitCode).toBe(1);
    } finally {
      process.exit = originalExit;
    }
  });
});
