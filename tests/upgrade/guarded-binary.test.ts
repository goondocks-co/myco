import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateBinary, BINARY_UPDATE_WAIT_MS, type BinaryUpdateDeps } from '@myco/upgrade/guarded-binary.js';
import { hasAdoptFailed, markAdoptFailed } from '@myco/upgrade/adopt-failed.js';
import { pruneVersions } from '@myco/upgrade/apply-binary.js';
import * as binaryPrimitives from '@myco/upgrade/apply-binary.js';
import { placeExecutable } from '@myco/install/place-binary.js';
import { writeInstallMarker, versionDir } from '@myco/install/managed-binary.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
import { bindSandboxChildHome, sandboxChildEnv } from '../../scripts/test-environment.mjs';

const from = '2.0.0-alpha.2';
const to = '2.0.0-alpha.3';
let root: string;
let home: string;
let live: string;
let stage: string;
let restore: () => void;
let deps: BinaryUpdateDeps;
let stages: number;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-guarded-update-'));
  restore = bindSandboxChildHome(root);
  home = path.join(root, '.myco');
  live = path.join(home, 'bin', process.platform === 'win32' ? 'myco.exe' : 'myco');
  stage = path.join(root, 'release');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.mkdirSync(stage);
  fs.writeFileSync(live, from, { mode: 0o755 });
  writeInstallMarker(home, { bin: live, source: 'curl', channel: 'alpha' });
  fs.writeFileSync(path.join(stage, 'myco'), to);
  fs.writeFileSync(path.join(stage, 'myco.exe'), to);
  stages = 0;
  deps = {
    home, cwd: root, localAppData: path.join(root, 'localappdata'), currentVersion: from, mycoBinary: live,
    resolveRefs: async () => ({ targetVersion: to, assetName: 'fixture', assetUrl: 'fixture', sha256sumsUrl: 'fixture' }),
    stageBinary: async () => { stages++; return { version: to, versionDir: stage }; },
    placeBinary: (source, dest, options) => placeExecutable(source, dest, { ...options, ready: () => ({ runs: true }) }),
    probeVersion: file => fs.readFileSync(file, 'utf8'),
  };
});
afterEach(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });

it('exports no unguarded member adoption or copy-back operation', () => {
  expect(binaryPrimitives).not.toHaveProperty('adoptStaged');
  expect(binaryPrimitives).not.toHaveProperty('restoreVersion');
});

for (const installed of [false, true]) for (const version of ['0.0.0-dev', '0.0.0-dev+fixture', '0.0.0']) it(`skips ${installed ? 'installed' : 'running'} development build ${version} before resolving releases`, async () => {
  if (installed) fs.writeFileSync(live, version); else deps.currentVersion = version;
  deps.resolveRefs = async () => { throw new Error('development build resolved releases'); };
  expect(await updateBinary('manual', {}, deps)).toEqual({ kind: 'skipped', reason: 'development build' });
  expect(stages).toBe(0);
  expect(fs.readFileSync(live, 'utf8')).toBe(installed ? version : from);
});

it('explicit skip keeps the binary and never resolves a release', async () => {
  deps.resolveRefs = async () => { throw new Error('explicit skip resolved releases'); };
  expect(await updateBinary('manual', { skipBinary: true }, deps)).toEqual({ kind: 'skipped', reason: '--skip-binary requested' });
  expect(stages).toBe(0);
});

it('skips a different project pin before resolving releases, while allowing a pin to this binary', async () => {
  fs.mkdirSync(path.join(root, '.myco'), { recursive: true });
  const pin = path.join(root, '.myco', 'runtime.command');
  fs.writeFileSync(pin, path.join(root, 'other-myco'), { mode: 0o600 });
  expect(await updateBinary('manual', {}, deps)).toEqual({ kind: 'skipped', reason: `runtime pin selects another binary: ${path.join(root, 'other-myco')}` });
  expect(stages).toBe(0);
  fs.writeFileSync(pin, live);
  expect((await updateBinary('manual', {}, deps)).kind).toBe('adopted');
});

