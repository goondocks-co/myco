import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSymlink, type SymlinkIo } from '../../packages/myco/src/symbionts/install-helpers';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-symlink-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/**
 * Simulate a Windows box without symlink privilege: dir/file symlinks throw
 * EPERM, but junctions (no privilege required) succeed. On the POSIX CI host a
 * 'junction' degrades to an ordinary symlink (Node ignores the type off-Windows),
 * which is exactly what we want — it lets us exercise the fallback code path and
 * its idempotency without a real Windows runner.
 */
function symlinkBlockedIo(): SymlinkIo {
  return {
    symlinkSync: ((target: string, linkPath: string, type?: fs.symlink.Type) => {
      if (type === 'junction') return fs.symlinkSync(target, linkPath, 'junction');
      const err: NodeJS.ErrnoException = new Error('operation not permitted, symlink');
      err.code = 'EPERM';
      throw err;
    }) as typeof fs.symlinkSync,
    copyFileSync: fs.copyFileSync,
  };
}

describe('ensureSymlink — POSIX baseline (unchanged behavior)', () => {
  test('links a dir target, then reports unchanged on the next tick', () => {
    const target = path.join(tmp, 'src'); fs.mkdirSync(target);
    const link = path.join(tmp, 'link');
    expect(ensureSymlink(link, target)).toBe('linked');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(ensureSymlink(link, target)).toBe('unchanged');
  });

  test('a REAL directory at the link path is never destroyed', () => {
    const target = path.join(tmp, 'src'); fs.mkdirSync(target);
    const link = path.join(tmp, 'link'); fs.mkdirSync(link);
    fs.writeFileSync(path.join(link, 'user.txt'), 'mine');
    expect(ensureSymlink(link, target)).toBe('kept-real-path');
    expect(fs.readFileSync(path.join(link, 'user.txt'), 'utf-8')).toBe('mine');
  });
});

describe('ensureSymlink — Windows fallback (symlink EPERM)', () => {
  test('dir target falls back to a junction and stays idempotent (absolute target)', () => {
    const target = path.join(tmp, 'src'); fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'SKILL.md'), 'content');
    const link = path.join(tmp, 'link');
    const io = symlinkBlockedIo();

    expect(ensureSymlink(link, target, io)).toBe('linked');
    // The fallback link reads through to the target's contents.
    expect(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf-8')).toBe('content');
    // Hourly tick must NOT re-link or flag the junction as a real path.
    expect(ensureSymlink(link, target, io)).toBe('unchanged');
  });

  test('dir target falls back to a junction and stays idempotent (relative target)', () => {
    // Real consumers pass a target relative to the link's own directory.
    const target = path.join(tmp, 'canonical'); fs.mkdirSync(target);
    const linkDir = path.join(tmp, 'agent'); fs.mkdirSync(linkDir);
    const link = path.join(linkDir, 'myco');
    const relTarget = path.relative(linkDir, target);
    const io = symlinkBlockedIo();

    expect(ensureSymlink(link, relTarget, io)).toBe('linked');
    // The junction stored an absolute target, but the same relative call must
    // still resolve to "unchanged" (idempotency survives the abs/rel mismatch).
    expect(ensureSymlink(link, relTarget, io)).toBe('unchanged');
  });

  test('file target falls back to a real copy and stays idempotent', () => {
    const target = path.join(tmp, 'src.txt'); fs.writeFileSync(target, 'hello');
    const link = path.join(tmp, 'link.txt');
    const io = symlinkBlockedIo();

    expect(ensureSymlink(link, target, io)).toBe('linked');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false); // a real copy, not a link
    expect(fs.readFileSync(link, 'utf-8')).toBe('hello');
    expect(ensureSymlink(link, target, io)).toBe('unchanged');
  });

  test('a user file that differs from the source is kept, never overwritten by the copy fallback', () => {
    const target = path.join(tmp, 'src.txt'); fs.writeFileSync(target, 'source');
    const link = path.join(tmp, 'link.txt'); fs.writeFileSync(link, 'USER EDIT');
    const io = symlinkBlockedIo();

    expect(ensureSymlink(link, target, io)).toBe('kept-real-path');
    expect(fs.readFileSync(link, 'utf-8')).toBe('USER EDIT');
  });

  test('a REAL directory still wins over a dir target even when symlink is blocked', () => {
    const target = path.join(tmp, 'src'); fs.mkdirSync(target);
    const link = path.join(tmp, 'link'); fs.mkdirSync(link);
    fs.writeFileSync(path.join(link, 'user.txt'), 'mine');
    const io = symlinkBlockedIo();
    expect(ensureSymlink(link, target, io)).toBe('kept-real-path');
    expect(fs.readFileSync(path.join(link, 'user.txt'), 'utf-8')).toBe('mine');
  });
});
