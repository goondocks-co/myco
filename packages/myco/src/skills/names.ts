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

/**
 * Filesystem-safe shape for a skill record name before recursive deletes or
 * symlink writes. Creation/evolution content validation remains owned by the
 * agent skill validator; this predicate gates replaying stored names onto the
 * local filesystem.
 */
export const SAFE_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export function isSafeSkillNameForFs(name: string): boolean {
  return SAFE_SKILL_NAME_RE.test(name);
}

/**
 * Canonical project-relative directory that holds published skills
 * (`<root>/.agents/skills/<name>/SKILL.md`). Single source of truth — both the
 * skill publication writer and the symbiont installer's symlink reconciler
 * import this so the write side and the link side can never disagree.
 */
export const CANONICAL_PROJECT_SKILLS_DIR = '.agents/skills';

/**
 * Directory holding the skills that ship with Myco, relative to the `myco`
 * package root. The plugin bundle, the in-binary bundle and the Deployment's
 * catalogue are all generated from this one tree.
 */
export const SHIPPED_SKILLS_DIR = 'skills';

/**
 * Ceiling on one shipped skill's listing text — `description` plus
 * `when_to_use`, in UTF-8 bytes. A client appends the two and truncates the
 * pair; text past this point is cut mid-sentence and the skill is offered on a
 * fragment.
 */
export const SHIPPED_SKILL_LISTING_MAX_BYTES = 1536;

/**
 * Ceiling on the listing text of every shipped skill added together, in UTF-8
 * bytes. The per-skill cap bounds one entry and says nothing about the sum:
 * every entry is loaded at session start, and a client over its own listing
 * budget drops entries with a debug-log warning rather than an error, so the
 * skill that pushes the total over is the one nobody sees go missing.
 */
export const SHIPPED_SKILL_LISTING_TOTAL_MAX_BYTES = 8192;

/** Ceiling on a shipped skill's line count. Body past this point is a reference file, not a skill. */
export const SHIPPED_SKILL_MAX_LINES = 500;