it('skips a different machine pin', async () => {
  deps.cwd = stage;
  fs.writeFileSync(path.join(home, 'runtime.command'), path.join(root, 'other'), { mode: 0o600 });
  expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'skipped', reason: expect.stringContaining('runtime pin') });
  expect(stages).toBe(0);
});

it('denylists failed versions independently of version slots', async () => {
  for (const version of ['1.9.9', from, to, '2.1.0-alpha.1']) fs.mkdirSync(versionDir(home, process.platform, version, deps.localAppData), { recursive: true });
  markAdoptFailed(home, process.platform, to, deps.localAppData);
  pruneVersions(home, process.platform, 2, from, '1.9.9', deps.localAppData);
  expect(fs.existsSync(versionDir(home, process.platform, to, deps.localAppData))).toBe(false);
  expect(await updateBinary('manual', {}, deps)).toEqual({ kind: 'skipped', reason: `version ${to} failed an earlier update; retry with myco update ${to}` });
  expect(stages).toBe(0);
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
});

it('honors failed markers written by an earlier binary', async () => {
  const slot = versionDir(home, process.platform, to, deps.localAppData);
  fs.mkdirSync(slot, { recursive: true });
  fs.writeFileSync(path.join(slot, '.adopt-failed'), 'failed');
  expect((await updateBinary('manual', {}, deps)).kind).toBe('skipped');
  expect(stages).toBe(0);
});

it('denylists a verified download that cannot run during staging', async () => {
  delete deps.stageBinary;
  deps.stageDeps = {
    download: async (url, file) => { fs.writeFileSync(file, url === 'fixture' ? 'fixture' : ''); },
    computeSha256: async () => 'a'.repeat(64),
    ready: () => ({ runs: false, detail: 'killed on launch' }),
  };
  deps.resolveRefs = async () => ({ targetVersion: to, assetName: 'fixture', assetUrl: 'binary', sha256sumsUrl: 'sums' });
  deps.stageDeps.download = async (url, file) => { fs.writeFileSync(file, url === 'sums' ? `${'a'.repeat(64)}  fixture\n` : 'fixture'); };
  expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('killed on launch') });
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
  expect(hasAdoptFailed(home, process.platform, to, deps.localAppData)).toBe(true);
});

it('automatically updates only the default home, but admits a manual update in a custom home', async () => {
  expect((await updateBinary('automatic', {}, deps)).kind).toBe('adopted');
  fs.writeFileSync(live, from);
  deps.home = path.join(root, 'custom-home');
  writeInstallMarker(deps.home, { bin: live, source: 'curl', channel: 'alpha' });
  expect(await updateBinary('automatic', {}, deps)).toEqual({ kind: 'skipped', reason: 'this is not the default Myco home' });
  expect(stages).toBe(1);
  expect((await updateBinary('manual', {}, deps)).kind).toBe('adopted');
  expect(stages).toBe(2);
});

for (const failure of ['throws', 'wrong version']) it(`never replaces the live bytes when the staged version check ${failure}`, async () => {
  deps.probeVersion = file => {
    if (file === live) return from;
    if (failure === 'throws') throw new Error('version probe timed out');
    return '2.0.0-alpha.4';
  };
  expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'failed', reason: expect.stringContaining(failure === 'throws' ? 'timed out' : 'expected') });
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
  expect(hasAdoptFailed(home, process.platform, to, deps.localAppData)).toBe(true);
  expect(fs.existsSync(path.join(path.dirname(live), process.platform === 'win32' ? 'myco.prev.exe' : 'myco.prev'))).toBe(false);
});

for (const platform of ['linux', 'win32'] as const) it(`restores the previous bytes after a failed post-check on ${platform}`, async () => {
  deps.platform = platform;
  deps.probeVersion = file => {
    const version = fs.readFileSync(file, 'utf8');
    if (file === live && version === to) throw new Error('replacement failed');
    return version;
  };
  expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'rolled-back', version: from, reason: expect.stringContaining('replacement failed') });
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
  expect(hasAdoptFailed(home, platform, to, deps.localAppData)).toBe(true);
  if (process.platform !== 'win32') expect(fs.statSync(live).mode & 0o111).not.toBe(0);
});

