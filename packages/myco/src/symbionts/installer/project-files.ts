/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CANONICAL_PROJECT_SKILLS_DIR, isSafeSkillNameForFs } from '@myco/skills/names.js';
import { detectMachineInstalledSymbionts, loadManifests } from '../detect.js';
import { ensureSymlink } from '../install-helpers.js';
import { getEnabledSymbiontNames, loadMergedConfig } from '../../config/loader.js';

/** Filename when installed into the project .agents/ directory. */
const HOOK_GUARD_INSTALLED_FILENAME = 'myco-run.cjs';

/** Project-local CLI launcher installed beside the capture hook guard. */
const CLI_LAUNCHER_INSTALLED_FILENAME = 'myco-cli.cjs';

/** Project-relative path where the hook guard is installed. */
export const HOOK_GUARD_PROJECT_PATH = `.agents/${HOOK_GUARD_INSTALLED_FILENAME}`;

/** Project-relative path where the CLI launcher is installed. */
export const CLI_LAUNCHER_PROJECT_PATH = `.agents/${CLI_LAUNCHER_INSTALLED_FILENAME}`;

/**
 * Legacy guard filename we still delete on install to clean up previous
 * installations that used `.agents/myco-hook.cjs` before the rename.
 */
export const LEGACY_HOOK_GUARD_PATH = '.agents/myco-hook.cjs';

/** Canonical cross-agent skills directory (single source of truth in skills/names). */
export const CANONICAL_SKILLS_DIR = CANONICAL_PROJECT_SKILLS_DIR;

/** Built-in skill names retired from the package but still present in older installs. */
export const LEGACY_BUILTIN_SKILL_NAMES = ['myco-curate', 'rules'];

/**
 * Active project-shared launchers written by `installHookGuard`. Shared
 * because every symbiont in a project points at the same guard(s), so
 * removing them during one symbiont uninstall can break the remaining
 * symbionts.
 */
const ACTIVE_PROJECT_LAUNCHERS = [
  HOOK_GUARD_PROJECT_PATH,
  CLI_LAUNCHER_PROJECT_PATH,
] as const;

/** Retired launcher artifact — always safe to remove when found. */
const LEGACY_PROJECT_LAUNCHERS = [LEGACY_HOOK_GUARD_PATH] as const;

/** Project-relative path of the runtime-binary pin written by `make dev-link`. */
const PROJECT_RUNTIME_COMMAND_PATH = path.join('.myco', 'runtime.command');

/**
 * Selection knobs for `removeProjectLaunchers`. The walker uses
 * `legacy: true, active: !optIn, runtimeCommand: !optIn` so it can
 * always clean retired artifacts while honoring the project-local
 * opt-in for active launchers + dev pin. `myco remove` opts into all
 * three.
 */
export interface RemoveProjectLaunchersOptions {
  /** Remove the retired `.agents/myco-hook.cjs` guard. Default: true. */
  legacy?: boolean;
  /** Remove active project launchers (`myco-run.cjs`, `myco-cli.cjs`). Default: true. */
  active?: boolean;
  /** Remove `.myco/runtime.command` (the dev pin / opt-in surface). Default: false. */
  runtimeCommand?: boolean;
}

/**
 * Remove project-shared launcher artifacts. Returns the project-
 * relative paths that were actually unlinked. ENOENT is silent (the
 * common "nothing to remove" case); any other error is logged and
 * skipped so a stuck file on one path doesn't abort cleanup of the
 * rest — the caller's audit log surfaces aggregate state via the
 * returned list.
 *
 * Project-level operation: per-symbiont uninstall must not call
 * this. Walker and `myco remove` are the canonical callers.
 */
