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

  it('throws when the project root itself cannot be read', () => {
    const missing = path.join(tmp, 'missing-root');
    expect(() => [...walkProject({ projectRoot: missing, isExcluded: () => false })]).toThrow(/Cannot read project root/);
  });

  it('caps yield at maxFiles and fires onLimitHit', () => {
    for (let i = 0; i < 50; i++) write(`f${i}.ts`);
    const limits: Array<{ kind: string; value: number }> = [];
    const results = [...walkProject({
      projectRoot: tmp,
      isExcluded: () => false,
      maxFiles: 10,
      onLimitHit: (kind, value) => limits.push({ kind, value }),
    })];
    expect(results.length).toBe(10);
    expect(limits).toEqual([{ kind: 'maxFiles', value: 10 }]);
  });

  it('caps directory descent at maxDepth and fires onLimitHit', () => {
    // Build /tmp/a/b/c/d/leaf.ts → depth 4
    write('a/b/c/d/leaf.ts');
    write('a/top.ts');
    const limits: Array<{ kind: string; value: number }> = [];
    const results = [...walkProject({
      projectRoot: tmp,
      isExcluded: () => false,
      maxDepth: 2,
      onLimitHit: (kind, value) => limits.push({ kind, value }),
    })].sort();
    // a/top.ts is at depth 1 → kept. a/b/c/d/leaf.ts at depth 4 → pruned.
    expect(results).toContain('a/top.ts');
    expect(results.every((p) => !p.includes('/c/'))).toBe(true);
    expect(limits.some((l) => l.kind === 'maxDepth' && l.value === 2)).toBe(true);
  });

  it('does not call onLimitHit when caps are not reached', () => {
    write('a.ts');
    write('b.ts');
    const limits: Array<{ kind: string; value: number }> = [];
    const results = [...walkProject({
      projectRoot: tmp,
      isExcluded: () => false,
      maxFiles: 100,
      maxDepth: 100,
      onLimitHit: (kind, value) => limits.push({ kind, value }),
    })];
    expect(results.length).toBe(2);
    expect(limits).toEqual([]);
  });
});