it.skipIf(process.platform === 'win32')('hard-links the old inode before atomically swapping and never removes the live path', async () => {
  const inode = fs.statSync(live).ino;
  const previous = path.join(path.dirname(live), 'myco.prev');
  fs.writeFileSync(previous, 'older backup');
  const events: string[] = [];
  deps.fs = {
    rmSync: (file, options) => { expect(fs.existsSync(live)).toBe(true); fs.rmSync(file, options); },
    linkSync: (source, dest) => {
      expect(source).toBe(live); expect(path.basename(String(dest))).toBe('myco.prev');
      fs.linkSync(source, dest);
      expect(fs.statSync(dest).ino).toBe(inode);
      expect(fs.statSync(live).ino).toBe(inode);
      events.push('link');
    },
    renameSync: (source, dest) => {
      if (dest === previous) {
        expect(fs.statSync(source).ino).toBe(inode);
        expect(fs.readFileSync(previous, 'utf8')).toBe('older backup');
        fs.renameSync(source, dest);
        return;
      }
      expect(fs.readFileSync(live, 'utf8')).toBe(from);
      expect(fs.readFileSync(previous, 'utf8')).toBe(from);
      expect(fs.statSync(previous).ino).toBe(fs.statSync(live).ino);
      events.push('swap');
      fs.renameSync(source, dest);
      expect(fs.readFileSync(live, 'utf8')).toBe(to);
    },
  };
  expect((await updateBinary('manual', {}, deps)).kind).toBe('adopted');
  expect(events).toEqual(['link', 'swap']);
  expect(fs.statSync(previous).ino).toBe(inode);
  expect(fs.statSync(live).ino).not.toBe(inode);
  expect(fs.statSync(live).mode & 0o111).not.toBe(0);
  expect(fs.readFileSync(path.join(stage, 'myco'), 'utf8')).toBe(to);
  expect(fs.readdirSync(path.dirname(live)).some(file => file.startsWith('.myco-update-'))).toBe(false);
});

it.skipIf(process.platform === 'win32')('reports a placement chmod failure, preserves live bytes, and removes temporary files', async () => {
  const chmod = spyOn(fs, 'chmodSync').mockImplementation(() => { throw new Error('chmod failed'); });
  try {
    expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('chmod failed') });
    expect(fs.readFileSync(live, 'utf8')).toBe(from);
    expect(fs.readdirSync(path.dirname(live)).some(file => file.startsWith('.myco-update-'))).toBe(false);
  } finally { chmod.mockRestore(); }
});

it('Windows renames an open live file aside before installing the replacement', async () => {
  deps.platform = 'win32';
  const fd = fs.openSync(live, 'r');
  const previous = path.join(path.dirname(live), 'myco.prev.exe');
  fs.writeFileSync(previous, 'older backup');
  const events: string[] = [];
  deps.fs = {
    rmSync: fs.rmSync,
    linkSync: () => { throw new Error('Windows used a hard link'); },
    renameSync: (source, dest) => {
      events.push(source === previous ? 'retire' : dest === previous ? 'aside' : 'replace');
      if (dest === live) { expect(fs.existsSync(live)).toBe(false); expect(fs.readFileSync(previous, 'utf8')).toBe(from); }
      fs.renameSync(source, dest);
    },
  };
  try {
    expect((await updateBinary('manual', {}, deps)).kind).toBe('adopted');
    expect(events).toEqual(['retire', 'aside', 'replace']);
    expect(fs.readFileSync(fd, 'utf8')).toBe(from);
    expect(fs.readFileSync(live, 'utf8')).toBe(to);
  } finally { fs.closeSync(fd); }
});

