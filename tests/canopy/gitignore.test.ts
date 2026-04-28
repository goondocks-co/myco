import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createGitignoreMatcher, loadProjectGitignoreMatcher } from '@myco/canopy/gitignore';

describe('createGitignoreMatcher', () => {
  it('ignores blank lines and comments', () => {
    const m = createGitignoreMatcher('\n# a comment\nnode_modules\n\n');
    expect(m('node_modules/foo.js', false)).toBe(true);
    expect(m('src/index.ts', false)).toBe(false);
  });

  it('matches a bare segment at any depth', () => {
    const m = createGitignoreMatcher('node_modules\n');
    expect(m('node_modules/foo.js', false)).toBe(true);
    expect(m('packages/a/node_modules/foo.js', false)).toBe(true);
    expect(m('node_modules', true)).toBe(true);
  });

  it('honors leading-slash anchors (root-only)', () => {
    const m = createGitignoreMatcher('/build\n');
    expect(m('build/x.js', false)).toBe(true);
    // anchored: the pattern targets the project root; `pkg/build/...` should NOT match.
    expect(m('pkg/build/x.js', false)).toBe(false);
  });

  it('honors trailing-slash directory-only patterns', () => {
    const m = createGitignoreMatcher('logs/\n');
    expect(m('logs', true)).toBe(true);
    expect(m('a/logs', true)).toBe(true);
    // A *file* called `logs` must NOT be excluded by a dir-only rule.
    expect(m('logs', false)).toBe(false);
  });

  it('supports * within a single segment', () => {
    const m = createGitignoreMatcher('*.log\n');
    expect(m('foo.log', false)).toBe(true);
    expect(m('a/b/foo.log', false)).toBe(true);
    expect(m('foo.txt', false)).toBe(false);
  });

  it('supports ** for any depth', () => {
    const m = createGitignoreMatcher('docs/**/draft.md\n');
    expect(m('docs/draft.md', false)).toBe(true);
    expect(m('docs/a/b/draft.md', false)).toBe(true);
    expect(m('elsewhere/draft.md', false)).toBe(false);
  });

  it('supports ? for single character', () => {
    const m = createGitignoreMatcher('file?.txt\n');
    expect(m('file1.txt', false)).toBe(true);
    expect(m('fileAB.txt', false)).toBe(false);
  });

  it('supports negation to re-include', () => {
    const m = createGitignoreMatcher('build\n!build/keep.txt\n');
    // The negation rule has a slash → anchored. `build/keep.txt` re-includes.
    expect(m('build/keep.txt', false)).toBe(false);
    expect(m('build/other.txt', false)).toBe(true);
  });

  it('treats patterns containing a slash (no leading) as anchored', () => {
    const m = createGitignoreMatcher('docs/draft\n');
    expect(m('docs/draft', false)).toBe(true);
    expect(m('a/docs/draft', false)).toBe(false);
  });

  it('does not treat segment substrings as matches', () => {
    const m = createGitignoreMatcher('build\n');
    expect(m('src/rebuild.ts', false)).toBe(false);
    expect(m('rebuild', false)).toBe(false);
  });
});

describe('loadProjectGitignoreMatcher', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-gi-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads .gitignore from the project root', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), 'dist\n');
    const m = loadProjectGitignoreMatcher(tmp);
    expect(m('dist/app.js', false)).toBe(true);
    expect(m('src/index.ts', false)).toBe(false);
  });

  it('returns a no-op matcher when .gitignore is absent', () => {
    const m = loadProjectGitignoreMatcher(tmp);
    expect(m('node_modules/foo.js', false)).toBe(false);
    expect(m('anything', false)).toBe(false);
  });
});
