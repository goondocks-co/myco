import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBootstrapVaultDir } from '../../packages/myco/src/vault/bootstrap';

let originalHome: string | undefined;
let tmpHome: string;
let tmpCwd: string;

function setUpTmpHome(): void {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-boot-home-'));
  originalHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = tmpHome;
}

function tearDownTmpHome(): void {
  if (originalHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = originalHome;
}

function writeRegistry(defaultGroveId: string): void {
  fs.mkdirSync(path.join(tmpHome, 'groves'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, 'groves', 'registry.yaml'), `default_grove_id: ${defaultGroveId}\n`);
}

function writeProjectsToml(groveId: string, rows: Array<{ id: string; root: string }>): void {
  const dir = path.join(tmpHome, 'groves', groveId, 'registry');
  fs.mkdirSync(dir, { recursive: true });
  const body = rows.map((r) =>
    `[projects.${r.id}]\nproject_id = "${r.id}"\nname = "test"\nroot = "${r.root}"\nbinding_id = "gbind_${r.id}"\ncreated_at = "2026-01-01T00:00:00.000Z"\nupdated_at = "2026-01-01T00:00:00.000Z"\n`,
  ).join('\n');
  fs.writeFileSync(path.join(dir, 'projects.toml'), body);
}

function makeProject(name: string, withManifest = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `myco-proj-${name}-`));
  fs.mkdirSync(path.join(root, '.myco'), { recursive: true });
  if (withManifest) {
    // project.toml lives inside .myco/, matching the real on-disk layout
    fs.writeFileSync(path.join(root, '.myco', 'project.toml'), '[project]\nid = "proj_test"\n');
  }
  return root;
}

describe('resolveBootstrapVaultDir', () => {
  beforeEach(() => {
    setUpTmpHome();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cwd-'));
  });
  afterEach(() => {
    tearDownTmpHome();
  });

  test('returns cwd-enclosing vault when project.toml exists alongside it', () => {
    const projRoot = makeProject('cwd');
    expect(resolveBootstrapVaultDir(projRoot)).toBe(path.join(projRoot, '.myco'));
  });

  test('falls back to first registered project in default Grove when cwd has no project', () => {
    const groveId = 'grove_65b606b9665228ac5f1812d645cdf6fe';
    const projRoot = makeProject('reg1');
    writeRegistry(groveId);
    writeProjectsToml(groveId, [{ id: 'proj_test', root: projRoot }]);
    // cwd has no enclosing project, registry has one
    expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(projRoot, '.myco'));
  });

  test('skips registered projects whose root no longer exists on disk', () => {
    const groveId = 'grove_65b606b9665228ac5f1812d645cdf6fe';
    const goodRoot = makeProject('good');
    const ghostRoot = '/this/path/does/not/exist';
    writeRegistry(groveId);
    writeProjectsToml(groveId, [
      { id: 'proj_ghost', root: ghostRoot },
      { id: 'proj_good', root: goodRoot },
    ]);
    expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(goodRoot, '.myco'));
  });

  test('throws when neither cwd nor registry yields a project', () => {
    expect(() => resolveBootstrapVaultDir(tmpCwd)).toThrow(/no enclosing project.*no projects registered/i);
  });
});
