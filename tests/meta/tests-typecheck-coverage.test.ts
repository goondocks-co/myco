/**
 * Every test tree is either typechecked or named as awaiting the 1.4 sweep.
 *
 * `tsconfig.tests.json` includes the whole `tests/` tree and subtracts a closed
 * list, so a new test tree is typechecked the moment it exists — nobody can add one that
 * nothing reads. What this gate holds is the subtraction: each excluded tree is
 * named here with why it is out, each name still resolves to something on disk,
 * and the two lists stay disjoint. A tree #1170 deletes therefore has to leave
 * both the config and this list in the same commit, which is what keeps the
 * list shrinking instead of outliving the code it describes.
 *
 * It also pins the one type-set decision the program rests on: the Cloudflare
 * declarations it loads must not declare a global `Buffer`. The package root's
 * `index.d.ts` does (`declare const Buffer: any`), and under it every Node
 * `Buffer` method in the program disappears — `toString('hex')` becomes
 * "Expected 0 arguments", `readUInt16LE` and `equals` stop existing — across
 * files no test touches. The `experimental` entrypoint omits that line. If a
 * release adds it, this fails naming the cause rather than scattering dozens of
 * Buffer errors through production source.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const TESTS = path.join(REPO, 'tests');
const CONFIG = path.join(REPO, 'tsconfig.tests.json');

/**
 * Trees whose suites exercise 1.4 surfaces the #1170 sweep retires: the daemon
 * and its jobs, the capture surface, the local vault schema and its queries,
 * Grove and Team-Host, Canopy, the 1.4 CLI verbs, and the Team-Sync worker.
 * They are outside the typecheck program until that sweep deletes them.
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
  exclude: string[];
}

const config = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')) as TestsConfig;

/** The `tests/`-relative entries the config subtracts, in the order it names them. */
const excluded = config.exclude
  .filter((entry) => entry === 'tests' || entry.startsWith('tests/'))
  .map((entry) => entry.slice('tests/'.length))
  .filter((entry) => entry.length > 0);

/** Every directory and loose `.ts` file directly under `tests/`. */
const entries = fs.readdirSync(TESTS, { withFileTypes: true });
const trees = entries.filter((e) => e.isDirectory()).map((e) => e.name);

describe('tests/ typecheck coverage', () => {
  test('the config includes the whole tree, so a new test tree is typechecked without an edit', () => {
    expect(config.include).toContain('tests/**/*.ts');
  });

  test('every excluded entry is accounted for, and nothing is in both lists', () => {
    const named = [...AWAITING_THE_1_4_SWEEP, ...TYPED_BY_THE_UI_CONFIGS];
    expect([...excluded].sort()).toEqual([...named].sort());
    const sweep = new Set<string>(AWAITING_THE_1_4_SWEEP);
    expect(TYPED_BY_THE_UI_CONFIGS.filter((name) => sweep.has(name))).toEqual([]);
  });

  test('every named entry still exists, so a deletion cannot leave a stale name behind', () => {
    const missing = [...AWAITING_THE_1_4_SWEEP, ...TYPED_BY_THE_UI_CONFIGS]
      .filter((name) => !fs.existsSync(path.join(TESTS, name)));
    expect(missing).toEqual([]);
  });

  test('every tree under tests/ is either typechecked or named, and a new one is typechecked', () => {
    const named = new Set<string>([...AWAITING_THE_1_4_SWEEP, ...TYPED_BY_THE_UI_CONFIGS]);
    const typechecked = trees.filter((tree) => !named.has(tree));
    // Named-but-absent is the previous test; this one is the other direction.
    expect(trees.filter((tree) => !named.has(tree) && !typechecked.includes(tree))).toEqual([]);
    // The program covers the 2.0 surfaces the Deployment is built on.
    for (const tree of ['myco-server', 'member', 'meta', 'parity', 'smoke', 'tools', 'symbionts', 'hooks']) {
      expect({ tree, typechecked: typechecked.includes(tree) }).toEqual({ tree, typechecked: true });
    }
  });

  test('the Cloudflare declarations the program loads declare no global Buffer', () => {
    const entry = config.compilerOptions.types.find((name) => name.startsWith('@cloudflare/workers-types'));
    expect(entry).toBe('@cloudflare/workers-types/experimental');
    const declarations = fs.readFileSync(path.join(REPO, 'node_modules', entry!, 'index.d.ts'), 'utf-8');
    const globalBuffer = declarations.split('\n').filter((line) => /^declare (const|var|let) Buffer\b/.test(line));
    expect(globalBuffer).toEqual([]);
  });
});
