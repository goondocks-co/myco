/**
 * Meta gate: nothing the 2.0 server or the member's config layer depends on
 * lives under `packages/myco/src/agent/`.
 *
 * That tree is the 1.4 phased executor, its orchestrator and its tools, and
 * the sweep (#1170) deletes it whole. A deletion that size is safe only while
 * nothing outside it reaches in: the cost module moved to the server
 * (`packages/myco-server/src/core/cost/`) and the harness and reasoning
 * schemas moved to the shared package (`@goondocks/myco-shared/agent-config`)
 * so this holds. A new import from either place would re-couple the tree to
 * code that survives it, and the sweep would find out by breaking the build.
 *
 * Static source scan (node:fs), no process boot. Every import form the language
 * offers is read: a quoted `from`, a side-effect import, a dynamic `import()`,
 * and a `require`.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The trees that must not reach into the agent tree, and how a reach would be spelled from each. */
const GUARDED: ReadonlyArray<{ tree: string; spellings: readonly RegExp[] }> = [
  {
    tree: 'packages/myco-server/src',
    spellings: [/['"]@myco\/agent\//, /['"](?:\.\.\/)+myco\/src\/agent\//, /packages\/myco\/src\/agent\/[^'"`\s]*['"]/],
  },
  {
    tree: 'packages/myco/src/config',
    spellings: [/['"]@myco\/agent\//, /['"](?:\.\.\/)+agent\//],
  },
];

const IMPORT_FORMS = [
  /\bimport\s[^;]*?\sfrom\s*(['"][^'"]+['"])/g,
  /\bimport\s*(['"][^'"]+['"])/g,
  /\bimport\(\s*(['"][^'"]+['"])\s*\)/g,
  /\brequire\(\s*(['"][^'"]+['"])\s*\)/g,
  /\bexport\s[^;]*?\sfrom\s*(['"][^'"]+['"])/g,
];

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Every module specifier one file imports, in every form. */
function specifiers(source: string): string[] {
  return IMPORT_FORMS.flatMap((form) => [...source.matchAll(form)].map((m) => m[1]!));
}

describe('the agent tree import boundary', () => {
  for (const { tree, spellings } of GUARDED) {
    it(`${tree} imports nothing from packages/myco/src/agent/`, () => {
      const offenders: string[] = [];
      for (const file of tsFiles(path.join(REPO_ROOT, tree))) {
        for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
          if (spellings.some((re) => re.test(spec))) offenders.push(`${path.relative(REPO_ROOT, file)} → ${spec}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('reads every import form, so a reach spelled as a dynamic import or a require is seen', () => {
    const source = [
      "import { a } from '@myco/agent/x.js';",
      "import '@myco/agent/y.js';",
      "const z = await import('@myco/agent/z.js');",
      "const w = require('@myco/agent/w.js');",
      "export { v } from '@myco/agent/v.js';",
    ].join('\n');
    expect(specifiers(source)).toHaveLength(5);
  });
});
