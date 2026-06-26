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

  it('global installSkills links the agent skills dir to the managed skills dir', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });
    ensureManagedSkills(mycoHome);

    const installer = new SymbiontInstaller(
      getManifest('claude-code'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
    );
    expect(installer.installSkills()).toBe(true);

    const skillsDir = managedSkillsDir(mycoHome);
    for (const skillName of Object.keys(BUNDLED_SKILLS)) {
      const link = path.join(tmpHome, '.claude', 'skills', skillName);
      expect(fs.existsSync(link)).toBe(true);
      // The link resolves into the managed skills dir, NOT the checkout packageRoot.
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(skillsDir, skillName)));
      // And it reaches a real SKILL.md through the link.
      expect(fs.existsSync(path.join(link, 'SKILL.md'))).toBe(true);
    }
  });

  it('heals a dangling global skill link by repointing it at the managed dir', () => {
    const agentSkillsDir = path.join(tmpHome, '.claude', 'skills');
    fs.mkdirSync(agentSkillsDir, { recursive: true });
    const skillName = Object.keys(BUNDLED_SKILLS)[0];
    // Simulate the incident: a link into a deleted checkout/worktree.
    const dangling = path.join(agentSkillsDir, skillName);
    fs.symlinkSync('/tmp/myco-deleted-worktree/packages/myco/skills/' + skillName, dangling);
    expect(fs.existsSync(dangling)).toBe(false); // dangling — target absent

    ensureManagedSkills(mycoHome);
    new SymbiontInstaller(
      getManifest('claude-code'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
    ).installSkills();

    const skillsDir = managedSkillsDir(mycoHome);
    expect(fs.realpathSync(dangling)).toBe(fs.realpathSync(path.join(skillsDir, skillName)));
    expect(fs.existsSync(path.join(dangling, 'SKILL.md'))).toBe(true);
  });

  it('global installSkills links the .agents standard target for codex (not ~/.codex/skills)', () => {
    ensureManagedSkills(mycoHome);
    expect(new SymbiontInstaller(
      getManifest('codex'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
    ).installSkills()).toBe(true);

    const skillsDir = managedSkillsDir(mycoHome);
    for (const skillName of Object.keys(BUNDLED_SKILLS)) {
      const link = path.join(tmpHome, '.agents', 'skills', skillName);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(skillsDir, skillName)));
    }
    // The retired per-agent dir is NOT created.
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'skills'))).toBe(false);
  });

  it('two .agents-standard agents installing to the shared ~/.agents/skills is idempotent', () => {
    // codex + cursor both resolve globalSkillsTarget to ~/.agents/skills. The
    // per-manifest installers run independently with no cross-manifest dedup;
    // ensureSymlink early-returns 'unchanged' on the second, so both succeed and
    // the links are correct (the property the "no dedup needed" decision rests on).
    ensureManagedSkills(mycoHome);
    expect(new SymbiontInstaller(
      getManifest('codex'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
    ).installSkills()).toBe(true);
    expect(new SymbiontInstaller(
      getManifest('cursor'), tmpHome, PKG_ROOT, false, undefined, null, 'global',
    ).installSkills()).toBe(true);

    const skillsDir = managedSkillsDir(mycoHome);
    for (const skillName of Object.keys(BUNDLED_SKILLS)) {
      const link = path.join(tmpHome, '.agents', 'skills', skillName);
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(path.join(skillsDir, skillName)));
    }
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
    return new SymbiontInstaller(m, tmpHome, PKG_ROOT, false, undefined, null, 'global');
  }

  it('sweepRetiredGlobalSkills removes current AND legacy links from retired dirs; preserves real + non-Myco content', () => {
    const codexSkills = path.join(tmpHome, '.codex', 'skills'); // codex retiredGlobalSkillsTargets
    fs.mkdirSync(codexSkills, { recursive: true });
    fs.symlinkSync('/tmp/deleted-worktree/skills/myco', path.join(codexSkills, 'myco'));               // current, dangling
    fs.symlinkSync('/tmp/deleted-worktree/skills/myco-curate', path.join(codexSkills, 'myco-curate')); // LEGACY name
    fs.mkdirSync(path.join(codexSkills, 'other-skill'), { recursive: true });                          // non-Myco
    fs.writeFileSync(path.join(codexSkills, 'other-skill', 'SKILL.md'), 'x\n');
    fs.mkdirSync(path.join(codexSkills, 'myco-rules'), { recursive: true });                           // REAL dir at a Myco name
    fs.writeFileSync(path.join(codexSkills, 'myco-rules', 'SKILL.md'), 'hand-authored\n');

    codexGlobal().sweepRetiredGlobalSkills();

    expect(() => fs.lstatSync(path.join(codexSkills, 'myco'))).toThrow();         // current swept
    expect(() => fs.lstatSync(path.join(codexSkills, 'myco-curate'))).toThrow();  // legacy swept
    expect(fs.existsSync(path.join(codexSkills, 'other-skill', 'SKILL.md'))).toBe(true);               // non-Myco kept
    expect(fs.readFileSync(path.join(codexSkills, 'myco-rules', 'SKILL.md'), 'utf-8')).toBe('hand-authored\n'); // real dir kept
  });

  it('uninstallSkills removes agent links even when <mycoHome>/skills was never seeded (C1)', () => {
    // Pre-branch global install: links exist in the agent dir but ~/.myco/skills
    // was never materialized. Uninstall must still clean them (names come from the
    // binary, not the materialized dir).
    const agentSkills = path.join(tmpHome, '.agents', 'skills');
    fs.mkdirSync(agentSkills, { recursive: true });
    for (const name of Object.keys(BUNDLED_SKILLS)) {
      fs.symlinkSync('/somewhere/' + name, path.join(agentSkills, name));
    }
    expect(fs.existsSync(managedSkillsDir(path.join(tmpHome, '.myco')))).toBe(false); // unseeded

    expect(codexGlobal().uninstallSkills()).toBe(true);
    for (const name of Object.keys(BUNDLED_SKILLS)) {
      expect(() => fs.lstatSync(path.join(agentSkills, name))).toThrow();
    }
  });

  it('installSkills removes a stale legacy link from the active target (A2)', () => {
    ensureManagedSkills(path.join(tmpHome, '.myco'));
    const agentSkills = path.join(tmpHome, '.agents', 'skills');
    fs.mkdirSync(agentSkills, { recursive: true });
    fs.symlinkSync('/old/myco-curate', path.join(agentSkills, 'myco-curate')); // legacy link lingering

    codexGlobal().installSkills();

    expect(() => fs.lstatSync(path.join(agentSkills, 'myco-curate'))).toThrow(); // stale legacy removed
    for (const name of Object.keys(BUNDLED_SKILLS)) {
      expect(fs.existsSync(path.join(agentSkills, name))).toBe(true);            // current linked
    }
  });
});