for (const platform of ['linux', 'win32'] as const) it(`preserves an earlier backup when securing the new backup fails on ${platform}`, async () => {
  deps.platform = platform;
  const previous = path.join(path.dirname(live), platform === 'win32' ? 'myco.prev.exe' : 'myco.prev');
  fs.writeFileSync(previous, 'earlier backup');
  deps.fs = {
    rmSync: fs.rmSync,
    linkSync: () => { throw new Error('cannot secure backup'); },
    renameSync: (source, dest) => {
      if (source === live) throw new Error('cannot secure backup');
      fs.renameSync(source, dest);
    },
  };
  expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('cannot secure backup') });
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
  expect(fs.readFileSync(previous, 'utf8')).toBe('earlier backup');
});

for (const [code, rollback] of [['EPERM', false], ['EIO', false], ['EIO', true]] as const) it(`Windows reports the installed outcome when previous-version cleanup fails: ${code}, rollback=${rollback}`, async () => {
  deps.platform = 'win32';
  const previous = path.join(path.dirname(live), 'myco.prev.exe');
  fs.writeFileSync(previous, 'earlier running version');
  deps.fs = {
    linkSync: fs.linkSync, renameSync: fs.renameSync,
    rmSync: (file, options) => {
      if (String(file).includes('.myco-retired-')) throw Object.assign(new Error('cleanup failed'), { code });
      fs.rmSync(file, options);
    },
  };
  if (rollback) deps.probeVersion = file => {
    const version = fs.readFileSync(file, 'utf8');
    if (file === live && version === to) throw new Error('post-check failed');
    return version;
  };
  const outcome = await updateBinary('manual', {}, deps);
  expect(outcome.kind).toBe(rollback ? 'rolled-back' : 'adopted');
  if (outcome.kind === 'adopted' || outcome.kind === 'rolled-back') {
    expect(outcome.version).toBe(rollback ? from : to);
    expect(outcome.retainedPrevious![0]!.reason).toContain('cleanup failed');
    expect(fs.readFileSync(outcome.retainedPrevious![0]!.path, 'utf8')).toBe('earlier running version');
  }
  expect(fs.readFileSync(live, 'utf8')).toBe(rollback ? from : to);
  expect(fs.existsSync(previous)).toBe(!rollback);
});

it.skipIf(process.platform !== 'win32')('Windows performs consecutive replacements while a process executes the older exe', async () => {
  fs.copyFileSync(process.execPath, live);
  fs.copyFileSync(process.execPath, path.join(stage, 'myco.exe'));
  const child = Bun.spawn([live, '-e', 'console.log("ready"); await Bun.sleep(60000)'], {
    cwd: root, env: sandboxChildEnv(root, { LOCALAPPDATA: deps.localAppData! }), stdout: 'pipe', stderr: 'pipe',
  });
  let liveProbes = 0;
  deps.probeVersion = file => file === live && liveProbes++ === 0 ? from : to;
  try {
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain('ready');
    expect((await updateBinary('manual', {}, deps)).kind).toBe('adopted');
    expect(child.exitCode).toBeNull();
    expect(fs.readFileSync(path.join(path.dirname(live), 'myco.prev.exe'))).toEqual(fs.readFileSync(process.execPath));
    expect(fs.readFileSync(live)).toEqual(fs.readFileSync(process.execPath));
    const next = '2.0.0-alpha.4';
    deps.resolveRefs = async () => ({ targetVersion: next, assetName: 'fixture', assetUrl: 'fixture', sha256sumsUrl: 'fixture' });
    deps.probeVersion = file => file === live && liveProbes++ === 2 ? to : next;
    expect((await updateBinary('manual', {}, deps)).kind).toBe('adopted');
    expect(child.exitCode).toBeNull();
  } finally { child.kill(); await child.exited; }
}, 15_000);

