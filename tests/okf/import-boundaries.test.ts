/**
 * Structural guards on the OKF module layering (grep-and-fail, mirroring
 * tests/ui/capability-gate-no-hardcode.test.ts).
 *
 * Two layers under packages/myco/src/okf/ (Phase 1's projectors/*.ts layer was
 * deleted in Task 0.1; Task 2.1 replaced gather.ts with synthesis/sources.ts
 * as the synthesis layer's own boundary-guarded member):
 *  - Pure format core (types, frontmatter, paths, serialize, indexes, validate,
 *    privacy, errors, output-root, publish-eligibility): no db/daemon/config/
 *    vault value imports. types.ts may import the ProjectScope TYPE.
 *  - Capability layer (bundle.ts, synthesis/sources.ts): may use db/config/
 *    vault — that is their job — but must NEVER import SymbiontInstaller, the
 *    daemon, the scheduler, AGENTS.md machinery, or Cortex modules. OkfBundle
 *    is the single writer of bundle files and owns none of discovery/
 *    scheduling; gatherSources only reads.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const OKF_SRC = path.join(__dirname, '../../packages/myco/src/okf');

const PURE_CORE = [
  'types.ts',
  'frontmatter.ts',
  'paths.ts',
  'serialize.ts',
  'indexes.ts',
  'validate.ts',
  'privacy.ts',
  'errors.ts',
  'output-root.ts',
  'publish-eligibility.ts',
];
const CAPABILITY_LAYER = ['bundle.ts', 'synthesis/sources.ts'];

const DB_CONFIG_VAULT: RegExp[] = [
  /['"]@myco\/(?:db|daemon|config|vault)(?:\/|['"])/,
  /['"](?:\.\.\/)+(?:db|daemon|config|vault)(?:\/|['"])/,
];
const GROVE_IDS_IMPORT = /from\s+['"]@myco\/grove\/ids(?:\.js)?['"]/;

// Modules the capability layer must never reach — discovery, scheduling, Cortex.
const FORBIDDEN_FOR_CAPABILITY: RegExp[] = [
  /['"]@myco\/symbionts\//,
  /['"]@myco\/daemon\//,
  /['"]@myco\/context\//,
  /SymbiontInstaller/,
  /AGENTS\.md/,
  /task-schedul/i,
];

function read(file: string): string {
  return fs.readFileSync(path.join(OKF_SRC, file), 'utf8');
}

describe('okf import boundaries', () => {
  it('the enumerated layers exist on disk', () => {
    for (const f of [...PURE_CORE, ...CAPABILITY_LAYER]) {
      expect(fs.existsSync(path.join(OKF_SRC, f))).toBe(true);
    }
  });

  it('the pure format core never references db/, daemon/, config/, or vault/', () => {
    const violations: string[] = [];
    for (const file of PURE_CORE) {
      const content = read(file);
      for (const pattern of DB_CONFIG_VAULT) {
        if (pattern.test(content)) violations.push(`${file}: matches ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // Phase 2: the projectors/ layer was deleted in Task 0.1 (renderDocuments is
  // stubbed); reinstate an equivalent boundary guard once the synthesis layer
  // that replaces it lands.
  it.skip('projectors reference @myco/db only via type-only imports', () => {
    const projDir = path.join(OKF_SRC, 'projectors');
    const files = fs.readdirSync(projDir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThanOrEqual(4);
    const violations: string[] = [];
    for (const name of files) {
      const content = fs.readFileSync(path.join(projDir, name), 'utf8');
      for (const line of content.split('\n')) {
        if (!DB_CONFIG_VAULT.some((p) => p.test(line))) continue;
        if (!/^import\s+type\s.*from\s+['"]@myco\/db\//.test(line.trim())) violations.push(`${name}: ${line.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('imports @myco/grove/ids only from types.ts, and only as a type import', () => {
    for (const file of PURE_CORE) {
      const content = read(file);
      if (!GROVE_IDS_IMPORT.test(content)) continue;
      expect(file).toBe('types.ts');
      for (const line of content.split('\n').filter((l) => GROVE_IDS_IMPORT.test(l))) {
        expect(line).toMatch(/^import\s+type\s/);
      }
    }
  });

  it('the capability layer never imports SymbiontInstaller, the daemon, the scheduler, AGENTS.md, or Cortex', () => {
    const violations: string[] = [];
    for (const file of CAPABILITY_LAYER) {
      const content = read(file);
      for (const pattern of FORBIDDEN_FOR_CAPABILITY) {
        if (pattern.test(content)) violations.push(`${file}: matches ${pattern}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
