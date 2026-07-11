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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { syncSkillSymlinks } from '@myco/symbionts/installer.js';
import { CANONICAL_PROJECT_SKILLS_DIR, isSafeSkillNameForFs } from './names.js';

export { CANONICAL_PROJECT_SKILLS_DIR };
export const SKILL_MARKDOWN_FILE = 'SKILL.md';

export interface PublishedSkillPaths {
  skillsRoot: string;
  skillDir: string;
  skillPath: string;
  relativePath: string;
}

export type SkillArtifactRefusalReason = 'unsafe_name' | 'path_escape';

export interface SkillArtifactRefusal {
  ok: false;
  reason: SkillArtifactRefusalReason;
  skillDir?: string;
}

export interface SkillArtifactSuccess {
  ok: true;
  paths: PublishedSkillPaths;
}

export type SkillArtifactResult = SkillArtifactSuccess | SkillArtifactRefusal;

export function publishedSkillRelativePath(skillName: string): string {
  return `${CANONICAL_PROJECT_SKILLS_DIR}/${skillName}/${SKILL_MARKDOWN_FILE}`;
}

export function resolvePublishedSkillPaths(projectRoot: string, skillName: string): SkillArtifactResult {
  const skillsRoot = path.resolve(projectRoot, CANONICAL_PROJECT_SKILLS_DIR);
  const skillDir = path.resolve(skillsRoot, skillName);
  const rel = path.relative(skillsRoot, skillDir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    return { ok: false, reason: 'path_escape', skillDir };
  }
  return {
    ok: true,
    paths: {
      skillsRoot,
      skillDir,
      skillPath: path.resolve(skillDir, SKILL_MARKDOWN_FILE),
      relativePath: publishedSkillRelativePath(skillName),
    },
  };
}

/**
 * Materialization chokepoint: every published SKILL.md disk write flows
 * through this function, and relocating the materialization step requires
 * that to stay true. Content truth is `skill_lineage.content_snapshot`;
 * the file written here is the delivery copy coding agents load. Delete
 * side: `removePublishedSkillFileOrDirectory` below.
 */
export function writePublishedSkillFile(
  projectRoot: string,
  skillName: string,
  content: string,
): SkillArtifactResult {
  const resolved = resolvePublishedSkillPaths(projectRoot, skillName);
  if (!resolved.ok) return resolved;

  mkdirSync(resolved.paths.skillDir, { recursive: true });
  writeFileSync(resolved.paths.skillPath, content, 'utf-8');
  return resolved;
}

export function removePublishedSkillFileOrDirectory(
  projectRoot: string,
  skillName: string,
  options?: { fileOnly?: boolean },
): SkillArtifactResult {
  const resolved = resolvePublishedSkillPaths(projectRoot, skillName);
  if (!resolved.ok) return resolved;

  rmSync(options?.fileOnly ? resolved.paths.skillPath : resolved.paths.skillDir, {
    recursive: !options?.fileOnly,
    force: true,
  });
  return resolved;
}

export function syncPublishedSkillSymlinks(
  projectRoot: string,
  skillName: string,
  options?: { remove?: boolean },
): SkillArtifactResult {
  if (!isSafeSkillNameForFs(skillName)) return { ok: false, reason: 'unsafe_name' };

  const resolved = resolvePublishedSkillPaths(projectRoot, skillName);
  if (!resolved.ok) return resolved;

  syncSkillSymlinks(projectRoot, skillName, options);
  return resolved;
}

/**
 * Team Host residency chokepoint, delete side: on a host-served run the host
 * holds the Grove DB but not the member's working tree, so the disk removal
 * must no-op there. Both raw skill-DELETE paths — the agent tool
 * (`agent/tools/skill-tools.ts`) and the daemon API
 * (`daemon/api/skills.ts`) — route through this wrapper instead of each
 * re-implementing an `if (hostServed) return` guard around
 * `removePublishedSkillFileOrDirectory`.
 */
export function removePublishedSkillFileOrDirectoryIfLocal(
  projectRoot: string,
  skillName: string,
  hostServed: boolean,
  options?: { fileOnly?: boolean },
): SkillArtifactResult {
  if (hostServed) return resolvePublishedSkillPaths(projectRoot, skillName);
  return removePublishedSkillFileOrDirectory(projectRoot, skillName, options);
}

/**
 * Team Host residency chokepoint, symlink side — see
 * `removePublishedSkillFileOrDirectoryIfLocal`.
 */
export function syncPublishedSkillSymlinksIfLocal(
  projectRoot: string,
  skillName: string,
  hostServed: boolean,
  options?: { remove?: boolean },
): SkillArtifactResult {
  if (hostServed) return resolvePublishedSkillPaths(projectRoot, skillName);
  return syncPublishedSkillSymlinks(projectRoot, skillName, options);
}
