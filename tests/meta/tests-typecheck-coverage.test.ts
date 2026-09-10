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

/**
 * Deferred trees containing the local runtime's agent, capture, CLI, daemon,
 * database, Grove, host, vault and worker suites. Explicit inclusions below
 * identify the typechecked suites within these trees.
 */
const AWAITING_THE_1_4_SWEEP = [
  'agent',
  'canopy',
  'capture',
  'cli',
  'daemon',
  'db',
  'grove',
  'host',
  'integration',
  'team-host',
  'vault',
  'worker',
] as const;

/**
 * Explicitly typechecked 2.0 suites inside deferred trees: login, import,
 * repository checkout, server run adapters, and supervisor policy.
 * This gate checks list equality; it does not classify runtime ownership.
 */
const TYPED_INSIDE_A_DEFERRED_TREE = [
  path.join('cli', 'import.test.ts'),
  path.join('cli', 'login.test.ts'),
  path.join('agent', 'repository-checkout.test.ts'),
  path.join('agent', 'run-store-http.test.ts'),
  path.join('agent', 'server-runner.test.ts'),
  path.join('agent', 'server-tool-surface.test.ts'),
  path.join('agent', 'server-tools.test.ts'),
  path.join('agent', 'supervisor-policy.test.ts'),
] as const;

/**
 * Trees and files the UI packages' own configs typecheck: they are built
 * against the React and jsdom types under each package's own `ui` directory,
 * which this program does not load. The `typecheck:ui` and `check:ui` scripts
 * cover them.
 */
const TYPED_BY_THE_UI_CONFIGS = [
  'ui',
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
    const named = [...AWAITING_THE_1_4_SWEEP, ...TYPED_BY_THE_UI_CONFIGS];
    expect([...excluded].sort()).toEqual([...named].sort());
    expect(new Set(named).size).toBe(named.length);
  });

  test('the config types exactly the survivors named here, each inside a deferred tree', () => {
    expect([...typedByName].sort()).toEqual([...TYPED_INSIDE_A_DEFERRED_TREE].sort());
    const deferred = new Set<string>(AWAITING_THE_1_4_SWEEP);
    for (const file of TYPED_INSIDE_A_DEFERRED_TREE) {
      const tree = file.split(path.sep)[0]!;
      expect({ file, insideADeferredTree: deferred.has(tree) }).toEqual({ file, insideADeferredTree: true });
    }
  });

  test('every name still resolves on disk, so a deletion cannot leave a stale one behind', () => {
    const named = [...AWAITING_THE_1_4_SWEEP, ...TYPED_INSIDE_A_DEFERRED_TREE, ...TYPED_BY_THE_UI_CONFIGS];
    expect(named.filter((name) => !fs.existsSync(path.join(TESTS, name)))).toEqual([]);
  });

  test('the Cloudflare declarations the program loads declare no global Buffer', () => {
    const entry = config.compilerOptions.types.find((name) => name.startsWith('@cloudflare/workers-types'));
    expect(entry).toBe('@cloudflare/workers-types/experimental');
    const declarations = fs.readFileSync(path.join(REPO, 'node_modules', entry!, 'index.d.ts'), 'utf-8');
    expect(declarations.split('\n').filter((line) => /^declare (const|var|let) Buffer\b/.test(line))).toEqual([]);
  });
});
