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

import { existsSync, readFileSync } from 'node:fs';
import { getPublishedSkillContent } from '@myco/db/queries/skill-lineage.js';
import { resolvePublishedSkillPaths } from './publication.js';

/**
 * Single resolution rule for published skill content.
 *
 * Lineage-latest is canonical when the skill has a record; the materialized
 * SKILL.md covers hand-authored skills (no record) and legacy records with
 * no lineage rows. The disk read uses the canonical name-derived path —
 * `skill_records.path` is metadata, and every managed writer sets it to the
 * same derived value, so the name is the one source the file lookup trusts.
 *
 * Returns null when the skill has no content anywhere.
 */
export function resolveSkillContent(params: {
  record?: { id: string; name: string } | null;
  /** Skill directory name for record-less (hand-authored) disk reads. */
  name?: string;
  projectRoot?: string | null;
}): string | null {
  const snapshot = params.record ? getPublishedSkillContent(params.record) : null;
  if (snapshot) return snapshot;

  const name = params.record?.name ?? params.name;
  if (!params.projectRoot || !name) return null;

  const resolved = resolvePublishedSkillPaths(params.projectRoot, name);
  if (!resolved.ok || !existsSync(resolved.paths.skillPath)) return null;
  try {
    return readFileSync(resolved.paths.skillPath, 'utf-8');
  } catch {
    return null;
  }
}
