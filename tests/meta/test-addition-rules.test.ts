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

  it('accepts legitimate product declarations, calls, help strings and explanatory JSDoc', () => {
    const file = makePath('packages', 'myco-server', 'src', 'core', 'sample.ts');
    const table = [
      { name: 'rebuild reset export', code: 'export function reset() {}', text: 'export function reset() {}' },
      { name: 'reset call', code: 'await reset();', text: 'await reset();' },
      { name: 'resetSettings export', code: 'export function resetSettings() {}', text: 'export function resetSettings() {}' },
      { name: 'resetEmbeddingIndex export', code: 'export const resetEmbeddingIndex = () => {};', text: 'export const resetEmbeddingIndex = () => {};' },
      { name: 'help string literal', code: 'export const HELP = "For testing a recovery, select a backup.";', text: 'export const HELP = "For testing a recovery, select a backup.";' },
      { name: 'for testing whether JSDoc', code: 'export function isActive() {}', text: '/** The predicate for testing whether the account is active. */\nexport function isActive() {}' },
      { name: 'ordinary export', code: 'export const MAX_RETRIES = 3;', text: 'export const MAX_RETRIES = 3;' },
    ];
    for (const { code, text } of table) {
      expect(statementFindings({ file, line: 1, code, text }, NO_FACTS)).toEqual([]);
    }
  });

  it('refuses test knob names across functions, consts, defaults, static members, and object properties', () => {
    const file = makePath('packages', 'myco-server', 'src', 'core', 'sample.ts');
    const table = [
      'export async function _reset() {}',
      'export const fooForTest = 1;',
      'export let __stateForTests = 2;',
      'export function installTestStagesForTest() {}',
      'export { normal, knob as knobForTest };',
      'export class Hooks { static __resetForTests = () => {} }',
      'export const Hooks = { __resetForTests: () => {} };',
      'export default resetForTests;',
    ];
    for (const code of table) {
      const findings = statementFindings({ file, line: 1, code, text: code }, NO_FACTS);
      expect(findings.map((f: { rule: string }) => f.rule)).toContain('test-knob-name');
    }
  });

  it('refuses exports documented with test-only exposure phrases in comments', () => {
    const file = makePath('packages', 'myco-server', 'src', 'core', 'sample.ts');
    const table = [
      { text: '/** Test-only: stage registry */\nexport function getStages() {}', code: 'export function getStages() {}' },
      { text: '// for tests only\nexport function check() {}', code: 'export function check() {}' },
      { text: 'export const seam = 1; // test seam', code: 'export const seam = 1;' },
      { text: '// exposed for tests\nexport const x = 2;', code: 'export const x = 2;' },
    ];
    for (const { text, code } of table) {
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
