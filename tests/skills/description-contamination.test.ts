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

import { describe, expect, it } from 'bun:test';

import { descriptionHardContaminationLength } from '@myco/skills/contamination.js';

/** Build valid SKILL.md content with the given description and optional body. */
function skillWithDescription(name: string, description: string, body = '# Skill\n\nBody.'): string {
  return [
    '---',
    `name: myco:${name}`,
    `description: ${description}`,
    'managed_by: myco',
    'user-invocable: true',
    'allowed-tools: Read, Grep',
    '---',
    '',
    body,
  ].join('\n');
}

describe('descriptionHardContaminationLength', () => {
  it('returns the total character length of HARD spans in the description', () => {
    // 'v1.2.0' is a v-prefixed Myco version — a HARD contamination span (6 chars).
    const content = skillWithDescription(
      'version-test',
      'a'.repeat(99) + ' v1.2.0 ' + 'a'.repeat(99),
    );

    expect(descriptionHardContaminationLength(content)).toBe(6);
  });

  it('returns 0 when the description contains only WARN contamination (e.g. an ISO date)', () => {
    // ISO dates trigger a WARN, not a HARD span — they are not required removals
    // and must not discount the floor.
    const content = skillWithDescription(
      'date-test',
      'Updated on 2026-06-25 to improve the workflow coverage.',
    );

    expect(descriptionHardContaminationLength(content)).toBe(0);
  });

  it('returns 0 for a clean description with no contamination', () => {
    const content = skillWithDescription(
      'clean-test',
      'Covers the vault skill write and evolve workflow for Myco-managed skills.',
    );

    expect(descriptionHardContaminationLength(content)).toBe(0);
  });
});