for (const caller of ['manual', 'automatic'] as const) it(`bounds lock contention for ${caller} and prevents overlapping adoption`, async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const enteredStage = new Promise<void>(resolve => { entered = resolve; });
  const releaseStage = new Promise<void>(resolve => { unblock = resolve; });
  deps.stageBinary = async () => { stages++; entered(); await releaseStage; return { version: to, versionDir: stage }; };
  const first = updateBinary('manual', {}, deps);
  await enteredStage;
  try {
    const started = performance.now();
    expect(await updateBinary(caller, {}, deps)).toEqual({ kind: caller === 'manual' ? 'failed' : 'skipped', reason: 'an update is running' });
    expect(performance.now() - started).toBeGreaterThanOrEqual(BINARY_UPDATE_WAIT_MS - 10);
    expect(stages).toBe(1);
  } finally { unblock(); }
  expect((await first).kind).toBe('adopted');
  const lease = LifecycleLock.acquire(path.join(home, 'member', REPAIR_LOCK));
  expect(lease.acquired).toBe(true);
  if (lease.acquired) lease.lock.release();
  expect((await updateBinary('manual', {}, deps)).kind).toBe('already-current');
  expect(stages).toBe(1);
});

it('excludes a manual custom-home update while the default home updates the same executable', async () => {
  const customHome = path.join(root, 'custom');
  writeInstallMarker(customHome, { bin: live, source: 'curl', channel: 'alpha' });
  let entered!: () => void;
  let unblock!: () => void;
  const enteredStage = new Promise<void>(resolve => { entered = resolve; });
  const releaseStage = new Promise<void>(resolve => { unblock = resolve; });
  deps.stageBinary = async () => {
    stages++;
    if (stages === 1) { entered(); await releaseStage; }
    return { version: to, versionDir: stage };
  };
  const first = updateBinary('automatic', {}, deps);
  await enteredStage;
  try {
    expect(await updateBinary('manual', {}, { ...deps, home: customHome })).toEqual({ kind: 'failed', reason: 'an update is running' });
    expect(stages).toBe(1);
  } finally { unblock(); await first; }
});

it('holds a custom home repair lease as well as the machine lease and releases partial acquisitions', async () => {
  const customHome = path.join(root, 'custom-repair');
  writeInstallMarker(customHome, { bin: live, source: 'curl', channel: 'alpha' });
  const repairing = LifecycleLock.acquire(path.join(customHome, 'member', REPAIR_LOCK));
  expect(repairing.acquired).toBe(true);
  try {
    expect(await updateBinary('manual', {}, { ...deps, home: customHome })).toEqual({ kind: 'failed', reason: 'an update is running' });
    expect(stages).toBe(0);
    const machine = LifecycleLock.acquire(path.join(home, 'member', REPAIR_LOCK));
    expect(machine.acquired).toBe(true);
    if (machine.acquired) machine.lock.release();
  } finally { if (repairing.acquired) repairing.lock.release(); }
  expect((await updateBinary('manual', {}, { ...deps, home: customHome })).kind).toBe('adopted');
});

it.skipIf(process.platform === 'win32')('deduplicates machine and member repair leases for a home alias', async () => {
  const alias = path.join(root, 'home-alias');
  fs.symlinkSync(home, alias, 'dir');
  expect((await updateBinary('manual', {}, { ...deps, home: alias })).kind).toBe('adopted');
});

it('refuses a 1.x release even from an injected resolver', async () => {
  deps.currentVersion = '1.4.8';
  fs.writeFileSync(live, '1.4.8');
  deps.resolveRefs = async () => ({ targetVersion: '1.9.0', assetName: 'fixture', assetUrl: 'fixture', sha256sumsUrl: 'fixture' });
  expect((await updateBinary('manual', {}, deps)).kind).toBe('already-current');
  expect(stages).toBe(0);
});

