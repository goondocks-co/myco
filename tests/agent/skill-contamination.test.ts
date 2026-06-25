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

import { scanForContamination } from '@myco/agent/tools/skill-contamination.js';
import { validateSkillContent } from '@myco/agent/tools/skill-validator.js';

function skill(body: string, frontmatter = ''): string {
  return `---\nname: myco:test-skill\ndescription: Test skill\nmanaged_by: myco\nuser-invocable: true\nallowed-tools: Read, Grep\n${frontmatter}---\n\n${body}`;
}

describe('skill contamination scanner', () => {
  it('hard-flags parenthetical Myco release tags and preserves original offsets', () => {
    const content = skill('# Skill\n\nCritical discovery (v0.27.17): use the new workflow.');

    const result = scanForContamination(content);

    expect(result.hard).toEqual([
      expect.objectContaining({
        kind: 'myco-version-parenthetical',
        text: '(v0.27.17)',
      }),
    ]);
    const span = result.hard[0];
    expect(content.slice(span.start, span.end)).toBe(span.text);
    expect(result.warn).toEqual([]);
  });

  it('hard-flags marker and artifact co-location that is not parenthetical', () => {
    const result = scanForContamination(skill('This guard was added in PR #508 after the flood.'));

    expect(result.hard).toEqual([
      expect.objectContaining({
        kind: 'marker-artifact',
        text: 'added in PR #508',
      }),
    ]);
    expect(result.warn).toEqual([]);
  });

  it('treats bare third-party versions and teaching PR references as warnings only', () => {
    const result = scanForContamination(skill([
      'SQLite does not support DROP COLUMN before version 3.35.0.',
      'Use PR #346 as a teaching example for docs placement.',
    ].join('\n')));

    expect(result.hard).toEqual([]);
    expect(result.warn).toEqual([
      expect.objectContaining({ kind: 'third-party-version', text: '3.35.0' }),
      expect.objectContaining({ kind: 'reference-id', text: 'PR #346' }),
    ]);
  });

  it('treats parenthetical v-prefixed third-party versions as warnings only', () => {
    const result = scanForContamination(skill('Use Node (v22.11.0) for local testing.'));

    expect(result.hard).toEqual([]);
    expect(result.warn).toEqual([
      expect.objectContaining({ kind: 'third-party-version', text: 'v22.11.0' }),
    ]);
  });

  it('treats comparator and package third-party v-prefixed versions as warnings only', () => {
    const result = scanForContamination(skill([
      'Use Node >= v22.11.0 and npm@v10.1.0 for local testing.',
      'Use Node version >= v22.12.0 or Node (>= v22.13.0) for composed constraints.',
    ].join('\n')));

    expect(result.hard).toEqual([]);
    expect(result.warn).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'third-party-version', text: 'v22.11.0' }),
      expect.objectContaining({ kind: 'third-party-version', text: 'v10.1.0' }),
      expect.objectContaining({ kind: 'third-party-version', text: 'v22.12.0' }),
      expect.objectContaining({ kind: 'third-party-version', text: 'v22.13.0' }),
    ]));
    expect(result.warn).toHaveLength(4);
  });

  it('does not let nearby third-party terms hide Myco release-style versions', () => {
    const result = scanForContamination(skill('SQLite support changed in v0.27.17 after migration.'));

    expect(result.hard).toEqual([
      expect.objectContaining({ kind: 'myco-version', text: 'v0.27.17' }),
    ]);
    expect(result.warn).toEqual([]);
  });

  it('hard-flags branch names and explicit session or spore state IDs', () => {
    const content = skill([
      'The procedure was drafted on ck/skill-lifecycle-content-hygiene.',
      'The source came from session-abc123 and spore-gotcha-skill-survey.',
    ].join('\n'));

    const result = scanForContamination(content);

    expect(result.hard).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'branch-name', text: 'ck/skill-lifecycle-content-hygiene' }),
      expect.objectContaining({ kind: 'state-id', text: 'session-abc123' }),
      expect.objectContaining({ kind: 'state-id', text: 'spore-gotcha-skill-survey' }),
    ]));
    expect(validateSkillContent(content, 'test-skill')).toEqual(expect.arrayContaining([
      expect.stringContaining('branch-name'),
      expect.stringContaining('state-id'),
    ]));
  });

  it('ignores non-description frontmatter, fenced code, inline code, and historical sections', () => {
    const content = skill([
      'The durable procedure has no release snapshot.',
      '```',
      'Critical discovery (v0.27.17): fenced changelog text is allowed.',
      '```',
      'Inline `v1.2.0` command examples are ignored.',
      '## Old patterns',
      'Critical discovery (v0.27.17): historical note kept deliberately.',
      '## Current procedure',
      'Follow the current workflow.',
    ].join('\n'), 'x-note: v1.2.0\n');

    expect(scanForContamination(content)).toEqual({ hard: [], warn: [] });
  });

  it('scans frontmatter description because it is live trigger prose', () => {
    const content = [
      '---',
      'name: myco:test-skill',
      'description: Critical discovery (v0.27.17) changed this workflow',
      'managed_by: myco',
      'user-invocable: true',
      'allowed-tools: Read, Grep',
      'x-note: v1.2.0',
      '---',
      '',
      'The durable procedure has no release snapshot.',
    ].join('\n');

    const scan = scanForContamination(content);

    expect(scan.hard).toEqual([
      expect.objectContaining({
        kind: 'myco-version-parenthetical',
        text: '(v0.27.17)',
      }),
    ]);
    expect(validateSkillContent(content, 'test-skill')).toEqual(expect.arrayContaining([
      expect.stringContaining('myco-version-parenthetical'),
    ]));
  });

  it('keeps string-slice offsets stable when ignored ranges follow surrogate pairs', () => {
    const content = skill([
      'A unicode marker \u{1F9EA} appears before ignored inline `v1.2.0` text.',
      'The live prose shipped in PR #509.',
    ].join('\n'));

    const result = scanForContamination(content);

    expect(result.hard).toEqual([
      expect.objectContaining({
        kind: 'marker-artifact',
        text: 'shipped in PR #509',
      }),
    ]);
    const span = result.hard[0];
    expect(content.slice(span.start, span.end)).toBe(span.text);
  });

  it('does not allow frontmatter to bypass live-prose contamination', () => {
    const content = skill('Critical discovery (v0.27.17): this skill is history by design.', 'content_lint: history-ok\n');

    expect(scanForContamination(content).hard).toEqual([
      expect.objectContaining({
        kind: 'myco-version-parenthetical',
        text: '(v0.27.17)',
      }),
    ]);
  });
});
