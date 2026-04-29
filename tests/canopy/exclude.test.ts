import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createExcludeMatcher,
  isExcluded,
  createLayeredExcludeMatcher,
} from '@myco/canopy/exclude';

// Pattern list used to exercise the legacy single-layer matcher. Pinned
// here (not sourced from the schema) because the schema default list is
// now intentionally empty — the gitignore + managed layers do that work.
const SAMPLE_USER_PATTERNS = [
  'node_modules', '.git', 'dist', 'build', '.next', '.turbo',
  '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
];

describe('isExcluded (single-layer user patterns)', () => {
  it('excludes node_modules at any depth', () => {
    expect(isExcluded('node_modules/foo/index.js', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('packages/a/node_modules/foo/index.js', SAMPLE_USER_PATTERNS)).toBe(true);
  });

  it('excludes .git and build output dirs', () => {
    expect(isExcluded('.git/HEAD', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('dist/app.js', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('build/index.html', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('.next/cache/foo', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('.turbo/daemon.log', SAMPLE_USER_PATTERNS)).toBe(true);
  });

  it('excludes lockfiles by basename at any depth', () => {
    expect(isExcluded('package-lock.json', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('packages/a/package-lock.json', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('yarn.lock', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('apps/web/pnpm-lock.yaml', SAMPLE_USER_PATTERNS)).toBe(true);
    expect(isExcluded('vendor/foo.lock', SAMPLE_USER_PATTERNS)).toBe(true);
  });

  it('allows normal source files', () => {
    expect(isExcluded('src/index.ts', SAMPLE_USER_PATTERNS)).toBe(false);
    expect(isExcluded('packages/myco/src/db/schema.ts', SAMPLE_USER_PATTERNS)).toBe(false);
    expect(isExcluded('README.md', SAMPLE_USER_PATTERNS)).toBe(false);
    expect(isExcluded('docs/design.md', SAMPLE_USER_PATTERNS)).toBe(false);
  });

  it('does NOT mistake segment substrings for matches', () => {
    expect(isExcluded('node_modules_legacy/foo.js', SAMPLE_USER_PATTERNS)).toBe(false);
    expect(isExcluded('src/rebuild.ts', SAMPLE_USER_PATTERNS)).toBe(false);
  });

  it('normalizes backslash paths (windows-ish)', () => {
    expect(isExcluded('packages\\a\\node_modules\\foo.js', SAMPLE_USER_PATTERNS)).toBe(true);
  });

  it('returns false for empty pattern list', () => {
    expect(isExcluded('node_modules/foo.js', [])).toBe(false);
  });
});

describe('createExcludeMatcher', () => {
  it('reuses compiled patterns across calls and matches each shape correctly', () => {
    const matcher = createExcludeMatcher(SAMPLE_USER_PATTERNS);
    expect(matcher('node_modules/foo/index.js')).toBe(true);    // segment
    expect(matcher('packages/a/package-lock.json')).toBe(true); // basename-literal
    expect(matcher('vendor/foo.lock')).toBe(true);              // basename-glob
    expect(matcher('src/index.ts')).toBe(false);
  });
});

describe('createLayeredExcludeMatcher', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-exclude-layered-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('excludes paths matched by .gitignore', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules\ndist\n');
    const m = createLayeredExcludeMatcher({ projectRoot: tmp, defaultPatterns: [], userPatterns: [] });
    expect(m('node_modules/foo.js')).toBe(true);
    expect(m('dist/app.js')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('excludes Myco-managed segments without needing .gitignore entries', () => {
    // No .gitignore; the managed layer alone should ban these.
    const m = createLayeredExcludeMatcher({ projectRoot: tmp, defaultPatterns: [], userPatterns: [] });
    expect(m('.myco/myco.db')).toBe(true);
    expect(m('.agents/skills/foo/SKILL.md')).toBe(true);
    expect(m('.claude/settings.json')).toBe(true);
    expect(m('packages/a/.cursor/rules.json')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('excludes paths matched by user-custom patterns', () => {
    const m = createLayeredExcludeMatcher({
      projectRoot: tmp,
      defaultPatterns: [],
      userPatterns: ['secret-stuff'],
    });
    expect(m('secret-stuff/file.ts')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('excludes paths matched by Myco-baseline default_patterns', () => {
    // No .gitignore, no user patterns — only the Myco-maintained baseline
    // should ban these. This is the regression guard for the screenshot
    // bug: `.git/` was leaking because nothing claimed authority over it.
    const m = createLayeredExcludeMatcher({
      projectRoot: tmp,
      defaultPatterns: ['.git', 'node_modules', '__pycache__', '.venv'],
      userPatterns: [],
    });
    expect(m('.git/HEAD')).toBe(true);
    expect(m('.git/objects/ab/cdef')).toBe(true);
    expect(m('.venv/bin/python')).toBe(true);
    expect(m('apps/api/src/__pycache__/foo.pyc')).toBe(true);
    expect(m('packages/a/node_modules/foo/index.js')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('excludes common secret-bearing files even without gitignore entries', () => {
    const m = createLayeredExcludeMatcher({ projectRoot: tmp, defaultPatterns: [], userPatterns: [] });
    expect(m('.env')).toBe(true);
    expect(m('.env.local')).toBe(true);
    expect(m('src/private.key')).toBe(true);
    expect(m('certs/client.p12')).toBe(true);
    expect(m('src/index.ts')).toBe(false);
  });

  it('honors gitignore negation within the gitignore layer only', () => {
    // gitignore: `build` excluded except `build/keep.txt`.
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'build\n!build/keep.txt\n');
    const m = createLayeredExcludeMatcher({ projectRoot: tmp, defaultPatterns: [], userPatterns: [] });
    expect(m('build/other.txt')).toBe(true);
    expect(m('build/keep.txt')).toBe(false);
  });

  it('user-pattern bans cannot be un-excluded by gitignore negation', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '!build/keep.txt\n');
    const m = createLayeredExcludeMatcher({
      projectRoot: tmp,
      defaultPatterns: [],
      userPatterns: ['build'],
    });
    // The user listed `build` — gitignore negation in another layer does
    // not override that.
    expect(m('build/keep.txt')).toBe(true);
  });

  it('passes through normal source files', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'node_modules\n');
    const m = createLayeredExcludeMatcher({ projectRoot: tmp, defaultPatterns: [], userPatterns: [] });
    expect(m('src/index.ts')).toBe(false);
    expect(m('packages/myco/src/db/schema.ts')).toBe(false);
    expect(m('README.md')).toBe(false);
  });

  it('respects directory-only gitignore rules via isDir flag', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'logs/\n');
    const m = createLayeredExcludeMatcher({ projectRoot: tmp, defaultPatterns: [], userPatterns: [] });
    // A file literally named `logs` should NOT be excluded by a dir-only rule.
    expect(m('logs', false)).toBe(false);
    // Directory `logs` is excluded.
    expect(m('logs', true)).toBe(true);
    // Files under logs are excluded transitively.
    expect(m('logs/foo.txt', false)).toBe(true);
  });
});
