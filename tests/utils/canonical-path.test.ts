import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalRootIdentity } from '@myco/utils/git-files.js';

const absent = (): never => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
it('native realpath expands Windows 8.3 aliases and drive case before a case-insensitive identity probe', () => {
  const calls: string[] = [];
  const deps = {
    paths: path.win32 as typeof path,
    realpath: (p: string) => { calls.push(p); return 'C:\\Runner Long Name\\Repo'; },
    stat: () => ({ dev: 7, ino: 42 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('c:\\RUNNER~1\\Repo', deps)).toBe('c:\\runner long name\\repo');
  expect(canonicalRootIdentity('C:\\Runner Long Name\\Repo', deps)).toBe('c:\\runner long name\\repo');
  expect(calls).toEqual(['c:\\RUNNER~1\\Repo', 'C:\\Runner Long Name\\Repo']);
});
it('case-sensitive paths with different inode identities stay distinct on any platform', () => {
  const deps = {
    paths: path.posix as typeof path,
    realpath: (p: string) => p,
    stat: (p: string) => ({ dev: 7, ino: path.basename(p) === 'Repo' ? 1 : 2 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/volume/Repo', deps)).toBe('/volume/Repo');
  expect(canonicalRootIdentity('/volume/repo', deps)).toBe('/volume/repo');
  expect(canonicalRootIdentity('/volume/Repo', deps)).not.toBe(canonicalRootIdentity('/volume/repo', deps));
});
it('case sensitivity is detected per path, never inferred from the host platform', () => {
  const deps = {
    paths: path.posix as typeof path,
    realpath: (p: string) => p,
    stat: (p: string) => p.startsWith('/sensitive/') && path.basename(p) !== 'Repo' ? absent() : ({ dev: p.startsWith('/sensitive/') ? 1 : 2, ino: 42 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/sensitive/Repo', deps)).toBe('/sensitive/Repo');
  expect(canonicalRootIdentity('/insensitive/Repo', deps)).toBe('/insensitive/repo');
});
it('case probes are cached while native realpath stays live for retargeted aliases', () => {
  let probes = 0;
  let target = '/volume/One';
  const deps = { paths: path.posix as typeof path, realpath: () => target, stat: () => { probes++; return { dev: 7, ino: 42 }; }, caseCache: new Map() };
  expect(canonicalRootIdentity('/alias', deps)).toBe('/volume/one');
  const first = probes;
  expect(canonicalRootIdentity('/alias', deps)).toBe('/volume/one');
  expect(probes).toBe(first + 2);
  target = '/volume/Two';
  expect(canonicalRootIdentity('/alias', deps)).toBe('/volume/two');
});
it('native realpath is the default alias expansion boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-canonical-'));
  try {
    const alias = path.join(root, 'alias');
    const actual = path.join(root, 'Actual');
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, 'junction');
    expect(canonicalRootIdentity(alias)).toBe(canonicalRootIdentity(fs.realpathSync.native(actual)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('case probes refresh when the same physical name changes volume or directory identity', () => {
  let replacement = false;
  const deps = {
    paths: path.posix as typeof path, realpath: () => '/volume/Repo',
    stat: (p: string) => ({ dev: replacement ? 2 : 1, ino: replacement && p !== '/volume/Repo' ? 43 : 42 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/alias', deps)).toBe('/volume/repo');
  replacement = true;
  expect(canonicalRootIdentity('/alias', deps)).toBe('/volume/Repo');
});

it('missing descendants inherit the existing volume case rule without folding sensitive volumes', () => {
  for (const insensitive of [true, false]) {
    const deps = {
      paths: path.posix as typeof path,
      realpath: (p: string) => p === '/Volume' ? p : absent(),
      stat: (p: string) => ({ dev: 7, ino: insensitive || p === '/Volume' ? 42 : 43 }),
      caseCache: new Map(),
    };
    expect(canonicalRootIdentity('/Volume/Missing/Repo', deps)).toBe(insensitive ? '/volume/missing/repo' : '/Volume/Missing/Repo');
  }
});

it('a numeric directory does not inherit the containing filesystem case rule across a mount boundary', () => {
  const deps = {
    paths: path.posix as typeof path,
    realpath: (p: string) => p,
    stat: (p: string) => ({ dev: p === '/Host' ? 1 : 2, ino: /\/123$/.test(p) ? 42 : 43 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/Host/Mount/123', deps)).toBe('/Host/Mount/123');
});

it('case probes refresh when the containing directory case rule changes', () => {
  let insensitive = true;
  const deps = {
    paths: path.posix as typeof path,
    realpath: () => '/volume/Repo',
    stat: (p: string) => ({ dev: 7, ino: p === '/volume' ? 1 : insensitive || p === '/volume/Repo' ? 42 : 43, ctimeMs: p === '/volume' && !insensitive ? 2 : 1 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/alias', deps)).toBe('/volume/repo');
  insensitive = false;
  expect(canonicalRootIdentity('/alias', deps)).toBe('/volume/Repo');
});
