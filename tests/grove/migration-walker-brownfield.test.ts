/**
 * Migration-walker brownfield orphan cleanup — closes the gap that
 * shipped to dogfood post-upgrade: projects pre-dating the global
 * install rollout sit on disk with legacy launcher artifacts but were
 * never auto-registered. The walker, iterating only registered
 * projects, missed them and first-hook-fire would delegate to a stale
 * project-local stub.
 *
 * Fix shape:
 *   - The global launcher refuses to delegate to a stub lacking the
 *     `MYCO_LAUNCHER_PROTOCOL=v2` sentinel and appends the project
 *     root to `~/.myco/intents/legacy-launcher-cleanup.txt`.
 *   - The walker drains the intent file and walks each queued root
 *     through `migrateOneProject` with a `null` Grove.
 *   - Doctor surfaces queued entries until the next walker pass.
 *
 * Test: stage a fake brownfield project with the four legacy artifacts
 * (the stub + cli launcher + runtime.command + a vault yaml that lacks
 * the opt-in symbionts block), append its root to the intent file,
 * run the walker, assert the launcher artifacts are gone and the intent
 * file has been drained.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  drainLegacyLauncherCleanupIntent,
  runProjectLocalMigration,
} from '@myco/grove/migration-walker.js';
import {
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { resolveLegacyLauncherCleanupIntentPath } from '@myco/grove/paths.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

let tmpMycoHome: string;
let tmpProjectsParent: string;

beforeEach(() => {
  tmpMycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walker-brown-home-'));
  tmpProjectsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walker-brown-proj-'));
  fs.mkdirSync(path.join(tmpMycoHome, 'groves'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmpMycoHome, { recursive: true, force: true });
  fs.rmSync(tmpProjectsParent, { recursive: true, force: true });
});

function seedBrownfieldProject(name: string): string {
  const projectRoot = path.join(tmpProjectsParent, name);
  fs.mkdirSync(path.join(projectRoot, '.agents'), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
  // Legacy stubs (pre-upgrade, no MYCO_LAUNCHER_PROTOCOL sentinel).
  fs.writeFileSync(path.join(projectRoot, '.agents', 'myco-run.cjs'), '// pre-upgrade stub\n');
  fs.writeFileSync(path.join(projectRoot, '.agents', 'myco-cli.cjs'), '// pre-upgrade stub\n');
  fs.writeFileSync(path.join(projectRoot, '.myco', 'runtime.command'), '/old/path/to/myco\n');
  // Vault yaml lacks the `symbionts:` opt-in block — walker treats this
  // as brownfield and removes the full launcher set.
  fs.writeFileSync(
    path.join(projectRoot, '.myco', 'myco.yaml'),
    'version: 3\ncapture:\n  transcript_paths: []\n',
    'utf-8',
  );
  return projectRoot;
}

function appendIntent(projectRoot: string): void {
  const intentPath = resolveLegacyLauncherCleanupIntentPath(tmpMycoHome);
  fs.mkdirSync(path.dirname(intentPath), { recursive: true });
  fs.appendFileSync(intentPath, `${path.resolve(projectRoot)}\n`);
}

describe('drainLegacyLauncherCleanupIntent', () => {
  it('returns [] when the intent file is absent', () => {
    expect(drainLegacyLauncherCleanupIntent(tmpMycoHome)).toEqual([]);
  });

  it('reads + dedupes + clears the intent file', () => {
    const a = path.join(tmpProjectsParent, 'a');
    const b = path.join(tmpProjectsParent, 'b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    appendIntent(a);
    appendIntent(b);
    appendIntent(a); // duplicate launcher fire from another hook

    const drained = drainLegacyLauncherCleanupIntent(tmpMycoHome);
    expect(drained).toEqual([path.resolve(a), path.resolve(b)]);
    // File is removed so re-drain produces nothing.
    expect(fs.existsSync(resolveLegacyLauncherCleanupIntentPath(tmpMycoHome))).toBe(false);
    expect(drainLegacyLauncherCleanupIntent(tmpMycoHome)).toEqual([]);
  });

  it('skips blank lines and trims whitespace', () => {
    const root = path.join(tmpProjectsParent, 'trimmed');
    fs.mkdirSync(root, { recursive: true });
    const intentPath = resolveLegacyLauncherCleanupIntentPath(tmpMycoHome);
    fs.mkdirSync(path.dirname(intentPath), { recursive: true });
    fs.writeFileSync(intentPath, `\n  ${path.resolve(root)}  \n\n`, 'utf-8');
    expect(drainLegacyLauncherCleanupIntent(tmpMycoHome)).toEqual([path.resolve(root)]);
  });
});

describe('runProjectLocalMigration — brownfield orphan pass', () => {
  it('cleans a brownfield project queued via the intent file with no registered Groves', () => {
    const brownfield = seedBrownfieldProject('brownfield-proj');
    appendIntent(brownfield);

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service');

    expect(result.projectsVisited).toBe(1);
    expect(result.outcomes[0].project.root).toBe(brownfield);
    expect(result.outcomes[0].error).toBeUndefined();
    // Both project-local launchers and the runtime.command pin are gone.
    expect(fs.existsSync(path.join(brownfield, '.agents', 'myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(brownfield, '.agents', 'myco-cli.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(brownfield, '.myco', 'runtime.command'))).toBe(false);
    // The user's vault config is preserved — brownfield cleanup is
    // launcher-shaped, not vault-shaped.
    expect(fs.existsSync(path.join(brownfield, '.myco', 'myco.yaml'))).toBe(true);
    // Intent file drained.
    expect(fs.existsSync(resolveLegacyLauncherCleanupIntentPath(tmpMycoHome))).toBe(false);
  });

  it('cleans brownfield AND registered projects in the same pass', () => {
    // Registered project (typical post-upgrade path: hook fired, lazy
    // registration succeeded).
    const grove = createGrove('default', tmpMycoHome, { servedBy: 'service' });
    const registered = seedBrownfieldProject('registered-proj');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_reg_test',
      projectName: 'registered-proj',
      projectRoot: registered,
    }, tmpMycoHome);

    // Brownfield project (never registered).
    const brownfield = seedBrownfieldProject('brown-proj');
    appendIntent(brownfield);

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service');

    expect(result.projectsVisited).toBe(2);
    const visited = result.outcomes.map((o) => o.project.root).sort();
    expect(visited).toEqual([brownfield, registered].sort());

    // Both projects had their launcher artifacts cleaned.
    for (const root of [registered, brownfield]) {
      expect(fs.existsSync(path.join(root, '.agents', 'myco-run.cjs'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.agents', 'myco-cli.cjs'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.myco', 'runtime.command'))).toBe(false);
    }
  });

  it('skips brownfield entries that are ALSO registered (avoid double-walk)', () => {
    // Race scenario: launcher queued a project, but between launcher
    // fire and walker run an `ensureProjectRegistered` call landed.
    // The registered path handles it; the brownfield pass MUST skip
    // the duplicate to keep the audit-log accurate.
    const grove = createGrove('default', tmpMycoHome, { servedBy: 'service' });
    const root = seedBrownfieldProject('race-proj');
    registerProjectInGrove(grove.id, {
      projectId: 'proj_race_test',
      projectName: 'race-proj',
      projectRoot: root,
    }, tmpMycoHome);
    appendIntent(root);

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service');
    expect(result.projectsVisited).toBe(1);
    expect(result.outcomes[0].project.root).toBe(root);
    // The intent file is drained regardless — duplicate entries don't
    // accumulate on disk.
    expect(fs.existsSync(resolveLegacyLauncherCleanupIntentPath(tmpMycoHome))).toBe(false);
  });

  it('skips brownfield entries whose root no longer exists on disk', () => {
    const root = path.join(tmpProjectsParent, 'gone');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(root, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.agents', 'myco-run.cjs'), '// stub\n');
    appendIntent(root);
    fs.rmSync(root, { recursive: true, force: true });

    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service');
    // No outcome for a missing root — the stub-presence guard skips it
    // before we hit migrateOneProject.
    expect(result.projectsVisited).toBe(0);
  });

  it('preserves walker idempotency: re-running on a cleaned project is a no-op', () => {
    const brownfield = seedBrownfieldProject('idem-proj');
    appendIntent(brownfield);
    runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service');

    // Second pass: no intent file, stub already deleted.
    const result = runProjectLocalMigration(PKG_ROOT, tmpMycoHome, 'service');
    expect(result.projectsVisited).toBe(0);
  });
});
