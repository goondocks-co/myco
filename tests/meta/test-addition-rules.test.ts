import { describe, expect, it } from 'bun:test';
import { isProductFile, isTestFile, statementFindings } from '../../scripts/test-addition-rules.mjs';

const NO_FACTS = { productTables: () => new Set<string>(), productFiles: new Set<string>() };
const makePath = (...parts: string[]) => parts.join('/');

describe('test addition rules', () => {
  it('distinguishes test files from product files', () => {
    expect(isTestFile(makePath('tests', 'myco-server', 'gates.test.ts'))).toBe(true);
    expect(isTestFile(makePath('packages', 'myco', 'src', 'symbionts', 'detect.ts'))).toBe(false);

    expect(isProductFile(makePath('packages', 'myco', 'src', 'symbionts', 'detect.ts'))).toBe(true);
    expect(isProductFile(makePath('packages', 'myco-server', 'src', 'core', 'pulled-stages.ts'))).toBe(true);
    expect(isProductFile(makePath('packages', 'myco-server', 'ui', 'src', 'App.tsx'))).toBe(true);
    expect(isProductFile(makePath('packages', 'myco', 'src', 'server-ui-assets.generated.ts'))).toBe(false);
    expect(isProductFile(makePath('tests', 'myco-server', 'gates.test.ts'))).toBe(false);
  });

  it('refuses exported functions, consts, or methods matching test knob names in product code', () => {
    const file = makePath('packages', 'myco-server', 'src', 'core', 'sample.ts');
    const bad = [
      'export function reset() {}',
      'export async function _reset() {}',
      'export const fooForTest = 1;',
      'export let __stateForTests = 2;',
      'export function installTestStagesForTest() {}',
      'export { normal, knob as knobForTest };',
      'export class Lock { __resetForTests() {} }',
    ];
    for (const code of bad) {
      const findings = statementFindings({ file, line: 1, code, text: code }, NO_FACTS);
      expect(findings.map((f: { rule: string }) => f.rule)).toContain('test-knob-name');
    }
  });

  it('allows real operations and ordinary exports in product code', () => {
    const file = makePath('packages', 'myco-server', 'src', 'core', 'sample.ts');
    const good = [
      'export function resetSettings() {}',
      'export const resetEmbeddingIndex = () => {};',
      'export function normalHelper() {}',
      'export const MAX_RETRIES = 3;',
    ];
    for (const code of good) {
      const findings = statementFindings({ file, line: 1, code, text: code }, NO_FACTS);
      expect(findings).toEqual([]);
    }
  });

  it('refuses exports documented with test-only comments in product code', () => {
    const file = makePath('packages', 'myco-server', 'src', 'core', 'sample.ts');
    const commented = [
      { text: '/** Test-only: stage registry */ export function getStages() {}', code: 'export function getStages() {}' },
      { text: '// Exported for testing export function check() {}', code: 'export function check() {}' },
      { text: 'export const seam = 1; // test seam', code: 'export const seam = 1;' },
      { text: '// exposed for tests export const x = 2;', code: 'export const x = 2;' },
    ];
    for (const { text, code } of commented) {
      const findings = statementFindings({ file, line: 1, code, text }, NO_FACTS);
      expect(findings.map((f: { rule: string }) => f.rule)).toContain('test-knob-comment');
    }
  });

  it('does not apply product knob rules to test files or non-export comments', () => {
    const testFile = makePath('tests', 'myco-server', 'sample.test.ts');
    const testCode = 'const knobForTest = 1; // for testing';
    expect(statementFindings({ file: testFile, line: 1, code: testCode, text: testCode }, NO_FACTS)).toEqual([]);

    const prodFile = makePath('packages', 'myco', 'src', 'sample.ts');
    const internalComment = 'function internal() { return 1; }';
    expect(statementFindings({ file: prodFile, line: 1, code: internalComment, text: '// for testing internal logic' }, NO_FACTS)).toEqual([]);
  });
});
