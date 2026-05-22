/**
 * Migration-walker opt-in protection — the contract Review fix #9
 * promised but only Layer 1 + the R2 refactor make real.
 *
 * The walker has two correctness-bearing pieces tested here:
 *
 *  1. `hasProjectLocalOptIn`: detects a deliberate per-project install
 *     via the `symbionts:` block in `<projectRoot>/.myco/myco.yaml`.
 *     False positives wipe out a user's launcher pin; false negatives
 *     leave stale launchers behind. Both are silent corruptions.
 *
 *  2. `removeProjectLaunchers`: the single source of truth for which
 *     project-relative files count as "Myco's launcher set." If this
 *     list drifts from what `installHookGuard` writes, the walker
 *     either misses files (stale state) or deletes user-owned files
 *     (data loss).
 *
 * The walker's actual loop composes (1) → (2). Drift between either
 * piece and the install/uninstall write list is the regression class.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hasProjectLocalOptIn } from '@myco/grove/migration-walker.js';
import { removeProjectLaunchers } from '@myco/symbionts/installer.js';

let tmpProject: string;

beforeEach(() => {
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walker-optin-'));
});
afterEach(() => {
  fs.rmSync(tmpProject, { recursive: true, force: true });
});

function writeMycoYaml(body: string): void {
  fs.mkdirSync(path.join(tmpProject, '.myco'), { recursive: true });
  fs.writeFileSync(path.join(tmpProject, '.myco', 'myco.yaml'), body, 'utf-8');
}

function writeFile(rel: string, content: string = 'stub'): string {
  const abs = path.join(tmpProject, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}

describe('hasProjectLocalOptIn', () => {
  it('returns false when no myco.yaml exists', () => {
    expect(hasProjectLocalOptIn(tmpProject)).toBe(false);
  });

  it('returns false when myco.yaml has no symbionts block', () => {
    writeMycoYaml(`version: 3
config_version: 9
capture:
  transcript_paths: []
`);
    expect(hasProjectLocalOptIn(tmpProject)).toBe(false);
  });

  it('returns false when symbionts: is an empty mapping', () => {
    writeMycoYaml(`version: 3
symbionts:
capture:
  transcript_paths: []
`);
    expect(hasProjectLocalOptIn(tmpProject)).toBe(false);
  });

  it('returns true for an opt-in with one symbiont enabled', () => {
    writeMycoYaml(`version: 3
symbionts:
  claude-code:
    enabled: true
capture:
  transcript_paths: []
`);
    expect(hasProjectLocalOptIn(tmpProject)).toBe(true);
  });

  it('returns true for the full 8-symbiont dogfood shape', () => {
    writeMycoYaml(`version: 3
symbionts:
  claude-code:
    enabled: true
  codex:
    enabled: true
  cursor:
    enabled: true
  opencode:
    enabled: true
  pi:
    enabled: true
  vscode-copilot:
    enabled: true
  windsurf:
    enabled: true
  antigravity:
    enabled: true
`);
    expect(hasProjectLocalOptIn(tmpProject)).toBe(true);
  });

  it('returns false on a malformed yaml (safer default — brownfield)', () => {
    fs.mkdirSync(path.join(tmpProject, '.myco'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpProject, '.myco', 'myco.yaml'),
      '{{ not valid yaml',
      'utf-8',
    );
    // The detector substring-matches `symbionts:` before parsing, so
    // a malformed file lacking the substring trivially returns false.
    expect(hasProjectLocalOptIn(tmpProject)).toBe(false);
  });
});

describe('removeProjectLaunchers (single source of truth for project launcher set)', () => {
  it('removes .agents/myco-run.cjs + .agents/myco-cli.cjs by default', () => {
    const run = writeFile('.agents/myco-run.cjs');
    const cli = writeFile('.agents/myco-cli.cjs');

    const removed = removeProjectLaunchers(tmpProject);
    expect(removed).toContain('.agents/myco-run.cjs');
    expect(removed).toContain('.agents/myco-cli.cjs');
    expect(fs.existsSync(run)).toBe(false);
    expect(fs.existsSync(cli)).toBe(false);
  });

  it('removes the legacy .agents/myco-hook.cjs when present', () => {
    const legacy = writeFile('.agents/myco-hook.cjs');
    const removed = removeProjectLaunchers(tmpProject);
    expect(removed).toContain('.agents/myco-hook.cjs');
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('preserves .myco/runtime.command by default', () => {
    // .myco/runtime.command is the `make dev-link-worktree` /
    // `myco init --project` pin. It survives a per-symbiont teardown.
    const pin = writeFile('.myco/runtime.command', '/usr/local/bin/myco-dev');
    removeProjectLaunchers(tmpProject);
    expect(fs.existsSync(pin)).toBe(true);
  });

  it('removes .myco/runtime.command when runtimeCommand: true', () => {
    // Caller opts into the full project-local teardown (`myco remove`
    // does, the walker does only when opt-in is absent).
    const pin = writeFile('.myco/runtime.command', '/usr/local/bin/myco-dev');
    const removed = removeProjectLaunchers(tmpProject, { runtimeCommand: true });
    expect(removed).toContain('.myco/runtime.command');
    expect(fs.existsSync(pin)).toBe(false);
  });

  it('legacy-only mode preserves active launchers + pin', () => {
    // Walker uses this shape when the project has opted into a
    // per-project install — retired guard goes, active set survives.
    const run = writeFile('.agents/myco-run.cjs');
    const legacy = writeFile('.agents/myco-hook.cjs');
    const pin = writeFile('.myco/runtime.command', '/usr/local/bin/myco-dev');
    const removed = removeProjectLaunchers(tmpProject, {
      legacy: true, active: false, runtimeCommand: false,
    });
    expect(removed).toEqual(['.agents/myco-hook.cjs']);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(run)).toBe(true);
    expect(fs.existsSync(pin)).toBe(true);
  });

  it('returns empty array when nothing was removed (idempotent on a clean project)', () => {
    const removed = removeProjectLaunchers(tmpProject);
    expect(removed).toEqual([]);
  });

  it('leaves unrelated files in .agents/ alone', () => {
    const userSkill = writeFile('.agents/skills/my-skill/SKILL.md', '# user');
    writeFile('.agents/myco-run.cjs');
    removeProjectLaunchers(tmpProject);
    // User-owned files outside the launcher set are untouched.
    expect(fs.existsSync(userSkill)).toBe(true);
    // Removal stayed in scope.
    expect(fs.existsSync(path.join(tmpProject, '.agents/myco-run.cjs'))).toBe(false);
  });
});

describe('walker contract: opt-in + helper composition', () => {
  // These two cases capture the regression Review fix #9 promised to
  // close. Together they prove "the opt-in actually protects the
  // launchers" for the two states the walker has to handle.
  it('opt-in present → active launchers + pin preserved; legacy guard cleaned', () => {
    writeMycoYaml(`version: 3
symbionts:
  claude-code:
    enabled: true
`);
    writeFile('.agents/myco-run.cjs');
    writeFile('.agents/myco-cli.cjs');
    writeFile('.agents/myco-hook.cjs'); // retired artifact
    writeFile('.myco/runtime.command', '/usr/local/bin/myco-dev');

    // Walker's composition.
    const optIn = hasProjectLocalOptIn(tmpProject);
    removeProjectLaunchers(tmpProject, {
      legacy: true,
      active: !optIn,
      runtimeCommand: !optIn,
    });

    expect(fs.existsSync(path.join(tmpProject, '.agents/myco-run.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, '.agents/myco-cli.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(tmpProject, '.myco/runtime.command'))).toBe(true);
    // Retired artifact always goes, opt-in or not.
    expect(fs.existsSync(path.join(tmpProject, '.agents/myco-hook.cjs'))).toBe(false);
  });

  it('opt-in absent → full project-launcher teardown', () => {
    writeFile('.agents/myco-run.cjs');
    writeFile('.agents/myco-cli.cjs');
    writeFile('.myco/runtime.command', '/usr/local/bin/myco-dev');

    const optIn = hasProjectLocalOptIn(tmpProject);
    removeProjectLaunchers(tmpProject, {
      legacy: true,
      active: !optIn,
      runtimeCommand: !optIn,
    });

    expect(fs.existsSync(path.join(tmpProject, '.agents/myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(tmpProject, '.agents/myco-cli.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(tmpProject, '.myco/runtime.command'))).toBe(false);
  });
});
