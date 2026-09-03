import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveMachineConfig, invalidateMergedConfigCache } from '../../packages/myco/src/config/loader';
import { loadManifests } from '../../packages/myco/src/symbionts/detect';
import { reconcileManagedProjectFiles } from '../../packages/myco/src/symbionts/reconcile';
import { useIsolatedHome } from '../support/isolated-home';

describe('managed-files reconcile picks up machine-scoped capture', () => {
  const home = useIsolatedHome('myco-mfr-');
  const GROVE = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 32 lowercase hex after grove_
  let projectRoot: string; let vault: string;

  beforeEach(() => {
    saveMachineConfig({ capture: { ignore_plan_dirs_in_git: true, plan_dirs: ['docs/plans/'] } } as never);
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mfr-proj-'));
    vault = path.join(projectRoot, '.myco');
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(path.join(vault, 'myco.yaml'), 'version: 3\n', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules\n', 'utf-8');
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# AGENTS.md\n', 'utf-8');
    invalidateMergedConfigCache();
  });

  it('writes machine-configured plan dirs into the project .gitignore, idempotently', () => {
    const r1 = reconcileManagedProjectFiles(projectRoot, vault, GROVE);
    const gi = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gi).toContain('docs/plans/');       // machine-scoped capture reached the project
    expect(r1?.gitignore).toBe(true);          // changed on first pass
    const r2 = reconcileManagedProjectFiles(projectRoot, vault, GROVE);
    expect(r2?.gitignore).toBe(false);         // idempotent — no-op on second pass
  });

  it('writes them whatever order the manifests arrive in', () => {
    // The managed-file writers gate on `registration.skillsTarget`, which
    // `antigravity` deliberately omits. Leading with it is the order a
    // hash-ordered filesystem can hand `loadManifests()`.
    const manifests = loadManifests();
    expect(manifests.find((m) => m.name === 'antigravity')?.registration?.skillsTarget)
      .toBeUndefined();
    const antigravityFirst = [
      ...manifests.filter((m) => m.name === 'antigravity'),
      ...manifests.filter((m) => m.name !== 'antigravity'),
    ];

    const r1 = reconcileManagedProjectFiles(projectRoot, vault, GROVE, { manifests: antigravityFirst });
    expect(r1?.gitignore).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8')).toContain('docs/plans/');
  });

  it('enumerates manifests in one order on every filesystem', () => {
    const names = loadManifests().map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });
});