export function removeProjectLaunchers(
  projectRoot: string,
  options: RemoveProjectLaunchersOptions = {},
): string[] {
  const { legacy = true, active = true, runtimeCommand = false } = options;
  const targets: string[] = [];
  if (active) targets.push(...ACTIVE_PROJECT_LAUNCHERS);
  if (legacy) targets.push(...LEGACY_PROJECT_LAUNCHERS);
  if (runtimeCommand) targets.push(PROJECT_RUNTIME_COMMAND_PATH);

  const removed: string[] = [];
  for (const rel of targets) {
    try {
      fs.unlinkSync(path.join(projectRoot, rel));
      removed.push(rel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      // eslint-disable-next-line no-console
      console.error(`  ⚠ Could not remove ${rel}: ${(err as Error).message}`);
    }
  }
  return removed;
}

/**
 * Non-canonical agent skill target dirs Myco CURRENTLY manages — agents that do
 * NOT read the canonical `.agents/skills/` directly (claude, cline). Agents that
 * resolve to `.agents/skills` (cursor, codex, ...) have no entry. The manifest
 * source MUST be `loadManifests()`: it falls back to codegen-emitted
 * BUNDLED_MANIFESTS when the on-disk YAMLs aren't enumerable. Bun-compiled
 * binaries serve the manifest YAMLs from the /$bunfs/ virtual filesystem where
 * readdirSync returns empty — an earlier version read that directory directly
 * and so produced an empty target set in the packaged daemon, silently creating
 * zero agent symlinks for every harness-written skill.
 */
function currentManagedSkillTargets(): string[] {
  const targets = new Set<string>();
  for (const m of loadManifests()) {
    const t = m.registration?.skillsTarget;
    if (t && t !== CANONICAL_SKILLS_DIR) targets.add(t);
  }
  return [...targets];
}

/**
 * Every non-canonical skill target dir Myco may have created — current targets
 * plus `retiredSkillsTargets` (dirs an agent has since migrated away from, e.g.
 * `.cursor/skills` after cursor adopted `.agents/skills`). Used by removal and
 * the reconcile prune so links in a retired dir are still cleaned up.
 */
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
      // Ensure a local .gitignore ignores all symlinks in this directory.
      // Localized to the agent's skills dir — doesn't pollute the project .gitignore.
      ensureLocalSkillsGitignore(agentSkillsDir);
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
  // Filesystem-safety gate: skillName flows into linkPath / unlinkSync
  // and (during create) into the symlink target string. A peer-supplied
  // name like `../../etc` would otherwise place a symlink outside the
  // agent's skills dir (or, on remove, unlink an arbitrary same-name
  // file). Keep the rule identical to the API-layer gate in
  // `daemon/api/skills.ts` so both paths reject the same set.
  if (!isSafeSkillNameForFs(skillName)) return;

  const targets = opts?.remove
    ? allManagedSkillTargets()
    : resolveEnabledSkillTargets(projectRoot);
  linkSkillIntoTargets(projectRoot, skillName, targets, opts);
}

/**
 * True when `linkPath` is a Myco-owned skill symlink — a symlink (or Windows
 * junction) whose target resolves under the project's canonical
 * `.agents/skills/`. User-added skills (real dirs, or symlinks pointing
 * elsewhere) return false and are never touched by the reconcile/prune.
 *
 * Uses `readlinkSync` (NOT `lstat().isSymbolicLink()`, which is false for the
 * dir junctions Myco creates on symlink-denied Windows hosts) and resolves the
 * stored target relative to the link's dir (POSIX links store a relative path
 * like `../../.agents/skills/<name>`). It deliberately does NOT use
 * `realpathSync`, which would throw on a dangling link (the removed-skill case
 * the prune most needs to catch).
 */
function isMycoOwnedSkillLink(projectRoot: string, linkPath: string): boolean {
  let dest: string;
  try {
    dest = fs.readlinkSync(linkPath);
  } catch {
    return false; // not a symlink/junction (real dir/file, or missing)
  }
  const resolved = path.resolve(path.dirname(linkPath), dest);
  const canon = path.resolve(projectRoot, CANONICAL_SKILLS_DIR);
  return resolved === canon || resolved.startsWith(canon + path.sep);
}

/** Project-local skill names: real `.agents/skills/<name>/` dirs with SKILL.md. */
function listProjectSkillNames(projectRoot: string): string[] {
  const root = path.join(projectRoot, CANONICAL_SKILLS_DIR);
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((name) => isSafeSkillNameForFs(name)
        && fs.existsSync(path.join(root, name, 'SKILL.md')));
  } catch {
    return []; // no .agents/skills yet
  }
}

