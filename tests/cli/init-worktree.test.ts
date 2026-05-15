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

  it('bootstraps every enabled symbiont (full manifest set)', async () => {
    // Cover the full enabled set on the dogfooding machine — including pi
    // and vscode-copilot, which were missed by an earlier 6-symbiont version
    // of this test. The implementation is symbiont-agnostic by construction;
    // this test makes the coverage exhaustive so a new symbiont added to
    // manifests/ without test updates will at least surface a gap to chase.
    plantMainVault(mainRepo, [
      'claude-code', 'cursor', 'codex', 'gemini',
      'opencode', 'windsurf', 'pi', 'vscode-copilot',
    ]);
    execFileSync('git', ['worktree', 'add', worktreePath, '-b', 'feature'], { cwd: mainRepo });
    process.chdir(worktreePath);

    await runInit(['--worktree']);

    // Each symbiont's distinguishing artifact (hooksTarget where present,
    // or the next-best per-manifest write) should land in the worktree.
    // Values match packages/myco/src/symbionts/manifests/*.yaml.
    const perSymbiontArtifact: Record<string, string> = {
      'claude-code': path.join('.claude', 'settings.json'),
      'cursor': path.join('.cursor', 'hooks.json'),
      'codex': path.join('.codex', 'config.toml'),
      'gemini': path.join('.gemini', 'settings.json'),
      'opencode': path.join('.opencode', 'plugins', 'myco.ts'),
      'windsurf': path.join('.windsurf', 'hooks.json'),
      'pi': path.join('.pi', 'extensions', 'myco', 'index.ts'),
      'vscode-copilot': path.join('.vscode', 'mcp.json'),
    };
    for (const [name, relPath] of Object.entries(perSymbiontArtifact)) {
      const abs = path.join(worktreePath, relPath);
      if (!fs.existsSync(abs)) console.error(`missing ${name} artifact at ${relPath}`);
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
