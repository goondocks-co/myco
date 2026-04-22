import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { detectDrift, extractClaims, extractFileFingerprint } from '@myco/agent/skill-drift.js';

describe('skill-drift helpers', () => {
  it('extractClaims strips fenced code and frontmatter', () => {
    const claims = extractClaims(`---
name: test
---
# Title
Use \`packages/myco/src/foo.ts\` and \`GoodSymbol\`.
\`\`\`ts
const x = \`ignored-token\`;
\`\`\`
`);
    expect(claims.map(c => c.token)).toEqual(['packages/myco/src/foo.ts', 'GoodSymbol']);
  });

  it('extractFileFingerprint reads exported symbols', () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-drift-'));
    const file = join(root, 'sample.ts');
    writeFileSync(file, 'export const ONE = 1;\nexport function Two() {}\nexport type Three = string;\n');
    const fp = extractFileFingerprint(file);
    expect(fp.exports).toEqual(['ONE', 'Three', 'Two']);
    rmSync(root, { recursive: true, force: true });
  });

  it('detectDrift reports missing paths/symbols and growth', () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-drift-'));
    mkdirSync(join(root, 'packages', 'myco', 'src'), { recursive: true });
    mkdirSync(join(root, '.agents', 'skills', 'example'), { recursive: true });

    writeFileSync(
      join(root, 'packages', 'myco', 'src', 'helpers.ts'),
      'export const ExistingSymbol = 1;\nexport const AddedOne = 2;\nexport const AddedTwo = 3;\n',
    );
    writeFileSync(
      join(root, '.agents', 'skills', 'example', 'SKILL.md'),
      '# Skill\nUse `packages/myco/src/helpers.ts` and `ExistingSymbol` and `MissingSymbol`.\nAlso `packages/myco/src/missing.ts`.\n',
    );

    const result = detectDrift([
      {
        id: 'skill-1',
        name: 'example',
        description: 'helpers and symbols',
        path: '.agents/skills/example/SKILL.md',
        properties: JSON.stringify({
          file_fingerprints: {
            'packages/myco/src/helpers.ts': { exports: ['ExistingSymbol'] },
          },
        }),
      },
    ], root, 123);

    expect(result.totalMissing).toBeGreaterThanOrEqual(1);
    expect(result.totalGrowth).toBeGreaterThanOrEqual(1);
    expect(result.reports[0].growth.join(' ')).toContain('AddedOne');
    expect(result.reports[0].currentFingerprints['packages/myco/src/helpers.ts']).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  });
});
