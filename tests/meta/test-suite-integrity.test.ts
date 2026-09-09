/**
 * Meta gate: the test suite runs everything it contains, and nothing narrows it.
 *
 * `scripts/run-bun-tests.mjs` discovers tests by walking `tests/` and nothing
 * else, so a `*.test.ts` authored anywhere under `packages/` or `scripts/` is
 * silently never executed — it typechecks, it looks like coverage in review, and
 * it never runs in CI. Two such files shipped with the Team Host residency work
 * and sat dead until an audit found them.
 *
 * A focused `.only` has the same shape: one character reduces a whole file to a
 * single test and the suite still reports green.
 *
 * Static source scan (node:fs), no daemon boot — same shape as
 * `tests/meta/route-stamp-completeness.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Generated, vendored, or build-output trees that never hold authored tests. */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  '.git',
  'coverage',
  'vendor-src',
]);

/** Trees scanned for stranded test files. `tests/` is the discovered root. */
const SCANNED_ROOTS = ['packages', 'scripts'] as const;

const TEST_FILE_PATTERN = /\.test\.tsx?$/;

/**
 * The names bun collects. A suite under `tests/` named anything else is not a
 * suite at all: `bun test <path>` answers that the filter matched no test
 * files, `npm test -- <path>` exits having run nothing, and the only signal is
 * an absence — which is why the NAME is what is gated.
 */
const COLLECTED_NAME = /(?:\.|_)(?:test|spec)\.tsx?$/;

/** What a file brings in from `bun:test`; only these names declare a suite. */
const SUITE_IMPORT = /import\s*\{([^}]*)\}\s*from\s*'bun:test'/;

/** A suite declaration, token-anchored so `target.it(` or `latest(` does not count. */
const DECLARES_SUITE = /(?:^|[^.\w])(?:describe|it|test)\s*(?:\.\w+)?\s*\(/;

/** Source with its comments dropped: a suite drawn in a doc comment is documentation. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/**
 * `it.only` / `test.only` / `describe.only`, token-anchored so `monotonic.only`
 * or a `.only` inside a string does not trip the gate.
 */
const ONLY_PATTERN = /(?:^|[^.\w])(?:it|test|describe)\.only\s*\(/;

function listFiles(dir: string, match: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      out.push(...listFiles(path.join(dir, entry.name), match));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!match(entry.name)) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

function repoRelative(absolute: string): string {
  return path.relative(REPO_ROOT, absolute);
}

describe('meta: test suite integrity', () => {
  it('has no test files outside tests/, where the runner cannot discover them', () => {
    const stranded = SCANNED_ROOTS.flatMap((root) =>
      listFiles(path.join(REPO_ROOT, root), (name) => TEST_FILE_PATTERN.test(name)),
    ).map(repoRelative).sort();

    expect(stranded).toEqual([]);
  });

  it('has no suite under tests/ whose name bun never collects', () => {
    const unrunnable = listFiles(path.join(REPO_ROOT, 'tests'), (name) => /\.tsx?$/.test(name))
      .filter((file) => {
        if (COLLECTED_NAME.test(path.basename(file))) return false;
        const source = fs.readFileSync(file, 'utf-8');
        const imported = SUITE_IMPORT.exec(source)?.[1] ?? '';
        if (!/\b(?:describe|it|test)\b/.test(imported)) return false;
        return DECLARES_SUITE.test(withoutComments(source));
      })
      .map(repoRelative)
      .sort();

    expect(unrunnable).toEqual([]);
  });

  it('has no focused tests narrowing a file to a subset', () => {
    const focused = listFiles(
      path.join(REPO_ROOT, 'tests'),
      (name) => TEST_FILE_PATTERN.test(name),
    )
      .filter((file) => ONLY_PATTERN.test(fs.readFileSync(file, 'utf-8')))
      .map(repoRelative)
      .sort();

    expect(focused).toEqual([]);
  });
});
