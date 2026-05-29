/**
 * Regression coverage for reconcileConfiguredSymbionts under the global-install
 * model. The reaction fires on every `capture` / `symbionts` scoped-config
 * write (e.g. editing plan-capture dirs in the Settings UI). Before the fix it
 * called `installer.install()` at project scope, silently re-creating
 * `.agents/myco-run.cjs` and repointing the agent hook command at a
 * project-local launcher the global-install migration had just stripped — an
 * invisible un-doing of the clean break. It must now only reconcile the project
 * `.gitignore`.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileConfiguredSymbionts } from '@myco/symbionts/reconcile.js';

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
});
