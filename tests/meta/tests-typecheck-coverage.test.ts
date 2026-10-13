/**
 * The test program's exclusions and explicit inclusions match these lists,
 * and every listed path exists. TypeScript applies `files` independently of
 * `exclude`, allowing selected suites inside excluded trees.
 *
 * The Cloudflare declarations must preserve Node's global Buffer type. The
 * package's experimental entrypoint omits the conflicting global declaration.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TESTS = path.join(REPO, 'tests');
const CONFIG = path.join(REPO, 'tsconfig.tests.json');

/** CLI suites have explicit inclusions while their existing type migration is completed. */
const DEFERRED_TEST_TREES = ['cli'] as const;

/** Explicitly typechecked CLI suites; this gate checks paths, not runtime ownership. */
const TYPED_INSIDE_A_DEFERRED_TREE = [
  path.join('cli', 'import.test.ts'),
  path.join('cli', 'login.test.ts'),
  path.join('cli', 'cutover.test.ts'),
  path.join('cli', 'doctor-member-mcp.test.ts'),
  path.join('cli', 'doctor-runtime-pin.test.ts'),
  path.join('cli', 'doctor-worker-service.test.ts'),
  path.join('cli', 'member-machine-verbs.test.ts'),
] as const;

/**
 * Trees and files the UI packages' own configs typecheck: they are built
 * against the React and jsdom types under each package's own `ui` directory,
 * which this program does not load. The `check:ui` script covers them.
 */
const TYPED_BY_THE_UI_CONFIGS = [
  'myco-server-ui',
  path.join('setup', 'jsdom.ts'),
  path.join('setup', 'vitest.ts'),
] as const;

interface TestsConfig {
  compilerOptions: { types: string[] };
  include: string[];
  files: string[];
  exclude: string[];
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')) as TestsConfig;

/** A config entry as a `tests/`-relative name, or null when it names something else. */
const underTests = (entry: string): string | null =>
  entry.startsWith('tests/') && entry.length > 'tests/'.length ? entry.slice('tests/'.length) : null;

const excluded = config.exclude.map(underTests).filter((e): e is string => e !== null);
const typedByName = config.files.map(underTests).filter((e): e is string => e !== null);

describe('tests/ typecheck coverage', () => {
  test('the config includes the whole tree, so a new test tree is typechecked without an edit', () => {
    expect(config.include).toContain('tests/**/*.ts');
  });

  test('the config excludes exactly what is named here, and nothing is named twice', () => {
    const named = [...DEFERRED_TEST_TREES, ...TYPED_BY_THE_UI_CONFIGS];
    expect([...excluded].sort()).toEqual([...named].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  test('the config types exactly the survivors named here, each inside a deferred tree', () => {
    expect([...typedByName].sort()).toEqual([...TYPED_INSIDE_A_DEFERRED_TREE].sort());
    const deferred = new Set<string>(DEFERRED_TEST_TREES);
    for (const file of TYPED_INSIDE_A_DEFERRED_TREE) {
      const tree = file.split(path.sep)[0]!;
      expect({ file, insideADeferredTree: deferred.has(tree) }).toEqual({ file, insideADeferredTree: true });
    }
  });

  test('every name still resolves on disk, so a deletion cannot leave a stale one behind', () => {
    const named = [...DEFERRED_TEST_TREES, ...TYPED_INSIDE_A_DEFERRED_TREE, ...TYPED_BY_THE_UI_CONFIGS];
    expect(named.filter((name) => !fs.existsSync(path.join(TESTS, name)))).toEqual([]);
  });

  test('the Cloudflare declarations the program loads declare no global Buffer', () => {
    const entry = config.compilerOptions.types.find((name) => name.startsWith('@cloudflare/workers-types'));
    expect(entry).toBe('@cloudflare/workers-types/experimental');
    const declarations = fs.readFileSync(path.join(REPO, 'node_modules', entry!, 'index.d.ts'), 'utf-8');
    expect(declarations.split('\n').filter((line) => /^declare (const|var|let) Buffer\b/.test(line))).toEqual([]);
  });
});
