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

import { checkFrontmatterPreservation, extractFrontmatterFields, MAX_SKILL_DESCRIPTION_CHARS } from '@myco/agent/tools/skill-validator.js';
import { descriptionHardContaminationLength } from '@myco/agent/tools/skill-contamination.js';

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

describe('checkFrontmatterPreservation — description floor', () => {
  // ---------------------------------------------------------------------------
  // Test group 1: Clamp/deadlock guard
  //
  // The floor's input is the on-disk frontmatter description. When that
  // description exceeds the 1024 ceiling, the effective basis is clamped to
  // 1024 before multiplying by 0.9 — so the floor is always strictly below
  // the ceiling and any update in [floor, 1024] is satisfiable.
  // ---------------------------------------------------------------------------

  it('accepts a 1000-char update when the on-disk description is 1299 chars (clamp prevents deadlock)', () => {
    const oldDesc = 'a'.repeat(MAX_SKILL_DESCRIPTION_CHARS + 275); // 1299 — exceeds ceiling
    const newDesc = 'b'.repeat(1000); // within [921.6, 1024] — satisfiable window after clamp
    const existing = skillWithDescription('clamp-test', oldDesc);
    const incoming = skillWithDescription('clamp-test', newDesc);

    const violations = checkFrontmatterPreservation(existing, incoming);

    expect(violations.filter((v) => v.includes('shortened'))).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test group 2: Normal floor still enforced
  // ---------------------------------------------------------------------------

  it('rejects a new description shorter than 90% of the old length', () => {
    const oldDesc = 'a'.repeat(954);  // floor = 954 * 0.9 = 858.6
    const tooShort = 'b'.repeat(672); // well below floor
    const existing = skillWithDescription('floor-reject-test', oldDesc);
    const incoming = skillWithDescription('floor-reject-test', tooShort);

    const violations = checkFrontmatterPreservation(existing, incoming);

    expect(violations.some((v) => v.includes('shortened'))).toBe(true);
  });

  it('accepts a new description at or above 90% of the old length', () => {
    const oldDesc      = 'a'.repeat(954);  // floor = 858.6
    const acceptable   = 'b'.repeat(900);  // 900 >= 858.6 — above floor
    const existing = skillWithDescription('floor-accept-test', oldDesc);
    const incoming = skillWithDescription('floor-accept-test', acceptable);

    const violations = checkFrontmatterPreservation(existing, incoming);

    expect(violations.filter((v) => v.includes('shortened'))).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test group 3: Contamination-aware floor
  //
  // The old description is 954 chars and contains a HARD contamination token
  // `v1.2.0` (6 chars). The floor basis is reduced by the contamination length:
  //   effectiveOldLen = min(954, 1024) - 6 = 948
  //   floor           = 948 * 0.9 = 853.2
  //
  // A 855-char decontaminated description sits below the naive floor (858.6)
  // but above the contamination-aware floor (853.2), so it must be ACCEPTED.
  // An 840-char description is below the contamination-aware floor, so it
  // must still be REJECTED.
  // ---------------------------------------------------------------------------

  it('accepts a decontaminated description shorter than the naive floor when contamination accounts for the difference', () => {
    // 947 'a's + ' v1.2.0' = 954 chars; 'v1.2.0' is a HARD span (6 chars).
    const oldDesc          = 'a'.repeat(947) + ' v1.2.0';
    const decontaminated   = 'b'.repeat(855); // >= 853.2 (contamination-aware floor)
                                               // <  858.6 (naive floor — would have failed before fix)
    const existing = skillWithDescription('contam-accept-test', oldDesc);
    const incoming = skillWithDescription('contam-accept-test', decontaminated);

    const violations = checkFrontmatterPreservation(existing, incoming);

    expect(violations.filter((v) => v.includes('shortened'))).toHaveLength(0);
  });

  it('rejects a new description shorter than the contamination-aware floor', () => {
    const oldDesc    = 'a'.repeat(947) + ' v1.2.0'; // 954 chars, 6 HARD
    const tooShort   = 'b'.repeat(840);              // < 853.2 (contamination-aware floor)
    const existing = skillWithDescription('contam-reject-test', oldDesc);
    const incoming = skillWithDescription('contam-reject-test', tooShort);

    const violations = checkFrontmatterPreservation(existing, incoming);

    expect(violations.some((v) => v.includes('shortened'))).toBe(true);
  });
});

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

describe('extractFrontmatterFields', () => {
  it('parses block-list and quoted-colon values the way the write gates do', () => {
    const content = [
      '---',
      'name: myco:block-list-skill',
      'description: "Covers: block lists"',
      'allowed-tools:',
      '  - Read',
      '  - Grep',
      'user-invocable: true',
      '---',
      '',
      '# Body',
    ].join('\n');

    const fields = extractFrontmatterFields(content);
    expect(fields.name).toBe('myco:block-list-skill');
    expect(fields.description).toBe('Covers: block lists');
    expect(fields['allowed-tools']).toBe('Read, Grep');
    expect(fields['user-invocable']).toBe('true');
  });

  it('returns an empty map for content without frontmatter', () => {
    expect(extractFrontmatterFields('# Just a body\n')).toEqual({});
  });
});
