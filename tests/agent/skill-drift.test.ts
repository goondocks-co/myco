import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  detectDrift,
  extractClaims,
  extractFencedSymbols,
  extractFileFingerprint,
  verifySkillContentClaims,
} from '@myco/agent/skill-drift.js';

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

describe('fence-aware fabrication detection', () => {
  // Mirrors the real corruption: a single-internal-capital camelCase call
  // (`encodeInjection`) and a SCREAMING_SNAKE env var inside a code fence,
  // alongside a legitimate local that must NOT be flagged.
  const FENCED = `# Skill
\`\`\`typescript
process.env.MYCO_CORTEX_INJECTION = encodeInjection(injectionRequest);
const decoded = decodeInjection(process.env.MYCO_CORTEX_INJECTION);
\`\`\`
`;

  it('extractFencedSymbols catches fenced call + SCREAMING_SNAKE, ignores plain locals', () => {
    const symbols = extractFencedSymbols(FENCED);
    expect(symbols).toContain('encodeInjection');
    expect(symbols).toContain('decodeInjection');
    expect(symbols).toContain('MYCO_CORTEX_INJECTION');
    // `injectionRequest` is a local (not followed by `(`) — must be ignored.
    expect(symbols).not.toContain('injectionRequest');
  });

  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'myco-fab-'));
    mkdirSync(join(root, 'packages', 'myco', 'src', 'context'), { recursive: true });
    writeFileSync(
      join(root, 'packages', 'myco', 'src', 'context', 'cortex-injection-context.ts'),
      'export function composeCortexInstructionInjection() {}\n',
    );
    return root;
  }

  it('verifySkillContentClaims rejects missing inline path, warns on fenced symbols', () => {
    const root = makeRoot();
    const content = `# Skill
Located at \`packages/myco/src/agent/harness/cortex-injection-context.ts\`.
${FENCED}`;
    const result = verifySkillContentClaims(content, root);
    expect(result.missingPaths).toContain('packages/myco/src/agent/harness/cortex-injection-context.ts');
    expect(result.suspectFencedSymbols).toEqual(
      expect.arrayContaining(['encodeInjection', 'decodeInjection', 'MYCO_CORTEX_INJECTION']),
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('verifySkillContentClaims does not flag real symbols/paths', () => {
    const root = makeRoot();
    const content = `# Skill
See \`packages/myco/src/context/cortex-injection-context.ts\`.
\`\`\`ts
composeCortexInstructionInjection();
\`\`\`
`;
    const result = verifySkillContentClaims(content, root);
    expect(result.missingPaths).toEqual([]);
    expect(result.missingInlineSymbols).toEqual([]);
    expect(result.suspectFencedSymbols).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('verifySkillContentClaims only flags NEW fabrication when priorContent is given', () => {
    const root = makeRoot();
    const content = `# Skill
Bad \`packages/myco/src/does-not-exist.ts\`.
`;
    // Same dead path already in prior => not newly introduced => not rejected.
    const withPrior = verifySkillContentClaims(content, root, content);
    expect(withPrior.missingPaths).toEqual([]);
    // Without prior (a create), it is flagged.
    const fresh = verifySkillContentClaims(content, root);
    expect(fresh.missingPaths).toContain('packages/myco/src/does-not-exist.ts');
    rmSync(root, { recursive: true, force: true });
  });

  it('verifySkillContentClaims returns no findings when the codebase cannot be seen', () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-empty-'));
    const result = verifySkillContentClaims('Use `packages/x/y.ts` and run `bogusCall()`.', root);
    expect(result.missingPaths).toEqual([]);
    expect(result.missingInlineSymbols).toEqual([]);
    expect(result.suspectFencedSymbols).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it('detectDrift surfaces fenced fabrication suspects', () => {
    const root = makeRoot();
    mkdirSync(join(root, '.agents', 'skills', 'fab'), { recursive: true });
    writeFileSync(join(root, '.agents', 'skills', 'fab', 'SKILL.md'), FENCED);

    const result = detectDrift([
      { id: 'fab-1', name: 'fab', description: 'injection', path: '.agents/skills/fab/SKILL.md', properties: '{}' },
    ], root, 123);

    expect(result.totalFabricationSuspects).toBeGreaterThanOrEqual(2);
    expect(result.reports[0].fabricationSuspects).toEqual(
      expect.arrayContaining(['encodeInjection', 'MYCO_CORTEX_INJECTION']),
    );
    rmSync(root, { recursive: true, force: true });
  });
});