for (const phase of ['placement', 'stage placement', 'swap', 'post-check'] as const) it(`does not denylist an environmental failure during ${phase}`, async () => {
  const noSpace = () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); };
  if (phase === 'placement') deps.placeBinary = noSpace;
  if (phase === 'stage placement') {
    delete deps.stageBinary;
    deps.stageDeps = {
      download: async (url, file) => fs.writeFileSync(file, url === 'sums' ? `${'a'.repeat(64)}  fixture\n` : 'fixture'),
      computeSha256: async () => 'a'.repeat(64), ready: noSpace,
    };
    deps.resolveRefs = async () => ({ targetVersion: to, assetName: 'fixture', assetUrl: 'binary', sha256sumsUrl: 'sums' });
  }
  if (phase === 'swap') deps.fs = { ...fs, renameSync: (source, dest) => {
    if (String(source).includes('.myco-update-') && dest === live) noSpace();
    fs.renameSync(source, dest);
  } };
  if (phase === 'post-check') deps.probeVersion = file => {
    const version = fs.readFileSync(file, 'utf8');
    if (file === live && version === to) noSpace();
    return version;
  };
  expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'failed', reason: expect.stringContaining('ENOSPC') });
  expect(hasAdoptFailed(home, process.platform, to, deps.localAppData)).toBe(false);
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
});

it('allows only an explicit manual retry and clears both failed-version records after adoption', async () => {
  const slot = versionDir(home, process.platform, to, deps.localAppData);
  fs.mkdirSync(slot, { recursive: true });
  markAdoptFailed(home, process.platform, to, deps.localAppData);
  deps.targetTriple = () => 'darwin-arm64';
  deps.fetchReleases = async () => [{ tag_name: `myco/v${to}`, prerelease: true, assets: [
    { name: 'myco-darwin-arm64', browser_download_url: 'fixture' },
    { name: 'SHA256SUMS', browser_download_url: 'sums' },
  ] }];
  for (const options of [{}, { targetVersion: to }]) expect((await updateBinary('automatic', options, deps)).kind).toBe('skipped');
  expect((await updateBinary('manual', {}, deps)).kind).toBe('skipped');
  expect(stages).toBe(0);
  expect((await updateBinary('manual', { targetVersion: to }, deps)).kind).toBe('adopted');
  expect(hasAdoptFailed(home, process.platform, to, deps.localAppData)).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'bin', 'adopt-failed.json'), 'utf8'))).not.toContain(to);
  expect(fs.existsSync(path.join(slot, '.adopt-failed'))).toBe(false);
});

for (const contents of ['{"oops"', '{"versions":[]}']) it(`names the malformed failed-version file and its remedy: ${contents}`, async () => {
  const file = path.join(home, 'bin', 'adopt-failed.json');
  fs.writeFileSync(file, contents);
  const outcome = await updateBinary('manual', {}, deps);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind === 'failed') {
    expect(outcome.reason).toContain(file);
    expect(outcome.reason).toContain('Delete or repair');
  }
  expect(stages).toBe(0);
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
});

it('restores Windows previous bytes by renaming the held new exe aside', async () => {
  deps.platform = 'win32';
  let held = false;
  deps.probeVersion = file => {
    const version = fs.readFileSync(file, 'utf8');
    if (file === live && version === to) { held = true; throw new Error('post-check failed'); }
    return version;
  };
  deps.fs = { ...fs,
    rmSync: (file, options) => {
      if (held && (file === live || String(file).includes('.myco-retired-'))) throw Object.assign(new Error('held executable'), { code: 'EBUSY' });
      fs.rmSync(file, options);
    },
    renameSync: (source, dest) => {
      if (held && dest === live && fs.existsSync(live)) throw new Error('cannot rename over held executable');
      fs.renameSync(source, dest);
    },
  };
  const outcome = await updateBinary('manual', {}, deps);
  expect(outcome.kind).toBe('rolled-back');
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
  expect(hasAdoptFailed(home, 'win32', to, deps.localAppData)).toBe(true);
  if (outcome.kind === 'rolled-back') {
    expect(outcome.retainedPrevious).toHaveLength(1);
    expect(fs.readFileSync(outcome.retainedPrevious![0]!.path, 'utf8')).toBe(to);
  }
});