/**
 * Reconcile a project's agent skill symlinks against the canonical
 * `.agents/skills/` content and the project's effective enabled agents.
 *
 * Idempotent. Creates missing links for present skills in each enabled target,
 * and prunes Myco-owned links that are no longer justified — the skill is gone,
 * the agent was opted out / is no longer installed, or the dir is a retired
 * target (e.g. `.cursor/skills`). Ownership-aware: only links resolving under
 * `.agents/skills/` are removed; user-added skills stay intact.
 *
 * This is the durable, all-projects repair: the periodic MANAGED_FILES_RECONCILE
 * sweep calls it for every registered project, healing projects whose links were
 * never created (the /$bunfs/ readdir bug) and cleaning retired dirs. A free
 * function (not a method) so it never leans on a single `this.manifest`.
 */
export function reconcileProjectSkillSymlinks(
  projectRoot: string,
  opts?: { vaultDir?: string; groveId?: string | null },
): { created: number; pruned: number } {
  const skillNames = listProjectSkillNames(projectRoot);
  const enabledTargets = resolveEnabledSkillTargets(projectRoot, opts);
  const enabledSet = new Set(enabledTargets);
  const liveSkills = new Set(skillNames);
  const currentTargets = new Set(currentManagedSkillTargets());

  // Detection-confidence guard (data-loss safety): if NO agent is detected on
  // this machine, treat detection as inconclusive and DO NOT prune links merely
  // because their agent isn't a live target. Without this, a transient empty
  // detection (e.g. HOME unavailable, or `expandHome` throwing under a sandbox
  // mismatch) makes every existing link look unjustified and the sweep deletes
  // every skill symlink in every project. Dangling links (canonical skill gone)
  // and retired-target dirs stay safe to prune regardless — they never depend
  // on a live agent.
  const detectionConfident = detectMachineInstalledSymbionts().length > 0;

  let created = 0;
  for (const name of skillNames) {
    created += linkSkillIntoTargets(projectRoot, name, enabledTargets);
  }

  // Prune across EVERY dir Myco may have created links in (current + retired),
  // not just enabled ones — an opted-out agent or a retired `.cursor/skills`
  // dir still holds stale links to remove. `target` strings are project-
  // relative; join to projectRoot (NOT expandHome — that's for the ~-prefixed
  // global variant).
  let pruned = 0;
  for (const target of allManagedSkillTargets()) {
    const agentSkillsDir = path.join(projectRoot, target);
    let entries: string[];
    try {
      entries = fs.readdirSync(agentSkillsDir);
    } catch {
      continue; // dir doesn't exist
    }
    const targetRetired = !currentTargets.has(target);
    const targetLive = enabledSet.has(target);
    for (const entry of entries) {
      const linkPath = path.join(agentSkillsDir, entry);
      if (!isMycoOwnedSkillLink(projectRoot, linkPath)) continue;
      // Prune only when it is unambiguously safe: the skill is gone (dangling),
      // the dir is a retired target, or the agent is genuinely not a live target
      // AND detection is confident. Never act on the not-live reason when
      // detection found nothing.
      const shouldPrune = !liveSkills.has(entry)
        || targetRetired
        || (detectionConfident && !targetLive);
      if (!shouldPrune) continue;
      try { fs.unlinkSync(linkPath); pruned++; } catch { /* already gone */ }
    }
    try { fs.rmdirSync(agentSkillsDir); } catch { /* not empty or missing */ }
  }

  return { created, pruned };
}

/** Content for the local .gitignore that ignores Myco-created symlinks. */
const LOCAL_SKILLS_GITIGNORE = `# Myco-managed symlinks — generated skills are symlinked here automatically.
# The canonical location for all skills is .agents/skills/.
#
# To add your own skill to this directory, un-ignore it:
#   !my-skill
*
!.gitignore
`;

/**
 * Bootstrap a .gitignore inside an agent's skills directory so the
 * symlinks Myco creates there don't end up in the user's next `git
 * add`. Write-once: if ANY file already exists at this path — even
 * one the user has hand-edited — leave it untouched. The agent skills
 * dir is created by Myco but the file at this path is a stewardship
 * surface (the user may have added their own ignore patterns there).
 *
 * If `LOCAL_SKILLS_GITIGNORE` ever needs to evolve, contributors must
 * either (a) provide a migration that preserves user-added lines or
 * (b) accept that pre-existing user files keep their old content.
 */
export function ensureLocalSkillsGitignore(agentSkillsDir: string): void {
  const gitignorePath = path.join(agentSkillsDir, '.gitignore');
  if (fs.existsSync(gitignorePath)) return;
  fs.writeFileSync(gitignorePath, LOCAL_SKILLS_GITIGNORE, 'utf-8');
}
