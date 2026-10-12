import fs from 'node:fs';
import path from 'node:path';
import { isSafeSkillNameForFs } from '@myco/skills/names.js';
import { detectMachineInstalledSymbionts, loadManifests } from './detect.js';
import { ensureSymlink } from './install-helpers.js';
import { getEnabledSymbiontNames, loadMergedConfig } from '../config/loader.js';
import { CANONICAL_SKILLS_DIR } from './installer/legacy-artifacts.js';

/**
 * Non-canonical agent skill directories from the manifest catalogue.
 * Compiled binaries require loadManifests() because their virtual filesystem
 * does not enumerate the bundled YAML directory.
 */
function currentManagedSkillTargets(): string[] {
  const targets = new Set<string>();
  for (const m of loadManifests()) {
    const t = m.registration?.skillsTarget;
    if (t && t !== CANONICAL_SKILLS_DIR) targets.add(t);
  }
  return [...targets];
}

/** Current and retired non-canonical skill directories eligible for link removal. */
function allManagedSkillTargets(): string[] {
  const targets = new Set<string>(currentManagedSkillTargets());
  for (const m of loadManifests()) {
    for (const t of m.registration?.retiredSkillsTargets ?? []) {
      if (t && t !== CANONICAL_SKILLS_DIR) targets.add(t);
    }
  }
  return [...targets];
}

/**
 * Effective agent skill target dirs for a project: agents installed on this
 * machine (`detectionDir` exists) whose `skillsTarget` is non-canonical, minus
 * the project's per-project opt-outs (`symbionts.<name>.enabled = false`).
 *
 * Agents are machine-global, so a detected agent applies to every project
 * unless that project opted it out; when the project declares no `symbionts`
 * override, all detected agents apply. A config-load failure falls back to
 * "all detected" rather than dropping links. `groveId` is irrelevant to
 * `symbionts` resolution (project/local tiers only) but is passed through for
 * merged-config cache-key stability.
 */
export function resolveEnabledSkillTargets(
  projectRoot: string,
  opts?: { vaultDir?: string; groveId?: string | null },
): string[] {
  let enabled: Set<string> | null = null;
  try {
    const vaultDir = opts?.vaultDir ?? path.join(projectRoot, '.myco');
    enabled = getEnabledSymbiontNames(
      loadMergedConfig(vaultDir, { groveId: opts?.groveId ?? undefined }),
    );
  } catch {
    enabled = null;
  }
  const targets = new Set<string>();
  for (const m of detectMachineInstalledSymbionts()) {
    if (enabled !== null && !enabled.has(m.name)) continue;
    const t = m.registration?.skillsTarget;
    if (t && t !== CANONICAL_SKILLS_DIR) targets.add(t);
  }
  return [...targets];
}

/**
 * Create (or, with `remove`, delete) Myco's symlink for one skill in each of
 * the given agent skill target dirs. Pure given `targets` — the caller decides
 * which dirs apply (enabled targets for a create, every managed dir for a
 * removal). Canonical `.agents/skills` is never a link target. Returns the
 * number of links newly written — `ensureSymlink` reports `'linked'` only when
 * it actually creates a new link (`'unchanged'` when one already matched).
 */
function linkSkillIntoTargets(
  projectRoot: string,
  skillName: string,
  targets: string[],
  opts?: { remove?: boolean },
): number {
  const canonicalDir = path.join(projectRoot, CANONICAL_SKILLS_DIR);
  let created = 0;
  for (const target of targets) {
    if (target === CANONICAL_SKILLS_DIR) continue; // canonical is the source, not a link target
    const agentSkillsDir = path.join(projectRoot, target);
    const linkPath = path.join(agentSkillsDir, skillName);
    if (opts?.remove) {
      try { fs.unlinkSync(linkPath); } catch { /* doesn't exist */ }
      try { fs.rmdirSync(agentSkillsDir); } catch { /* not empty or missing */ }
    } else {
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      const relTarget = path.join(path.relative(agentSkillsDir, canonicalDir), skillName);
      if (ensureSymlink(linkPath, relTarget) === 'linked') created++;
    }
  }
  return created;
}

/**
 * Create or remove agent-specific symlinks for one skill in `.agents/skills/<name>`.
 *
 * On create, links into the project's effective enabled agent dirs
 * (machine-detected minus per-project opt-out). On remove, deletes the skill's
 * link from EVERY dir Myco may have created it in (current + retired targets),
 * so a removed skill leaves nothing behind. Called by the skill write/evolve
 * tools after writing (or rolling back) a generated skill on disk.
 */
export function syncSkillSymlinks(
  projectRoot: string,
  skillName: string,
  opts?: { remove?: boolean },
): void {
  // Skill names must remain within their target directory for creation and removal.
  if (!isSafeSkillNameForFs(skillName)) return;

  const targets = opts?.remove
    ? allManagedSkillTargets()
    : resolveEnabledSkillTargets(projectRoot);
  linkSkillIntoTargets(projectRoot, skillName, targets, opts);
}
