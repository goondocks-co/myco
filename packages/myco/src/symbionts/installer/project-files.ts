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
import { isSafeSkillNameForFs } from '@myco/skills/names.js';
import { ensureSymlink } from '../install-helpers.js';

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

/** Canonical cross-agent skills directory. */
export const CANONICAL_SKILLS_DIR = '.agents/skills';

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
 * Create or remove agent-specific symlinks for a skill in
 * `.agents/skills/<name>`.
 *
 * Reads all symbiont manifests to find skillsTarget paths that differ
 * from the canonical `.agents/skills/` directory, then creates relative
 * symlinks from each target to the canonical location. With
 * `opts.remove: true`, deletes those symlinks instead. Called by
 * vault_write_skill after writing a generated skill to disk.
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

  // Resolve manifests dir — try sibling (source layout) then dist layout
  // (tsup bundles into dist/chunk-*.js, but manifests are at dist/src/symbionts/manifests/)
  const selfDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(selfDir, 'manifests'),
    path.join(selfDir, '..', 'manifests'),
    path.join(selfDir, 'src', 'symbionts', 'manifests'),
    path.join(selfDir, '..', 'src', 'symbionts', 'manifests'),
  ];
  const manifestDir = candidates.find((d) => fs.existsSync(d));
  if (!manifestDir) return;

  const targets = new Set<string>();
  for (const file of fs.readdirSync(manifestDir).filter((f) => f.endsWith('.yaml'))) {
    try {
      const content = fs.readFileSync(path.join(manifestDir, file), 'utf-8');
      const match = content.match(/skillsTarget:\s*(.+)/);
      if (match) targets.add(match[1].trim());
    } catch { /* skip unreadable manifests */ }
  }

  for (const target of targets) {
    if (target === CANONICAL_SKILLS_DIR) continue; // canonical is the source, not a link target

    const agentSkillsDir = path.join(projectRoot, target);
    const linkPath = path.join(agentSkillsDir, skillName);

    if (opts?.remove) {
      try { fs.unlinkSync(linkPath); } catch { /* doesn't exist */ }
      try { fs.rmdirSync(agentSkillsDir); } catch { /* not empty or missing */ }
    } else {
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      const canonicalDir = path.join(projectRoot, CANONICAL_SKILLS_DIR);
      const relTarget = path.join(path.relative(agentSkillsDir, canonicalDir), skillName);
      ensureSymlink(linkPath, relTarget);
      // Ensure a local .gitignore ignores all symlinks in this directory.
      // Localized to the agent's skills dir — doesn't pollute the project .gitignore.
      ensureLocalSkillsGitignore(agentSkillsDir);
    }
  }
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
