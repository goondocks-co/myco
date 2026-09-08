/**
 * Meta gate: a `@goondocks/myco-shared` subpath is declared in three places, and
 * two of them are silent when they are wrong.
 *
 * Adding a subpath meant editing the package's `exports` map, a `paths` alias in
 * each tsconfig that imports it, and a hand-listed `entrypoints` array in the
 * package's build script. A missing alias fails `tsc` loudly. A missing
 * entrypoint did not: every typecheck passed, the module was simply absent from
 * `dist/`, and the failure arrived as a runtime resolution error inside a
 * bundled Worker — the furthest possible point from the edit that caused it.
 *
 * That third site no longer exists: the build script derives its entrypoints
 * from `exports`. This gate holds what remains, and holds the derivation itself,
 * so the second copy cannot come back unnoticed.
 *
 * The set this gate derives from is the `exports` map, which is the package's
 * public contract, and it holds the other sites to it. It is deliberately NOT
 * derived from the source directory: five modules under `src/` are internal and
 * reached through the index, and demanding a subpath for each would be a rule
 * the package does not follow.
 *
 * Nor does it demand that every tsconfig alias every export. It does not:
 * `packages/myco-server/tsconfig.json` carries no bare alias because the server
 * imports no index. The rule is import-driven — a package aliases what it
 * imports — which is what makes the gate describe the tree rather than an
 * idealised symmetry someone would later have to fight.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHARED = path.join(REPO_ROOT, 'packages/myco-shared');
const SCOPE = '@goondocks/myco-shared';

/** Every tsconfig that may alias the shared package, and the package whose sources it types. */
const TSCONFIGS: ReadonlyArray<{ readonly tsconfig: string; readonly src: string | null }> = [
  { tsconfig: 'tsconfig.json', src: null },
  { tsconfig: 'packages/myco/tsconfig.json', src: 'packages/myco/src' },
  { tsconfig: 'packages/myco-server/tsconfig.json', src: 'packages/myco-server/src' },
];

const readJson = (rel: string): Record<string, any> =>
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8')) as Record<string, any>;

/** Export subpath → the `dist` module it names, from the package's own contract. */
function exportsMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(readJson('packages/myco-shared/package.json').exports as Record<string, { import: string }>)) {
    map.set(key, value.import);
  }
  return map;
}

/** The specifier a caller writes for one export subpath. */
const specifierFor = (subpath: string): string => (subpath === '.' ? SCOPE : `${SCOPE}${subpath.slice(1)}`);

/** The source module one `dist` path was built from. */
const sourceFor = (dist: string): string => path.join(SHARED, dist.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts'));

/** Every `paths` alias in one tsconfig whose key is in the shared scope. */
function aliases(tsconfig: string): Map<string, string> {
  const paths = (readJson(tsconfig).compilerOptions?.paths ?? {}) as Record<string, string[]>;
  const dir = path.dirname(path.join(REPO_ROOT, tsconfig));
  const out = new Map<string, string>();
  for (const [key, [target]] of Object.entries(paths)) {
    if (key === SCOPE || key.startsWith(`${SCOPE}/`)) out.set(key, path.resolve(dir, target));
  }
  return out;
}

/** Every shared-scope specifier imported anywhere under one source tree. */
function importedSpecifiers(srcDir: string): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith('.ts')) {
        for (const [, spec] of fs.readFileSync(full, 'utf-8').matchAll(/from '(@goondocks\/myco-shared[^']*)'/g)) {
          found.add(spec);
        }
      }
    }
  };
  walk(path.join(REPO_ROOT, srcDir));
  return found;
}

const EXPORTS = exportsMap();

describe('the shared package declares each subpath in every place it must', () => {
  it('publishes a non-empty exports map', () => {
    // Every case below iterates this map; an empty one would pass them all.
    expect(EXPORTS.size).toBeGreaterThan(0);
    expect(EXPORTS.has('.')).toBe(true);
  });

  for (const [subpath, dist] of EXPORTS) {
    it(`${subpath} names a source module that exists`, () => {
      expect({ subpath, exists: fs.existsSync(sourceFor(dist)) }).toEqual({ subpath, exists: true });
    });


  }
});

describe('the build derives its entrypoints rather than restating them', () => {
  const build = fs.readFileSync(path.join(SHARED, 'scripts/build.mjs'), 'utf-8');

  it('reads the exports map', () => {
    expect(/exports/.test(build)).toBe(true);
  });

  it('names no module of its own', () => {
    // A hand-listed array beside the exports map is the second copy this file
    // exists to prevent, and it fails silently rather than loudly.
    const named = [...EXPORTS.values()].map((dist) => path.basename(sourceFor(dist), '.ts'));
    expect(named.filter((name) => build.includes(`'${name}'`))).toEqual([]);
  });

  it('builds every published subpath', () => {
    // Run against whatever `dist` the last build produced; absent, this is
    // skipped rather than asserted, since a clean checkout has none.
    const dist = path.join(SHARED, 'dist');
    if (!fs.existsSync(dist)) return;
    const built = new Set(fs.readdirSync(dist).filter((f) => f.endsWith('.js')));
    const expected = [...EXPORTS.values()].map((d) => path.basename(d));
    expect(expected.filter((f) => !built.has(f))).toEqual([]);
  });
});

describe('every shared alias names a declared export, and resolves to its module', () => {
  const declared = new Map([...EXPORTS].map(([subpath, dist]) => [specifierFor(subpath), sourceFor(dist)]));

  for (const { tsconfig } of TSCONFIGS) {
    it(`${tsconfig} aliases nothing undeclared, and points each at the right file`, () => {
      const found = aliases(tsconfig);
      expect(found.size).toBeGreaterThan(0);
      // Compare resolved files, never the path strings: a gate that spells the
      // same relative text as the tsconfig is a second copy of it, and passes
      // for the same reason the tsconfig would be wrong.
      const wrong = [...found]
        .map(([specifier, target]) => ({ specifier, target, expected: declared.get(specifier) }))
        .filter(({ target, expected }) => expected === undefined || path.resolve(target) !== path.resolve(expected));
      expect(wrong.map((w) => w.specifier)).toEqual([]);
    });
  }
});

describe('every package aliases what its own sources import', () => {
  for (const { tsconfig, src } of TSCONFIGS) {
    if (src === null) continue;
    it(`${src} imports nothing its tsconfig does not alias`, () => {
      const aliased = new Set(aliases(tsconfig).keys());
      const imported = importedSpecifiers(src);
      expect(imported.size).toBeGreaterThan(0);
      expect([...imported].filter((spec) => !aliased.has(spec)).sort()).toEqual([]);
    });
  }

  it('the root tsconfig aliases every specifier any package imports, since the tests resolve through it', () => {
    const aliased = new Set(aliases('tsconfig.json').keys());
    const imported = new Set(TSCONFIGS.flatMap(({ src }) => (src === null ? [] : [...importedSpecifiers(src)])));
    expect(imported.size).toBeGreaterThan(0);
    expect([...imported].filter((spec) => !aliased.has(spec)).sort()).toEqual([]);
  });
});
