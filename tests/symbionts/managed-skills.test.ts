/**
 * ensureManagedSkills + global skill sourcing.
 *
 * Global skill links must resolve to the managed `<mycoHome>/skills` dir, seeded
 * from the binary-embedded bundle — a stable target that survives a checkout
 * deletion and self-heals on the detection tick. The managed daemon binary has
 * no `skills/` under its own root, so sourcing from packageRoot was a silent
 * no-op for native/curl installs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensureManagedSkills } from '@myco/symbionts/managed-skills.js';
import { managedSkillsDir } from '@myco/install/managed-binary.js';
import { BUNDLED_SKILLS } from '@myco/symbionts/skills.generated.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { loadManifests } from '@myco/symbionts/detect.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

describe('ensureManagedSkills', () => {
  let tmpHome: string;
  let mycoHome: string;
  let prevHome: string | undefined;
  let prevMycoHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-managed-skills-'));
    mycoHome = path.join(tmpHome, '.myco');
    prevHome = process.env.HOME;
    prevMycoHome = process.env.MYCO_HOME;
    process.env.HOME = tmpHome;
    process.env.MYCO_HOME = mycoHome;
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
  });

  function getManifest(name: string) {
    const m = loadManifests().find((x) => x.name === name);
    if (!m) throw new Error(`Manifest not found: ${name}`);
    return m;
  }

  it('writes every bundled skill file to <mycoHome>/skills', () => {
    ensureManagedSkills(mycoHome);
    const skillsDir = managedSkillsDir(mycoHome);
    for (const [skillName, files] of Object.entries(BUNDLED_SKILLS)) {
      for (const [relPath, content] of Object.entries(files)) {
        const dest = path.join(skillsDir, skillName, relPath);
        expect(fs.existsSync(dest)).toBe(true);
        expect(fs.readFileSync(dest, 'utf-8')).toBe(content);
      }
    }
    // Sanity: every skill carries a SKILL.md (the installer's skill predicate).
    for (const skillName of Object.keys(BUNDLED_SKILLS)) {
      expect(fs.existsSync(path.join(skillsDir, skillName, 'SKILL.md'))).toBe(true);
    }
  });

  it('is idempotent — a second run leaves identical content', () => {
    ensureManagedSkills(mycoHome);
    const skillsDir = managedSkillsDir(mycoHome);
    const firstSkill = Object.keys(BUNDLED_SKILLS)[0];
    const probe = path.join(skillsDir, firstSkill, 'SKILL.md');
    const before = fs.readFileSync(probe, 'utf-8');
    ensureManagedSkills(mycoHome);
    expect(fs.readFileSync(probe, 'utf-8')).toBe(before);
  });

  it('prunes a stale skill dir, a stale file, and a stray top-level non-dir entry', () => {
    ensureManagedSkills(mycoHome);
    const skillsDir = managedSkillsDir(mycoHome);
    // Simulate drift: a removed skill dir, a removed reference file, and a stray
    // top-level file/symlink left by a prior version (the A3 non-directory case).
    const staleSkill = path.join(skillsDir, 'retired-skill');
    fs.mkdirSync(staleSkill, { recursive: true });
    fs.writeFileSync(path.join(staleSkill, 'SKILL.md'), 'stale\n', 'utf-8');
    const keptSkill = Object.keys(BUNDLED_SKILLS)[0];
    const staleFile = path.join(skillsDir, keptSkill, 'references', 'gone.md');
    fs.mkdirSync(path.dirname(staleFile), { recursive: true });
    fs.writeFileSync(staleFile, 'stale\n', 'utf-8');
    const strayTopFile = path.join(skillsDir, 'README');
    fs.writeFileSync(strayTopFile, 'stray\n', 'utf-8');

    ensureManagedSkills(mycoHome);

    expect(fs.existsSync(staleSkill)).toBe(false);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(strayTopFile)).toBe(false);
    // The kept skill's real files survive.
    expect(fs.existsSync(path.join(skillsDir, keptSkill, 'SKILL.md'))).toBe(true);
  });
});

describe('manifest globalSkillsTarget mapping (.agents standard + exceptions)', () => {
  // Identity of the symbiont skills model: everything reads the cross-agent
  // `~/.agents/skills` standard EXCEPT claude (`~/.claude/skills`) and cline
  // (`~/.cline/skills`), which don't read `.agents`. Locks the corrected
  // manifests against regression to the old per-agent dirs.
  const EXCEPTIONS: Record<string, string> = {
    'claude-code': '~/.claude/skills',
    cline: '~/.cline/skills',
  };

  it('non-exception agents target ~/.agents/skills; exceptions keep their own dir', () => {
    let checked = 0;
    for (const m of loadManifests()) {
      const target = m.registration?.globalSkillsTarget;
      if (!target) continue;
      checked += 1;
      if (m.name in EXCEPTIONS) {
        expect(target).toBe(EXCEPTIONS[m.name]);
      } else {
        expect(target).toBe('~/.agents/skills');
      }
    }
    expect(checked).toBeGreaterThanOrEqual(7);
  });
});

describe('SymbiontInstaller — global skill cleanup', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevMycoHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cleanup-'));
    prevHome = process.env.HOME;
    prevMycoHome = process.env.MYCO_HOME;
    process.env.HOME = tmpHome;
    process.env.MYCO_HOME = path.join(tmpHome, '.myco');
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
  });

  function codexGlobal() {
    const m = loadManifests().find((x) => x.name === 'codex');
    if (!m) throw new Error('codex manifest not found');
    return new SymbiontInstaller(m, tmpHome, PKG_ROOT, false);
  }
});
