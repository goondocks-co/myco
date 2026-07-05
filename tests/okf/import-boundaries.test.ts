/**
 * Structural guard: the OKF format library stays pure. Layer rules:
 *
 * - Top-level packages/myco/src/okf/*.ts (the format core) may not reference
 *   db/, daemon/, config/, or vault/ at all — those dependencies arrive in
 *   later layers. Exception: types.ts may import the ProjectScope TYPE from
 *   @myco/grove/ids.
 * - packages/myco/src/okf/projectors/*.ts take already-fetched rows, so they
 *   may use `import type` from @myco/db/... (row shapes only) — but never a
 *   value import: no DB handles, no query execution, no daemon/config/vault.
 *
 * Mirrors the grep-and-fail pattern of tests/ui/capability-gate-no-hardcode.test.ts.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const OKF_SRC = path.join(__dirname, '../../packages/myco/src/okf');

// Match any quoted module reference — static imports, require(), dynamic
// import(), side-effect imports, and root imports without a trailing slash.
const FORBIDDEN_REFERENCE_PATTERNS: RegExp[] = [
  /['"]@myco\/(?:db|daemon|config|vault)(?:\/|['"])/,
  /['"](?:\.\.\/)+(?:db|daemon|config|vault)(?:\/|['"])/,
];

const GROVE_IDS_IMPORT = /from\s+['"]@myco\/grove\/ids(?:\.js)?['"]/;

function tsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => path.join(dir, name));
}

const CORE_FILES = tsFiles(OKF_SRC);
const PROJECTOR_FILES = tsFiles(path.join(OKF_SRC, 'projectors'));

describe('okf import boundaries', () => {
  it('has source files to scan', () => {
    expect(CORE_FILES.length).toBeGreaterThanOrEqual(5);
    expect(PROJECTOR_FILES.length).toBeGreaterThanOrEqual(4);
  });

  it('format core never references db/, daemon/, config/, or vault/', () => {
    const violations: string[] = [];
    for (const file of CORE_FILES) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_REFERENCE_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${path.basename(file)}: matches ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('projectors reference @myco/db only via type-only imports', () => {
    const violations: string[] = [];
    for (const file of PROJECTOR_FILES) {
      const content = fs.readFileSync(file, 'utf8');
      for (const line of content.split('\n')) {
        const referencesForbidden = FORBIDDEN_REFERENCE_PATTERNS.some((pattern) => pattern.test(line));
        if (!referencesForbidden) continue;
        const isTypeOnlyDbImport = /^import\s+type\s.*from\s+['"]@myco\/db\//.test(line.trim());
        if (!isTypeOnlyDbImport) {
          violations.push(`${path.basename(file)}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('imports @myco/grove/ids only from types.ts, and only as a type import', () => {
    for (const file of [...CORE_FILES, ...PROJECTOR_FILES]) {
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
