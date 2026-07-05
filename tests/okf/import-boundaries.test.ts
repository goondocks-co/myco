/**
 * Structural guard: the OKF format library stays pure. No module under
 * packages/myco/src/okf/ may import from db/, daemon/, config/, or vault/ —
 * those dependencies arrive in later layers (projectors, capability, surfaces).
 * Exception: types.ts may import the ProjectScope TYPE from @myco/grove/ids.
 *
 * Mirrors the grep-and-fail pattern of tests/ui/capability-gate-no-hardcode.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const OKF_SRC = path.join(__dirname, '../../packages/myco/src/okf');

// Match any quoted module reference — static imports, require(), dynamic
// import(), side-effect imports, and root imports without a trailing slash.
const FORBIDDEN_IMPORT_PATTERNS: RegExp[] = [
  /['"]@myco\/(?:db|daemon|config|vault)(?:\/|['"])/,
  /['"](?:\.\.\/)+(?:db|daemon|config|vault)(?:\/|['"])/,
];

const GROVE_IDS_IMPORT = /from\s+['"]@myco\/grove\/ids(?:\.js)?['"]/;

function okfSourceFiles(): string[] {
  return fs
    .readdirSync(OKF_SRC)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(OKF_SRC, name));
}

describe('okf import boundaries', () => {
  it('has source files to scan', () => {
    expect(okfSourceFiles().length).toBeGreaterThanOrEqual(5);
  });

  it('never imports from db/, daemon/, config/, or vault/', () => {
    const violations: string[] = [];
    for (const file of okfSourceFiles()) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${path.basename(file)}: matches ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('imports @myco/grove/ids only from types.ts, and only as a type import', () => {
    for (const file of okfSourceFiles()) {
      const content = fs.readFileSync(file, 'utf8');
      if (!GROVE_IDS_IMPORT.test(content)) continue;
      expect(path.basename(file)).toBe('types.ts');
      const importLines = content.split('\n').filter((line) => GROVE_IDS_IMPORT.test(line));
      for (const line of importLines) {
        expect(line).toMatch(/^import\s+type\s/);
      }
    }
  });
});