it('names both failed Windows renames and gives recovery when no live executable remains', async () => {
  deps.platform = 'win32';
  const previous = path.join(path.dirname(live), 'myco.prev.exe');
  deps.fs = { ...fs, renameSync: (source, dest) => {
    if (dest === live) throw Object.assign(new Error(source === previous ? 'restore blocked' : 'swap blocked'), { code: 'EBUSY' });
    fs.renameSync(source, dest);
  } };
  const outcome = await updateBinary('manual', {}, deps);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind === 'failed') {
    expect(outcome.reason).toContain('swap blocked');
    expect(outcome.reason).toContain(`rename ${previous} to ${live} failed (restore blocked)`);
    expect(outcome.reason).toContain(`No ${path.basename(live)} is at ${live}`);
    expect(outcome.reason).toContain(`Recovery: move "${previous}" "${live}"`);
  }
  expect(fs.existsSync(live)).toBe(false);
  expect(fs.readFileSync(previous, 'utf8')).toBe(from);
  expect(hasAdoptFailed(home, 'win32', to, deps.localAppData)).toBe(false);
});

it('runs static skip guards before attempting a busy lease', async () => {
  const lease = LifecycleLock.acquire(path.join(home, 'member', REPAIR_LOCK));
  expect(lease.acquired).toBe(true);
  try {
    expect(await updateBinary('manual', { skipBinary: true }, deps)).toEqual({ kind: 'skipped', reason: '--skip-binary requested' });
    expect(await updateBinary('manual', {}, { ...deps, currentVersion: '0.0.0-dev' })).toEqual({ kind: 'skipped', reason: 'development build' });
    expect(await updateBinary('automatic', {}, { ...deps, home: path.join(root, 'custom') })).toEqual({ kind: 'skipped', reason: 'this is not the default Myco home' });
  } finally { if (lease.acquired) lease.lock.release(); }
});

it('sweeps stale update directories and unused retired files under the lease, retaining held files', async () => {
  const directory = path.dirname(live);
  const stale = path.join(directory, '.myco-update-stale');
  const retired = path.join(directory, '.myco-retired-unused.exe');
  const held = path.join(directory, '.myco-retired-held.exe');
  fs.mkdirSync(stale); fs.writeFileSync(path.join(stale, 'myco'), 'stale');
  fs.writeFileSync(retired, 'unused'); fs.writeFileSync(held, 'held');
  deps.fs = { ...fs, rmSync: (file, options) => {
    if (file === held) throw Object.assign(new Error('held'), { code: 'EBUSY' });
    const lease = LifecycleLock.acquire(path.join(home, 'member', REPAIR_LOCK));
    expect(lease.acquired).toBe(false);
    if (lease.acquired) lease.lock.release();
    fs.rmSync(file, options);
  } };
  const outcome = await updateBinary('manual', {}, deps);
  expect(outcome.kind).toBe('adopted');
  if ('retainedPrevious' in outcome) {
    expect(outcome.retainedPrevious![0]!.path).toBe(held);
    expect(outcome.retainedPrevious![0]!.reason).toContain('held');
  } else throw new Error('missing retained-file report');
  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(retired)).toBe(false);
  expect(fs.readFileSync(held, 'utf8')).toBe('held');
});

it.skipIf(process.platform !== 'win32')('Windows rolls back while a process executes the failed new exe', async () => {
  fs.copyFileSync(process.execPath, live);
  fs.copyFileSync(process.execPath, path.join(stage, 'myco.exe'));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let probes = 0;
  deps.probeVersion = async file => {
    if (file !== live) return to;
    if (probes++ === 0) return from;
    child = Bun.spawn([live, '-e', 'console.log("ready"); await Bun.sleep(60000)'], {
      cwd: root, env: sandboxChildEnv(root, { LOCALAPPDATA: deps.localAppData! }), stdout: 'pipe', stderr: 'pipe',
    });
    if (typeof child.stdout === 'number' || child.stdout === undefined) throw new Error('missing child stdout');
    const ready = await child.stdout.getReader().read();
    expect(new TextDecoder().decode(ready.value)).toContain('ready');
    throw new Error('post-check failed');
  };
  try {
    const outcome = await updateBinary('manual', {}, deps);
    expect(outcome.kind).toBe('rolled-back');
    expect(child?.exitCode).toBeNull();
    expect(fs.readFileSync(live)).toEqual(fs.readFileSync(process.execPath));
    expect(hasAdoptFailed(home, 'win32', to, deps.localAppData)).toBe(true);
    if (outcome.kind === 'rolled-back') {
      expect(outcome.retainedPrevious).toHaveLength(1);
      expect(fs.readFileSync(outcome.retainedPrevious![0]!.path)).toEqual(fs.readFileSync(process.execPath));
    }
  } finally { if (child) { child.kill(); await child.exited; } }
}, 15_000);

