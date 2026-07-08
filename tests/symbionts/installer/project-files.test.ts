/*
 * Tests for project-local skill symlink syncing + reconcile.
 *
 * Regression guard for the packaged-daemon bug where `syncSkillSymlinks` read
 * the manifest YAMLs straight off disk to discover `skillsTarget` paths. In the
 * Bun-compiled binary those live in the /$bunfs/ virtual filesystem where
 * `readdirSync` returns empty, so ZERO agent symlinks were created — silently.
 * Target discovery now flows through the binary-safe `loadManifests()` and is
 * gated on machine detection (`detectionDir` exists) minus per-project opt-out.
 *
 * Detection resolves agent presence from `~/.<agent>` via `expandHome`
 * (→ `process.env.HOME`), so these tests drive it deterministically by pointing
 * HOME at a temp dir and creating the agent home dirs they want.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CANONICAL_SKILLS_DIR,
  reconcileProjectSkillSymlinks,
  resolveEnabledSkillTargets,
  syncSkillSymlinks,
} from '@myco/symbionts/installer/project-files.js';

const CLAUDE = { home: '.claude', target: '.claude/skills', name: 'claude-code' };
const CLINE = { home: '.cline', target: '.cline/skills', name: 'cline' };

describe('project skill symlinks', () => {
  let tmp: string;
  let home: string;
  let project: string;
  let saved: Record<string, string | undefined>;

  function writeSkill(name: string): void {
    const dir = path.join(project, CANONICAL_SKILLS_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`, 'utf-8');
  }
  /** Make an agent "installed on the machine" by creating its `~/.<agent>`. */
  function detectAgent(agentHome: string): void {
    fs.mkdirSync(path.join(home, agentHome), { recursive: true });
  }
  function exists(rel: string): boolean {
    try { fs.lstatSync(path.join(project, rel)); return true; } catch { return false; }
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pf-'));
    home = path.join(tmp, 'home');
    project = path.join(tmp, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    saved = {
      HOME: process.env.HOME,
      MYCO_SANDBOX_ROOT: process.env.MYCO_SANDBOX_ROOT,
      MYCO_HOME: process.env.MYCO_HOME,
    };
    process.env.HOME = home;
    delete process.env.MYCO_SANDBOX_ROOT; // avoid expandHome sandbox assertion
    process.env.MYCO_HOME = path.join(home, '.myco'); // keep config loads sandboxed
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('resolveEnabledSkillTargets', () => {
    test('returns only machine-detected agents (detectionDir present)', () => {
      detectAgent(CLAUDE.home);
      expect(resolveEnabledSkillTargets(project)).toEqual([CLAUDE.target]);
      detectAgent(CLINE.home);
      expect(resolveEnabledSkillTargets(project).sort()).toEqual([CLAUDE.target, CLINE.target].sort());
    });

    test('excludes an undetected agent', () => {
      detectAgent(CLAUDE.home); // cline home absent
      expect(resolveEnabledSkillTargets(project)).not.toContain(CLINE.target);
    });

    test('honors per-project opt-out', () => {
      detectAgent(CLAUDE.home);
      detectAgent(CLINE.home);
      fs.writeFileSync(
        path.join(project, '.myco', 'myco.yaml'),
        `version: 3\nsymbionts:\n  ${CLAUDE.name}:\n    enabled: true\n  ${CLINE.name}:\n    enabled: false\n`,
        'utf-8',
      );
      const targets = resolveEnabledSkillTargets(project);
      expect(targets).toContain(CLAUDE.target);
      expect(targets).not.toContain(CLINE.target);
    });

    test('no detected agents → empty', () => {
      expect(resolveEnabledSkillTargets(project)).toEqual([]);
    });
  });

  describe('syncSkillSymlinks', () => {
    test('links a skill only into detected agent dirs, resolving to canonical', () => {
      detectAgent(CLAUDE.home); // cline absent
      writeSkill('alpha');
      syncSkillSymlinks(project, 'alpha');

      expect(exists('.claude/skills/alpha')).toBe(true);
      expect(exists('.cline/skills/alpha')).toBe(false);
      const resolved = fs.realpathSync(path.join(project, '.claude/skills/alpha/SKILL.md'));
      const canon = fs.realpathSync(path.join(project, CANONICAL_SKILLS_DIR, 'alpha', 'SKILL.md'));
      expect(resolved).toBe(canon);
    });

    test('remove deletes from all managed dirs incl. retired (.cursor/skills)', () => {
      detectAgent(CLAUDE.home);
      writeSkill('alpha');
      syncSkillSymlinks(project, 'alpha');
      // seed a retired .cursor/skills link as an older install would have left.
      const cursorDir = path.join(project, '.cursor/skills');
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.symlinkSync(path.join('..', '..', CANONICAL_SKILLS_DIR, 'alpha'), path.join(cursorDir, 'alpha'));

      syncSkillSymlinks(project, 'alpha', { remove: true });
      expect(exists('.claude/skills/alpha')).toBe(false);
      expect(exists('.cursor/skills/alpha')).toBe(false);
    });

    test('refuses unsafe skill names', () => {
      detectAgent(CLAUDE.home);
      syncSkillSymlinks(project, '../escape');
      expect(exists('.claude/skills')).toBe(false);
    });
  });

  describe('reconcileProjectSkillSymlinks', () => {
    test('creates missing, prunes stale/retired, preserves user links', () => {
      detectAgent(CLAUDE.home); // cline NOT detected
      writeSkill('alpha');
      writeSkill('beta');

      const claudeDir = path.join(project, '.claude/skills');
      fs.mkdirSync(claudeDir, { recursive: true });
      // (1) stale Myco link to a removed skill — dangling, under .agents/skills.
      fs.symlinkSync(path.join('..', '..', CANONICAL_SKILLS_DIR, 'gone'), path.join(claudeDir, 'gone'));
      // (2) user-owned link pointing OUTSIDE .agents/skills — must be preserved.
      fs.mkdirSync(path.join(project, 'external-skill'), { recursive: true });
      fs.symlinkSync(path.join('..', '..', 'external-skill'), path.join(claudeDir, 'mine'));
      // (3) retired .cursor/skills Myco link — must be pruned.
      const cursorDir = path.join(project, '.cursor/skills');
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.symlinkSync(path.join('..', '..', CANONICAL_SKILLS_DIR, 'alpha'), path.join(cursorDir, 'alpha'));

      const { created, pruned } = reconcileProjectSkillSymlinks(project);

      // created: alpha + beta linked into the detected .claude/skills
      expect(exists('.claude/skills/alpha')).toBe(true);
      expect(exists('.claude/skills/beta')).toBe(true);
      expect(created).toBeGreaterThanOrEqual(2);
      // pruned: dangling `gone` + retired `.cursor/skills/alpha`
      expect(exists('.claude/skills/gone')).toBe(false);
      expect(exists('.cursor/skills/alpha')).toBe(false);
      expect(pruned).toBeGreaterThanOrEqual(2);
      // preserved: user link pointing outside .agents/skills
      expect(exists('.claude/skills/mine')).toBe(true);
      // undetected agent gets nothing
      expect(exists('.cline/skills/alpha')).toBe(false);
    });

    test('removes links for an opted-out agent', () => {
      detectAgent(CLAUDE.home);
      detectAgent(CLINE.home);
      writeSkill('alpha');
      // first reconcile: both detected, no opt-out → both linked
      reconcileProjectSkillSymlinks(project);
      expect(exists('.claude/skills/alpha')).toBe(true);
      expect(exists('.cline/skills/alpha')).toBe(true);

      // opt cline out, reconcile again → cline link pruned, claude kept
      fs.writeFileSync(
        path.join(project, '.myco', 'myco.yaml'),
        `version: 3\nsymbionts:\n  ${CLAUDE.name}:\n    enabled: true\n  ${CLINE.name}:\n    enabled: false\n`,
        'utf-8',
      );
      reconcileProjectSkillSymlinks(project);
      expect(exists('.claude/skills/alpha')).toBe(true);
      expect(exists('.cline/skills/alpha')).toBe(false);
    });

    test('does NOT mass-prune live-target links when no agent is detected', () => {
      // No detectAgent() calls → detectMachineInstalledSymbionts() is empty.
      // A transient empty detection must not delete every existing skill link;
      // only dangling (skill gone) and retired-dir links are still pruned.
      writeSkill('alpha');
      const claudeDir = path.join(project, '.claude/skills');
      fs.mkdirSync(claudeDir, { recursive: true });
      // existing Myco link for a REAL skill — must be preserved
      fs.symlinkSync(path.join('..', '..', CANONICAL_SKILLS_DIR, 'alpha'), path.join(claudeDir, 'alpha'));
      // dangling link (skill removed) — still pruned
      fs.symlinkSync(path.join('..', '..', CANONICAL_SKILLS_DIR, 'gone'), path.join(claudeDir, 'gone'));
      // retired .cursor/skills link — still pruned
      const cursorDir = path.join(project, '.cursor/skills');
      fs.mkdirSync(cursorDir, { recursive: true });
      fs.symlinkSync(path.join('..', '..', CANONICAL_SKILLS_DIR, 'alpha'), path.join(cursorDir, 'alpha'));

      reconcileProjectSkillSymlinks(project);

      expect(exists('.claude/skills/alpha')).toBe(true);  // preserved (no mass-prune)
      expect(exists('.claude/skills/gone')).toBe(false);  // dangling still pruned
      expect(exists('.cursor/skills/alpha')).toBe(false); // retired still pruned
    });
  });
});
