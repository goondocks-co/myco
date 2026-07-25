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