it('reports adoption and the repair action if clearing failure records fails', async () => {
  const file = path.join(home, 'bin', 'adopt-failed.json');
  let writes = 0;
  deps.failureRecordWriter = target => {
    expect(target).toBe(file);
    writes++;
    throw Object.assign(new Error('ENOSPC while clearing record'), { code: 'ENOSPC' });
  };
  const outcome = await updateBinary('manual', {}, deps);
  expect(writes).toBe(1);
  expect(outcome.kind).toBe('adopted');
  expect(fs.readFileSync(live, 'utf8')).toBe(to);
  expect(outcome.warnings).toHaveLength(1);
  expect(outcome.warnings![0]).toContain('could not clear');
  expect(outcome.warnings![0]).toContain(file);
  expect(outcome.warnings![0]).toContain('Delete or repair');
});

it('preserves Windows missing-executable recovery if failure bookkeeping also fails', async () => {
  deps.platform = 'win32';
  const previous = path.join(path.dirname(live), 'myco.prev.exe');
  deps.probeVersion = file => {
    const version = fs.readFileSync(file, 'utf8');
    if (file === live && version === to) throw new Error('post-check failed');
    return version;
  };
  deps.fs = { ...fs, renameSync: (source, dest) => {
    if (source === previous && dest === live) throw new Error('restore blocked');
    fs.renameSync(source, dest);
  } };
  let writes = 0;
  deps.failureRecordWriter = file => {
    expect(file).toBe(path.join(home, 'bin', 'adopt-failed.json'));
    writes++;
    throw Object.assign(new Error('ENOSPC recording failed version'), { code: 'ENOSPC' });
  };
  const outcome = await updateBinary('manual', {}, deps);
  expect(writes).toBe(1);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind === 'failed') {
    expect(outcome.reason).toContain('restore blocked');
    expect(outcome.reason).toContain(`Recovery: move "${previous}" "${live}"`);
  }
  expect(fs.existsSync(live)).toBe(false);
  expect(outcome.warnings).toHaveLength(1);
  expect(outcome.warnings![0]).toContain('ENOSPC recording failed version');
});

it('does not denylist an operating-system refusal returned by the readiness probe', async () => {
  deps.placeBinary = (source, dest, options) => placeExecutable(source, dest, { ...options, ready: () => ({
    runs: false, detail: 'permission denied', error: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
  }) });
  expect((await updateBinary('manual', {}, deps)).kind).toBe('failed');
  expect(fs.readFileSync(live, 'utf8')).toBe(from);
  expect(hasAdoptFailed(home, process.platform, to, deps.localAppData)).toBe(false);
});

it('reports no nonexistent retained path when retiring the failed Windows executable fails', async () => {
  deps.platform = 'win32';
  deps.probeVersion = file => {
    const version = fs.readFileSync(file, 'utf8');
    if (file === live && version === to) throw new Error('post-check failed');
    return version;
  };
  deps.fs = { ...fs, renameSync: (source, dest) => {
    if (String(dest).includes('.myco-retired-')) throw new Error('rename failed executable blocked');
    fs.renameSync(source, dest);
  } };
  const outcome = await updateBinary('manual', {}, deps);
  expect(outcome.kind).toBe('failed');
  if (outcome.kind === 'failed') expect(outcome.reason).toContain('rename failed executable');
  expect(outcome.retainedPrevious).toBeUndefined();
  expect(fs.readFileSync(live, 'utf8')).toBe(to);
  expect(fs.readFileSync(path.join(path.dirname(live), 'myco.prev.exe'), 'utf8')).toBe(from);
});
