/**
 * Regression coverage for reconcileConfiguredSymbionts under the global-install
 * model. The reaction fires on every `capture` / `symbionts` scoped-config
 * write (e.g. editing plan-capture dirs in the Settings UI). Before the fix it
 * called `installer.install()` at project scope, silently re-creating
 * `.agents/myco-run.cjs` and repointing the agent hook command at a
 * project-local launcher the global-install migration had just stripped — an
 * invisible un-doing of the clean break.
 *
 * The reconciler is also the pattern for project-managed local files under
 * global install: AGENTS.md and .gitignore today, future repo-local managed
 * surfaces later.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  reconcileConfiguredSymbionts,
  reconcileRegisteredManagedProjectFiles,
} from '@myco/symbionts/reconcile.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';

const created: string[] = [];

function makeGitProjectWithVault(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reconcile-'));
  created.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' });
  fs.mkdirSync(path.join(root, '.myco'), { recursive: true });
  fs.writeFileSync(path.join(root, '.myco/myco.yaml'), 'version: 3\n');
  // A `.claude/` dir present is the common flip-flop trigger: the old
  // getConfiguredManifests selected a manifest whenever its agent config dir
  // existed, then installed project-local launchers for it.
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  return root;
}

describe('reconcileConfiguredSymbionts (global-install model)', () => {
  afterEach(() => {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    created.length = 0;
    clearGroveRegistryCaches();
  });

  it('does NOT re-create project-local launchers (the flip-flop regression)', () => {
    const root = makeGitProjectWithVault();
    reconcileConfiguredSymbionts(root, path.join(root, '.myco'), null);
    expect(fs.existsSync(path.join(root, '.agents/myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.agents/myco-cli.cjs'))).toBe(false);
  });

  it('does not repoint a co-tenant agent hook command at a project-local launcher', () => {
    const root = makeGitProjectWithVault();
    // A user-owned settings file with no Myco hooks must be left untouched.
    fs.writeFileSync(
      path.join(root, '.claude/settings.json'),
      JSON.stringify({ hooks: {} }, null, 2),
    );
    reconcileConfiguredSymbionts(root, path.join(root, '.myco'), null);
    const settings = fs.readFileSync(path.join(root, '.claude/settings.json'), 'utf-8');
    expect(settings).not.toContain('.agents/myco-run.cjs');
  });

  it('reconciles AGENTS.md managed guidance without project-local launcher churn', () => {
    const root = makeGitProjectWithVault();
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      [
        '# Project Rules',
        '',
        '<!-- myco:managed:start -->',
        '## Myco Managed Guidance',
        '',
        '- stale guidance: `node .agents/myco-cli.cjs tool call myco_cortex`',
        '<!-- myco:managed:end -->',
      ].join('\n'),
    );

    reconcileConfiguredSymbionts(root, path.join(root, '.myco'), null);

    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('myco tool call myco_cortex --json --input');
    expect(agents).not.toContain('node .agents/myco-cli.cjs tool call myco_cortex');
    expect(fs.existsSync(path.join(root, '.agents/myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.agents/myco-cli.cjs'))).toBe(false);
  });

  it('reconciles every registered project-managed file in the home (home is the filter)', () => {
    // Home is the boundary now: a single daemon owns every Grove under its
    // MYCO_HOME, so reconciliation covers all in-home projects regardless
    // there is no per-variant filter — all Groves in the home are included.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reconcile-home-'));
    const devRoot = makeGitProjectWithVault();
    const prodRoot = makeGitProjectWithVault();
    created.push(home);

    const devGrove = createGrove('Dogfood', home);
    const prodGrove = createGrove('Production', home);
    registerProjectInGrove(devGrove.id, {
      projectId: 'proj_dev',
      projectName: 'Dev',
      projectRoot: devRoot,
      bindingId: 'gbind_dev',
    }, home);
    registerProjectInGrove(prodGrove.id, {
      projectId: 'proj_prod',
      projectName: 'Prod',
      projectRoot: prodRoot,
      bindingId: 'gbind_prod',
    }, home);

    for (const root of [devRoot, prodRoot]) {
      fs.writeFileSync(
        path.join(root, 'AGENTS.md'),
        [
          '# Project Rules',
          '',
          '<!-- myco:managed:start -->',
          '## Myco Managed Guidance',
          '',
          '- stale guidance: `node .agents/myco-cli.cjs tool call myco_cortex`',
          '<!-- myco:managed:end -->',
        ].join('\n'),
      );
    }

    const outcomes = reconcileRegisteredManagedProjectFiles({ mycoHome: home });

    expect(outcomes.map((o) => o.projectId).sort()).toEqual(['proj_dev', 'proj_prod']);
    // Both projects in the home get their stale guidance rewritten.
    expect(fs.readFileSync(path.join(devRoot, 'AGENTS.md'), 'utf-8'))
      .toContain('myco tool call myco_cortex --json --input');
    expect(fs.readFileSync(path.join(prodRoot, 'AGENTS.md'), 'utf-8'))
      .toContain('myco tool call myco_cortex --json --input');
  });
});
