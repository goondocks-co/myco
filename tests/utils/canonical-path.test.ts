import { expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalRootIdentity, type CanonicalRootIdentityDeps } from '@myco/utils/git-files.js';

const fakeFs = (deps: CanonicalRootIdentityDeps): CanonicalRootIdentityDeps => ({ ...deps, lstat: deps.lstat ?? deps.stat });

const absent = (): never => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
it('native realpath expands Windows 8.3 aliases and drive case before a case-insensitive identity probe', () => {
  const calls: string[] = [];
  const deps = {
    paths: path.win32 as typeof path,
    realpath: (p: string) => { calls.push(p); return 'C:\\Runner Long Name\\Repo'; },
    stat: () => ({ dev: 7, ino: 42 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('c:\\RUNNER~1\\Repo', fakeFs(deps))).toBe('c:\\runner long name\\repo');
  expect(canonicalRootIdentity('C:\\Runner Long Name\\Repo', fakeFs(deps))).toBe('c:\\runner long name\\repo');
  expect(calls).toEqual(['c:\\RUNNER~1\\Repo', 'C:\\Runner Long Name\\Repo']);
});
it('case-sensitive paths with different inode identities stay distinct on any platform', () => {
  const deps = {
    paths: path.posix as typeof path,
    realpath: (p: string) => p,
    stat: (p: string) => ({ dev: 7, ino: path.basename(p) === 'Repo' ? 1 : 2 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/volume/Repo', fakeFs(deps))).toBe('/volume/Repo');
  expect(canonicalRootIdentity('/volume/repo', fakeFs(deps))).toBe('/volume/repo');
  expect(canonicalRootIdentity('/volume/Repo', fakeFs(deps))).not.toBe(canonicalRootIdentity('/volume/repo', fakeFs(deps)));
});
it('case sensitivity is detected per path, never inferred from the host platform', () => {
  const deps = {
    paths: path.posix as typeof path,
    realpath: (p: string) => p,
    stat: (p: string) => p.startsWith('/sensitive/') && path.basename(p) !== 'Repo' ? absent() : ({ dev: p.startsWith('/sensitive/') ? 1 : 2, ino: 42 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/sensitive/Repo', fakeFs(deps))).toBe('/sensitive/Repo');
  expect(canonicalRootIdentity('/insensitive/Repo', fakeFs(deps))).toBe('/insensitive/repo');
});
it('case probes are cached while native realpath stays live for retargeted aliases', () => {
  let probes = 0;
  let target = '/volume/One';
  const deps = { paths: path.posix as typeof path, realpath: () => target, stat: () => { probes++; return { dev: 7, ino: 42 }; }, caseCache: new Map() };
  expect(canonicalRootIdentity('/alias', fakeFs(deps))).toBe('/volume/one');
  const first = probes;
  expect(canonicalRootIdentity('/alias', fakeFs(deps))).toBe('/volume/one');
  expect(probes).toBe(first + 2);
  target = '/volume/Two';
  expect(canonicalRootIdentity('/alias', fakeFs(deps))).toBe('/volume/two');
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
  expect(canonicalRootIdentity('/alias', fakeFs(deps))).toBe('/volume/repo');
  replacement = true;
  expect(canonicalRootIdentity('/alias', fakeFs(deps))).toBe('/volume/Repo');
});

it('missing descendants inherit the existing volume case rule without folding sensitive volumes', () => {
  for (const insensitive of [true, false]) {
    const deps = {
      paths: path.posix as typeof path,
      realpath: (p: string) => p === '/Volume' ? p : absent(),
      stat: (p: string) => ({ dev: 7, ino: insensitive || p === '/Volume' ? 42 : 43 }),
      caseCache: new Map(),
    };
    expect(canonicalRootIdentity('/Volume/Missing/Repo', fakeFs(deps))).toBe(insensitive ? '/volume/missing/repo' : '/Volume/Missing/Repo');
  }
});

it('a numeric directory does not inherit the containing filesystem case rule across a mount boundary', () => {
  const deps = {
    paths: path.posix as typeof path,
    realpath: (p: string) => p.endsWith('/FutureRepo') ? absent() : p,
    stat: (p: string) => ({ dev: p === '/Host' ? 1 : 2, ino: /\/123$/.test(p) ? 42 : 43 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/Host/Mount/123', fakeFs(deps))).toBe('/Host/Mount/123');
  expect(canonicalRootIdentity('/Host/Mount/123/FutureRepo', fakeFs(deps))).toBe('/Host/Mount/123/FutureRepo');
});

it('case probes refresh when the containing directory case rule changes', () => {
  let insensitive = true;
  const deps = {
    paths: path.posix as typeof path,
    realpath: () => '/volume/Repo',
    stat: (p: string) => ({ dev: 7, ino: p === '/volume' ? 1 : insensitive || p === '/volume/Repo' ? 42 : 43, ctimeMs: p === '/volume' && !insensitive ? 2 : 1 }),
    caseCache: new Map(),
  };
  expect(canonicalRootIdentity('/alias', fakeFs(deps))).toBe('/volume/repo');
  insensitive = false;
  expect(canonicalRootIdentity('/alias', fakeFs(deps))).toBe('/volume/Repo');
});

it('a case-flipped symlink sibling cannot merge repositories on a sensitive filesystem (injected filesystem)', () => {
  const deps = {
    paths: path.posix as typeof path, realpath: (p: string) => p, caseCache: new Map(),
    stat: (p: string) => ({ dev: 1, ino: p.startsWith('/Work') ? 10 : 20 }),
    lstat: (p: string) => ({ dev: 1, ino: p.endsWith('/Proj') ? 30 : p.startsWith('/Work') ? 10 : 20 }),
  };
  expect(canonicalRootIdentity('/Work/proj', fakeFs(deps))).toBe('/Work/proj');
  expect(canonicalRootIdentity('/work/proj', fakeFs(deps))).toBe('/work/proj');
});

it('case folding preserves case-sensitive ancestors above the probed mount point', () => {
  const deps = {
    paths: path.posix as typeof path, realpath: (p: string) => p, caseCache: new Map(),
    stat: (p: string) => ({ dev: p.split('/').length >= 3 ? 2 : 1, ino: 42 }),
    lstat: () => ({ dev: 2, ino: 42 }),
  };
  expect(canonicalRootIdentity('/Host/Mount/Repo', fakeFs(deps))).toBe('/Host/Mount/repo');
});

it('the production probe requests lossless bigint identities for stat and lstat', () => {
  const stat = spyOn(fs, 'statSync').mockImplementation(((_at: fs.PathLike, options: unknown) => {
    expect(options).toEqual({ bigint: true });
    return { dev: 1n, ino: 9007199254740992n };
  }) as typeof fs.statSync);
  const lstat = spyOn(fs, 'lstatSync').mockImplementation(((_at: fs.PathLike, options: unknown) => {
    expect(options).toEqual({ bigint: true });
    return { dev: 1n, ino: 9007199254740993n };
  }) as typeof fs.lstatSync);
  try {
    expect(canonicalRootIdentity('/Volume/Repo', { realpath: at => at, caseCache: new Map() })).toBe('/Volume/Repo');
  } finally { stat.mockRestore(); lstat.mockRestore(); }
});

const caseVolume = process.env.MYCO_TEST_CASE_VOLUME;
it.skipIf(!caseVolume)('case-flipped symlink siblings stay distinct on a case-sensitive image (host must provide a mounted test volume)', () => {
  const base = fs.mkdtempSync(path.join(caseVolume!, 'case-probe-'));
  try {
    for (const name of ['Work', 'work']) {
      fs.mkdirSync(path.join(base, name, 'proj'), { recursive: true });
      fs.symlinkSync('proj', path.join(base, name, 'Proj'), 'dir');
    }
    const upper = path.join(base, 'Work', 'proj');
    const lower = path.join(base, 'work', 'proj');
    expect(fs.statSync(upper, { bigint: true }).ino).not.toBe(fs.statSync(lower, { bigint: true }).ino);
    expect(canonicalRootIdentity(upper)).not.toBe(canonicalRootIdentity(lower));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

it('a remount with a new insensitive volume replaces the cached fold boundary', () => {
  let mounted = false;
  const deps = {
    paths: path.posix as typeof path, realpath: (p: string) => p, caseCache: new Map(),
    stat: (p: string) => ({ dev: mounted && p.startsWith('/Host/Mount') ? 2 : 1, ino: 42 }),
    lstat: () => ({ dev: mounted ? 2 : 1, ino: 42 }),
  };
  expect(canonicalRootIdentity('/Host/Mount/Repo', deps)).toBe('/host/mount/repo');
  mounted = true;
  expect(canonicalRootIdentity('/Host/Mount/Repo', deps)).toBe('/Host/Mount/repo');
});
