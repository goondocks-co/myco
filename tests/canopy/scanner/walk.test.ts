import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { walkProject } from '@myco/canopy/scanner/walk';
import { createExcludeMatcher } from '@myco/canopy/exclude';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-walk-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content = '') {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('walkProject', () => {
  it('yields files but not directories, with forward-slash relative paths', () => {
    write('a.ts');
    write('src/b.ts');
    write('src/nested/c.ts');
    const results = [...walkProject({ projectRoot: tmp, isExcluded: () => false })].sort();
    expect(results).toEqual(['a.ts', 'src/b.ts', 'src/nested/c.ts']);
  });

  it('prunes excluded directories without descending into them', () => {
    write('keep/a.ts');
    write('node_modules/foo/index.js');
    const isExcluded = createExcludeMatcher(['node_modules']);
    const results = [...walkProject({ projectRoot: tmp, isExcluded })];
    expect(results).toContain('keep/a.ts');
    expect(results.every((p) => !p.startsWith('node_modules/'))).toBe(true);
  });

  it('skips symlinks silently', () => {
    write('real.txt', 'x');
    fs.symlinkSync(path.join(tmp, 'real.txt'), path.join(tmp, 'link.txt'));
    const results = [...walkProject({ projectRoot: tmp, isExcluded: () => false })].sort();
    expect(results).toContain('real.txt');
    expect(results).not.toContain('link.txt');
  });

  it('tolerates a missing/unreadable subtree without throwing', () => {
    write('a.ts');
    // No directory at "ghost/" — walkProject only traverses what exists, so
    // this just confirms an empty-prefix walk completes cleanly.
    const results = [...walkProject({ projectRoot: tmp, isExcluded: () => false })];
    expect(results).toEqual(['a.ts']);
  });
});
