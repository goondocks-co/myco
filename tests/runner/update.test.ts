import { afterAll, describe, expect, it, spyOn } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRunnerUpdateController, readRunnerUpdateState, strictRunnerReleaseProbe, withRunnerUpdateState } from '../../packages/myco/src/runner/update.js';
import { runRunnerUpdateHelper } from '../../packages/myco/src/runner/update-helper.js';
import { writeInstallMarker, versionBinaryPath } from '../../packages/myco/src/install/managed-binary.js';
import { placeExecutable } from '../../packages/myco/src/install/place-binary.js';
import { runnerProgramVersion } from '../../packages/myco/src/runner/program.js';
import { acquireInstallationLease, beginBinaryPublication, publishAdoptedMarker } from '../../packages/myco/src/install/adoption.js';
import { updateBinary, type BinaryUpdateDeps } from '../../packages/myco/src/upgrade/guarded-binary.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { stageBinary } from '../../packages/myco/src/upgrade/apply-binary.js';
import type { ServiceSpec } from '../../packages/myco/src/server/service.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-update-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const from = '2.0.0-alpha.1';
const to = '2.0.0-alpha.2';
const asset = `myco-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
const releases = [{ tag_name: `myco/v${to}`, prerelease: true, assets: [
  { name: asset, browser_download_url: 'https://fixture.invalid/binary' },
  { name: 'SHA256SUMS', browser_download_url: 'https://fixture.invalid/sums' },
] }];
const serviceSpec = (binaryPath: string, home: string): ServiceSpec => ({
  binaryPath, home, pathEnv: '', logDir: home, env: { MYCO_HOME: home },
  unit: { label: 'fixture', unitName: 'fixture', description: 'fixture', args: ['runner', 'run'], logName: 'fixture', restartDelaySeconds: 1 },
});
const installGuardian = () => ({ unitFile: 'fixture', loaded: true, running: true, changed: true });
const removeGuardian = () => {};
function fixture(label: string) {
  const home = path.join(root, label);
  const binaryPath = path.join(home, 'service-bin', 'myco');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, `#!/bin/sh\nprintf '%s\\n' '${from}'\n`, { mode: 0o755 });
  writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: path.join(home, 'bin', 'myco') });
  const source = path.join(home, 'release');
  fs.writeFileSync(source, `#!/bin/sh\nprintf '%s\\n' '${to}'\n`, { mode: 0o755 });
  const sum = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const fetch = async (_url: string | URL | Request) => new Response(JSON.stringify(releases), { status: 200, headers: { etag: 'fixture-etag' } });
  const stageDeps = {
    download: async (url: string, dest: string) => { if (url.endsWith('/binary')) fs.copyFileSync(source, dest); else fs.writeFileSync(dest, `${sum}  ${asset}\n`); },
    computeSha256: async (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
  return { home, binaryPath, source, fetch: fetch as typeof globalThis.fetch, stageDeps };
}

describe('runner release handoff', () => {
  it('refuses an invalid macOS signature and an incorrect --version', () => {
    const f = fixture('probe');
    expect(strictRunnerReleaseProbe(f.source, to, 'darwin').runs).toBe(false);
    expect(strictRunnerReleaseProbe(f.source, '2.9.9', 'linux').runs).toBe(false);
    expect(strictRunnerReleaseProbe(f.source, to, 'linux')).toEqual({ runs: true });
    const cwdProbe = path.join(f.home, 'cwd-probe');
    fs.writeFileSync(cwdProbe, `#!/bin/sh\n[ "$PWD" = '${f.home}' ] || exit 1\nprintf '%s\\n' '${to}'\n`, { mode: 0o755 });
    expect(strictRunnerReleaseProbe(cwdProbe, to, 'linux')).toEqual({ runs: true });
  });

  it('rejects a checksum mismatch without touching the installed binary', async () => {
    const f = fixture('checksum');
    const before = fs.readFileSync(f.binaryPath);
    const result = await stageBinary({ home: f.home, platform: process.platform, refs: {
      assetName: asset, assetUrl: 'https://fixture.invalid/binary', sha256sumsUrl: 'https://fixture.invalid/sums', targetVersion: to,
    } }, { ...f.stageDeps, download: async (url, dest) => {
      if (url.endsWith('/sums')) fs.writeFileSync(dest, `${'0'.repeat(64)}  ${asset}\n`);
      else fs.copyFileSync(f.source, dest);
    }, ready: () => { throw new Error('checksum failure must precede the probe'); } });
    expect(result).toHaveProperty('error');
    expect(fs.readFileSync(f.binaryPath)).toEqual(before);
    expect(fs.existsSync(versionBinaryPath(f.home, process.platform, to))).toBe(false);
  });

  it('does not stage an older release or repeat the same dashboard request', async () => {
    const f = fixture('no-downgrade');
    let fetched = 0;
    let staged = 0;
    const older = [{ ...releases[0], tag_name: 'myco/v2.0.0-alpha.0' }];
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, serviceInstalled: () => true,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        fetch: (async () => { fetched++; return new Response(JSON.stringify(older), { status: 200 }); }) as unknown as typeof fetch,
        stage: async () => { staged++; throw new Error('older release reached staging'); },
      } });
    const request = { updateRequest: { id: 'older-request', requestedAt: 900 } };
    controller.onContact(request);
    expect(await controller.idle()).toBe('continue');
    controller.onContact(request);
    expect(await controller.idle()).toBe('continue');
    expect(fetched).toBe(1);
    expect(staged).toBe(0);
    expect(controller.contactPayload().latestVersion).toBeNull();
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({ requestId: 'older-request', result: 'no_update' });
  });

  it('uses the installed channel when other channels have newer releases', async () => {
    const f = fixture('channel');
    writeInstallMarker(f.home, { channel: 'stable', source: 'curl', bin: f.binaryPath });
    const mixed = ['2.0.1', '2.1.0-alpha.1', '2.1.0-beta.1', '1.4.99'].map(version => ({ ...releases[0], tag_name: `myco/v${version}`, prerelease: version.includes('-') }));
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: '2.0.0', serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, fetch: (async () => Response.json(mixed)) as unknown as typeof fetch,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
      } });
    expect(await controller.check()).toMatchObject({ channel: 'stable', latestVersion: '2.0.1' });
  });

  it('clears a withdrawn dashboard request on contact while retaining a local manual request', () => {
    const f = fixture('withdrawn');
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {} });
    controller.onContact({ updateRequest: { id: 'before-restore', requestedAt: 900 } });
    expect(readRunnerUpdateState(f.home).requests?.['https://deployment.invalid']?.id).toBe('before-restore');
    controller.onContact({ updateRequest: null });
    expect(readRunnerUpdateState(f.home).requests?.['https://deployment.invalid']).toBeUndefined();
    controller.queueManual();
    controller.onContact({ updateRequest: null });
    expect(readRunnerUpdateState(f.home).requests?.['https://deployment.invalid']?.manual).toBe(true);
  });

  it('refuses dashboard update on an unenrolled source runner without a service', async () => {
    const f = fixture('no-service');
    fs.rmSync(path.join(f.home, 'install.json'));
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: { now: () => 1000 } });
    expect(controller.contactPayload().channel).toBeNull();
    controller.onContact({ updateRequest: { id: 'unavailable', requestedAt: 900 } });
    expect(await controller.idle()).toBe('continue');
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({ result: 'refused', requestId: 'unavailable' });
  });

  for (const [label, probe] of [
    ['bad-signature', (file: string, version: string) => strictRunnerReleaseProbe(file, version, 'darwin')],
    ['wrong-version', (file: string) => strictRunnerReleaseProbe(file, '2.9.9', 'linux')],
    ['failed-launch', () => ({ runs: false as const, detail: 'exec format error' })],
  ] as const) it(`keeps the installed binary when the ${label} probe refuses staging`, async () => {
    const f = fixture(label);
    const before = fs.readFileSync(f.binaryPath);
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, serviceInstalled: () => true, fetch: f.fetch, stageDeps: f.stageDeps,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        probe: (file, version) => version === from ? strictRunnerReleaseProbe(file, version, 'linux') : probe(file, version),
        installGuardian, removeGuardian, spawnHelper: async () => {},
      } });
    controller.onContact({ updateRequest: { id: label, requestedAt: 900 } });
    expect(await controller.idle()).toBe('continue');
    expect(fs.readFileSync(f.binaryPath)).toEqual(before);
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({ requestId: label, result: 'refused' });
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
  });

  it('uses ETag on scheduled checks and keeps a failed request within backoff', async () => {
    const f = fixture('etag-backoff');
    let now = 1000;
    let calls = 0;
    let conditional = false;
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => now, random: () => 0, serviceInstalled: () => true,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        fetch: (async (_url: unknown, init: RequestInit) => {
          calls++;
          if (calls === 1) return new Response(JSON.stringify([]), { status: 200, headers: { etag: 'release-etag' } });
          conditional = (init.headers as Record<string, string>)['If-None-Match'] === 'release-etag';
          if (calls === 2) return new Response(null, { status: 304 });
          throw new Error('failure\n'.repeat(200));
        }) as unknown as typeof fetch,
      } });
    expect(await controller.idle()).toBe('continue');
    now += 6 * 60 * 60 * 1000 + 1;
    expect(await controller.idle()).toBe('continue');
    expect(conditional).toBe(true);
    controller.onContact({ updateRequest: { id: 'failed-request', requestedAt: now } });
    expect(await controller.idle()).toBe('continue');
    controller.onContact({ updateRequest: { id: 'failed-request', requestedAt: now } });
    expect(await controller.idle()).toBe('continue');
    expect(calls).toBe(3);
    const result = readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid'];
    expect(result?.result).toBe('failed');
    expect(result?.reason?.includes('\n')).toBe(false);
    expect(result?.reason?.length).toBeLessThanOrEqual(512);
  });

  it('keeps a targeted alpha.2 check and update out of the automatic alpha.3 cache', async () => {
    const f = fixture('targeted-selection');
    const newest = '2.0.0-alpha.3';
    const offered = [newest, to].map(version => ({ tag_name: `myco/v${version}`, prerelease: true, assets: releases[0]!.assets }));
    const headers: Array<string | null> = [];
    const staged: string[] = [];
    let now = 1000;
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => now, random: () => 0, serviceInstalled: () => true,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        fetch: (async (_url: unknown, init: RequestInit) => {
          const conditional = new Headers(init.headers).get('if-none-match');
          headers.push(conditional);
          return conditional === null
            ? new Response(JSON.stringify(offered), { status: 200, headers: { etag: 'same-release-list' } })
            : new Response(null, { status: 304 });
        }) as unknown as typeof fetch,
        stage: async ({ refs }) => { staged.push(refs.targetVersion); return { error: 'test stops before binary staging' }; },
      } });
    expect((await controller.check({ targetVersion: to })).latestVersion).toBe(to);
    expect(readRunnerUpdateState(f.home)).toMatchObject({ lastCheckAt: null, latestVersion: null });
    expect(fs.existsSync(path.join(f.home, 'last-update-check.json'))).toBe(false);

    controller.queueManual({ targetVersion: to });
    expect(await controller.idle()).toBe('continue');
    expect(staged).toEqual([to]);
    expect(readRunnerUpdateState(f.home)).toMatchObject({ latestVersion: null });
    expect(readRunnerUpdateState(f.home).etag).toBeUndefined();
    expect(readRunnerUpdateState(f.home).candidate).toBeUndefined();
    expect(fs.existsSync(path.join(f.home, 'last-update-check.json'))).toBe(false);

    now += 6 * 60 * 60 * 1000 + 1;
    expect(await controller.idle()).toBe('continue');
    expect(headers).toEqual([null, null, null]);
    expect(staged).toEqual([to, newest]);
    expect(readRunnerUpdateState(f.home)).toMatchObject({ latestVersion: newest, releaseChannel: 'alpha', candidate: { refs: { targetVersion: newest } } });
    expect(JSON.parse(fs.readFileSync(path.join(f.home, 'last-update-check.json'), 'utf8'))).toMatchObject({
      channel: 'alpha', packages: { myco: { latest_version: newest } },
    });
  });

  it('does not replace automatic metadata or the recorded-channel notice with another channel', async () => {
    const f = fixture('other-channel');
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, serviceInstalled: () => true,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        fetch: f.fetch,
      } });
    expect((await controller.check({ channel: 'stable' })).channel).toBe('stable');
    expect(readRunnerUpdateState(f.home)).toMatchObject({ lastCheckAt: null, latestVersion: null });
    controller.queueManual({ channel: 'stable' });
    expect(await controller.idle()).toBe('continue');
    expect(readRunnerUpdateState(f.home).releaseChannel).toBeUndefined();
    expect(readRunnerUpdateState(f.home).etag).toBeUndefined();
    expect(readRunnerUpdateState(f.home).candidate).toBeUndefined();
    expect(fs.existsSync(path.join(f.home, 'last-update-check.json'))).toBe(false);
  });

  it('keeps the old runner alive if the guardian unit is not running', async () => {
    const f = fixture('guardian-refusal');
    let removed = 0;
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, serviceInstalled: () => true, fetch: f.fetch, stageDeps: f.stageDeps,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
        installGuardian: () => ({ unitFile: 'fixture', loaded: true, running: false, changed: true }),
        removeGuardian: () => { removed++; },
        spawnHelper: async () => { throw new Error('guardian refusal reached helper'); },
      } });
    expect(await controller.idle()).toBe('continue');
    expect(removed).toBe(1);
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
    expect(readRunnerUpdateState(f.home).guardian).toBeUndefined();
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
  });

  it('uses the service binary path, stages a verified release, and records authenticated health', async () => {
    const f = fixture('healthy');
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath, currentVersion: from,
      serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, fetch: f.fetch, stageDeps: f.stageDeps,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
        serviceInstalled: () => true,
        installGuardian,
        spawnHelper: async () => {},
      } });
    controller.onContact({ updateRequest: { id: 'request-1', requestedAt: 900 } });
    expect(await controller.idle()).toBe('restart');
    expect(readRunnerUpdateState(f.home).transaction?.requestId).toBe('request-1');
    expect(fs.existsSync(versionBinaryPath(f.home, process.platform, from))).toBe(true);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
    let running = true;
    await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
      now: (() => { let tick = 0; return () => tick += 1000; })(), alive: () => false, wait: async () => {},
      stop: () => { running = false; }, stopped: () => !running,
      start: () => {
        running = true;
        withRunnerUpdateState(f.home, (state) => { if (state.transaction?.phase === 'adopted') { state.transaction.phase = 'probation'; state.transaction.contactAt = 1000; state.transaction.completedClaimAt = 1000; } });
        return { unitFile: 'fixture', loaded: true, running: true, changed: true };
      },
      probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
      removeGuardian,
    });
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(to);
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({ requestId: 'request-1', result: 'updated', fromVersion: from, toVersion: to });
    expect(fs.readdirSync(path.join(f.home, 'bin', 'versions')).sort()).toEqual([from, to]);
    expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toMatchObject({
      channel: 'alpha', source: 'curl', bin: f.binaryPath, prerelease: true,
    });
  });

  it('rolls back when the adopted runner never makes authenticated contact', async () => {
    const f = fixture('rollback');
    const priorGood = '2.0.0-alpha.0';
    const priorGoodFile = versionBinaryPath(f.home, process.platform, priorGood);
    fs.mkdirSync(path.dirname(priorGoodFile), { recursive: true });
    fs.writeFileSync(priorGoodFile, `#!/bin/sh\nprintf '%s\\n' '${priorGood}'\n`, { mode: 0o755 });
    let removals = 0;
    const retryRemoveGuardian = () => {
      expect(fs.existsSync(versionBinaryPath(f.home, process.platform, to))).toBe(true);
      expect(readRunnerUpdateState(f.home).cleanup?.failedVersion).toBe(to);
      if (++removals === 1) throw new Error('guardian removal temporarily failed');
    };
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath, currentVersion: from,
      serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, fetch: f.fetch, stageDeps: f.stageDeps,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'), serviceInstalled: () => true, installGuardian,
        removeGuardian: retryRemoveGuardian, spawnHelper: async () => {},
      } });
    expect(await controller.idle()).toBe('restart');
    const previousMarker = JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'));
    writeInstallMarker(f.home, { channel: 'stable', source: 'npm', bin: path.join(f.home, 'other-bin'), prerelease: false });
    let running = true;
    await expect(runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
      now: (() => { let tick = 0; return () => tick += 5000; })(), alive: () => false, wait: async () => {},
      stop: () => { running = false; }, stopped: () => !running,
      start: () => { running = true; return { unitFile: 'fixture', loaded: true, running: true, changed: true }; },
      probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
      removeGuardian: retryRemoveGuardian,
    })).rejects.toThrow('guardian removal temporarily failed');
    expect(fs.readdirSync(path.join(f.home, 'bin', 'versions')).sort()).toEqual([priorGood, from, to]);
    expect(readRunnerUpdateState(f.home).cleanup?.failedVersion).toBe(to);
    controller.startup();
    expect(removals).toBe(2);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']?.result).toBe('failed');
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]).toBeUndefined();
    expect(fs.readdirSync(path.join(f.home, 'bin', 'versions')).sort()).toEqual([priorGood, from]);
    expect(readRunnerUpdateState(f.home).cleanup).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toEqual(previousMarker);
    expect((await controller.check()).latestVersion).toBe(to);
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]).toBeUndefined();
    controller.onContact({ updateRequest: { id: 'retry-failed-release', requestedAt: 1100, clearBlock: true } });
    expect(await controller.idle()).toBe('restart');
    expect(readRunnerUpdateState(f.home).transaction?.requestId).toBe('retry-failed-release');
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
  });

  it('rolls back when the service refuses to start the adopted binary', async () => {
    const f = fixture('restart-failure');
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, serviceInstalled: () => true, fetch: f.fetch, stageDeps: f.stageDeps,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'), installGuardian, spawnHelper: async () => {},
      } });
    expect(await controller.idle()).toBe('restart');
    let starts = 0;
    await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
      now: () => 2000, alive: () => false, stop: () => {}, stopped: () => true,
      start: () => ({ unitFile: 'fixture', loaded: true, running: ++starts > 1, changed: true }),
      probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
      removeGuardian,
    });
    expect(starts).toBe(2);
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(from);
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']?.result).toBe('rolled_back');
  });

  it('finishes a recovered healthy transaction and excludes a duplicate helper', async () => {
    const f = fixture('recovery');
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, serviceInstalled: () => true, fetch: f.fetch, stageDeps: f.stageDeps,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'), installGuardian, spawnHelper: async () => {},
      } });
    expect(await controller.idle()).toBe('restart');
    fs.copyFileSync(versionBinaryPath(f.home, process.platform, to), f.binaryPath);
    withRunnerUpdateState(f.home, (state) => { state.transaction!.phase = 'adopted'; });
    const other = createRunnerUpdateController({ home: f.home, serverUrl: 'https://another-deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: to, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {} });
    other.acknowledgeHealthy();
    expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('adopted');
    const sibling = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.source,
      currentVersion: to, serviceSpec: serviceSpec(f.source, f.home), log: () => {} });
    sibling.acknowledgeHealthy();
    expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('adopted');
    let duplicate: Promise<void> | undefined;
    const file = path.join(f.home, 'runner', 'update.json');
    await runRunnerUpdateHelper(file, {
      alive: () => false, stop: () => { throw new Error('recovered healthy handoff must not stop service'); },
      start: () => { throw new Error('recovered healthy handoff must not restart service'); },
      stopped: () => false,
      now: () => 2000,
      wait: async () => {
        duplicate = runRunnerUpdateHelper(file, { alive: () => false, removeGuardian });
        withRunnerUpdateState(f.home, (state) => { state.transaction!.phase = 'healthy'; });
      },
      prune: (...args) => {
        expect(args[3]).toBe(to);
      },
      removeGuardian,
    });
    await duplicate;
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']?.result).toBe('updated');
  });

  it.skipIf(process.platform === 'win32')('recovers after its supervised helper is killed just after service unload', async () => {
    const f = fixture('guardian-crash');
    let guardian: ServiceSpec | undefined;
    const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
      currentVersion: from, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
        now: () => 1000, random: () => 0, serviceInstalled: () => true, fetch: f.fetch, stageDeps: f.stageDeps,
        targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
        probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
        installGuardian: (spec) => { guardian = spec; return installGuardian(); },
      } });
    expect(await controller.idle()).toBe('restart');
    expect(guardian?.binaryPath).toBe(path.join(f.home, 'runner', 'guardian', 'myco'));
    expect(guardian?.binaryPath).not.toBe(f.binaryPath);
    expect(fs.readFileSync(versionBinaryPath(f.home, process.platform, from), 'utf8')).toContain(from);
    expect(guardian?.unit.args).toEqual(['runner', '__apply-update', path.join(f.home, 'runner', 'update.json')]);
    const sentinel = path.join(f.home, 'runner-service-unloaded');
    const script = path.join(f.home, 'crash-helper.ts');
    const helperSource = path.resolve('packages/myco/src/runner/update-helper.ts');
    const stateFile = path.join(f.home, 'runner', 'update.json');
    fs.writeFileSync(script, `import fs from 'node:fs';\nimport { runRunnerUpdateHelper } from ${JSON.stringify(helperSource)};\nawait runRunnerUpdateHelper(${JSON.stringify(stateFile)}, { now: () => 2000, alive: () => false, probe: () => ({ runs: true }), stop: () => { fs.writeFileSync(${JSON.stringify(sentinel)}, 'stopped'); process.kill(process.pid, 'SIGKILL'); }, stopped: () => true, removeGuardian: () => {} });\n`);
    const first = spawnSync(process.execPath, [script], { cwd: f.home, env: process.env, timeout: 5000 });
    expect(first.signal).toBe('SIGKILL');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('stopped');
    expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('waiting');
    let starts = 0, running = false;
    await runRunnerUpdateHelper(stateFile, {
      now: () => 3000, alive: () => false, stop: () => { running = false; }, stopped: () => !running,
      start: () => {
        starts++; running = true;
        withRunnerUpdateState(f.home, (state) => { if (state.transaction?.phase === 'adopted') state.transaction.phase = 'healthy'; });
        return { unitFile: 'fixture', loaded: true, running: true, changed: true };
      },
      probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
      removeGuardian,
    });
    expect(starts).toBe(1);
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']?.result).toBe('updated');
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(to);
  });
});

const sourceFrom = '0.0.0-dev+commit.bfirst';
const sourceTo = '0.0.0-dev+commit.bsecond';
const sourceCommit = 'a'.repeat(40);
const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shellBinary = (file: string, version: string) => fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
function localFixture(label: string, currentVersion = from) {
  const f = fixture(label);
  shellBinary(f.binaryPath, currentVersion);
  if (currentVersion === sourceFrom) publishAdoptedMarker(f.home, f.binaryPath, currentVersion,
    { kind: 'checkout', checkout: f.home, commit: sourceCommit });
  const candidate = path.join(f.home, 'checkout-build');
  shellBinary(candidate, sourceTo);
  const controller = createRunnerUpdateController({ home: f.home, serverUrl: 'https://deployment.invalid',
    binaryPath: f.binaryPath, currentVersion, serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
      now: () => 1000, random: () => 0, serviceInstalled: () => true,
      fetch: f.fetch, stageDeps: f.stageDeps, installGuardian, removeGuardian, spawnHelper: async () => {},
      targetTriple: () => `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}` as ReturnType<typeof import('../../packages/myco/src/upgrade/release-assets.js').resolveTargetTriple>,
      probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
    } });
  return { ...f, candidate, controller, queue: () => controller.queueLocal({
    binaryPath: candidate, version: sourceTo, checkout: f.home, commit: sourceCommit,
  }) };
}
async function healthyLocal(f: ReturnType<typeof localFixture>) {
  let running = true;
  await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
    now: () => 2000, alive: () => false, wait: async () => {},
    stop: () => { running = false; }, stopped: () => !running,
    start: () => {
      const tx = readRunnerUpdateState(f.home).transaction!;
      expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toMatchObject({
        source: tx.localCandidate ? 'checkout' : tx.installMarker.source === 'npm' ? 'npm' : 'curl',
        version: tx.toVersion, binary_sha256: digest(f.binaryPath),
      });
      running = true;
      withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
      return installGuardian();
    },
    probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'), removeGuardian,
  });
}
describe('runner local artifact handoff', () => {
  for (const installed of [from, sourceFrom]) {
    it(`adopts a digest-pinned local build from ${installed} without release precedence`, async () => {
      const f = localFixture('local-' + installed, installed);
      const expected = fs.readFileSync(f.candidate);
      const hash = digest(f.candidate);
      f.queue();
      const queued = readRunnerUpdateState(f.home).requests?.['https://deployment.invalid']?.localCandidate;
      expect(queued?.version).toBe(sourceTo);
      expect(queued?.sha256).toBe(hash);
      expect(queued?.binaryPath).not.toBe(f.candidate);
      shellBinary(f.candidate, '0.0.0-dev+commit.bthird');
      expect(await f.controller.idle()).toBe('restart');
      expect(readRunnerUpdateState(f.home).transaction?.localCandidate).toEqual(queued);
      expect(fs.readFileSync(path.join(f.home, 'runner', 'guardian', process.platform === 'win32' ? 'myco.exe' : 'myco'))).toEqual(expected);
      await healthyLocal(f);
      expect(fs.readFileSync(f.binaryPath)).toEqual(expected);
      expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toMatchObject({
        source: 'checkout', checkout: f.home, commit: sourceCommit, version: sourceTo, binary_sha256: hash,
      });
      expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({
        fromVersion: installed, toVersion: sourceTo, result: 'updated',
      });
      expect(fs.existsSync(queued!.binaryPath)).toBe(false);
    });
  }
  it('refuses changed queued bytes before stopping the original runner', async () => {
    const f = localFixture('mutated-local');
    const original = fs.readFileSync(f.binaryPath);
    f.queue();
    expect(await f.controller.idle()).toBe('restart');
    const candidate = readRunnerUpdateState(f.home).transaction!.localCandidate!;
    fs.appendFileSync(candidate.binaryPath, '# changed\n');
    let stops = 0;
    await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
      now: () => 2000, alive: () => false, stopped: () => false,
      stop: () => { stops++; }, removeGuardian,
      probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'),
    });
    expect(stops).toBe(0);
    expect(fs.readFileSync(f.binaryPath)).toEqual(original);
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({
      result: 'refused', reason: 'queued local runner candidate digest changed',
    });
  });
  it('requires local release intent even when a remote request supplies forged manual authority', async () => {
    const f = localFixture('source-release-switch', sourceFrom);
    f.controller.onContact({ updateRequest: { id: 'remote', requestedAt: 1000, channel: 'alpha', manual: true } });
    expect(readRunnerUpdateState(f.home).requests?.['https://deployment.invalid']?.manual).toBeUndefined();
    expect(await f.controller.idle()).toBe('continue');
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']?.reason).toContain('source build');
    const damagedMarker = JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'));
    damagedMarker.binary_sha256 = '0'.repeat(64);
    fs.writeFileSync(path.join(f.home, 'install.json'), JSON.stringify(damagedMarker));
    expect(() => f.queue()).toThrow('installed source build has changed');
    f.controller.queueManual();
    expect(await f.controller.idle()).toBe('restart');
    await healthyLocal(f);
    const marker = JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'));
    expect(marker).toMatchObject({ source: 'curl', version: to, binary_sha256: digest(f.binaryPath) });
    expect(marker.checkout).toBeUndefined();
    expect(marker.commit).toBeUndefined();
  });
  it('repairs stale release provenance from the adopted bytes', async () => {
    const f = localFixture('release-stale-hash');
    writeInstallMarker(f.home, { source: 'curl', channel: 'alpha', bin: f.binaryPath,
      version: '2.0.0-alpha.0', binary_sha256: '0'.repeat(64) });
    f.controller.queueManual();
    expect(await f.controller.idle()).toBe('restart');
    await healthyLocal(f);
    expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toMatchObject({
      source: 'curl', version: to, binary_sha256: digest(f.binaryPath),
    });
  });
});

it('retains the complete stamped source version reported by the installed runner', () => {
  const f = localFixture('source-program-probe', sourceFrom);
  expect(runnerProgramVersion(f.binaryPath)).toBe(sourceFrom);
});

it('restores the exact source marker and binary when the next local build fails health', async () => {
  const f = localFixture('source-local-rollback', sourceFrom);
  const original = fs.readFileSync(f.binaryPath);
  const marker = JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'));
  f.queue();
  expect(await f.controller.idle()).toBe('restart');
  let running = true;
  await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
    now: () => 2000, alive: () => false, stop: () => { running = false; }, stopped: () => !running,
    start: () => {
      running = true;
      withRunnerUpdateState(f.home, state => {
        if (state.transaction!.phase === 'adopted') state.transaction!.healthRefusal = 'authentication refused';
      });
      return installGuardian();
    },
    probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'), removeGuardian,
  });
  expect(fs.readFileSync(f.binaryPath)).toEqual(original);
  expect(JSON.parse(fs.readFileSync(path.join(f.home, 'install.json'), 'utf8'))).toEqual(marker);
  expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({
    result: 'rolled_back', fromVersion: sourceFrom, toVersion: sourceTo,
  });
});

it('rejects a queued local journal digest with a trailing newline', () => {
  const f = localFixture('local-digest-journal');
  f.queue();
  const file = path.join(f.home, 'runner', 'update.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.requests['https://deployment.invalid'].localCandidate.sha256 += '\n';
  fs.writeFileSync(file, JSON.stringify(state));
  expect(readRunnerUpdateState(f.home).metadataFailure?.reason).toContain('Invalid runner update record');
  expect(readRunnerUpdateState(f.home).requests).toBeUndefined();
});

it('records local-artifact capability only for the current runtime lock owner', () => {
  const f = localFixture('runtime-capability');
  expect(() => f.controller.recordRuntimeCapability({ pid: process.pid + 1, startedAt: 1000 })).toThrow('this process');
  expect(readRunnerUpdateState(f.home).runtimeCapabilities?.['https://deployment.invalid']).toBeUndefined();
  expect(() => f.controller.recordRuntimeCapability({ pid: process.pid, startedAt: 0 })).toThrow('instance lock');
  f.controller.recordRuntimeCapability({ pid: process.pid, startedAt: 1000 });
  expect(readRunnerUpdateState(f.home).runtimeCapabilities?.['https://deployment.invalid']).toEqual({
    pid: process.pid, lockStartedAt: 1000, localArtifacts: true,
  });
  f.controller.recordRuntimeCapability({ pid: process.pid, startedAt: 2000 });
  expect(readRunnerUpdateState(f.home).runtimeCapabilities?.['https://deployment.invalid']?.lockStartedAt).toBe(2000);
  f.queue();
  expect(readRunnerUpdateState(f.home).requests?.['https://deployment.invalid']?.localCandidate?.version).toBe(sourceTo);
});

it('quarantines a malformed runtime capability instead of granting local-artifact support', () => {
  const f = localFixture('invalid-runtime-capability');
  f.controller.recordRuntimeCapability({ pid: process.pid, startedAt: 1000 });
  const file = path.join(f.home, 'runner', 'update.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.runtimeCapabilities['https://deployment.invalid'].localArtifacts = 'true';
  fs.writeFileSync(file, JSON.stringify(state));
  const decoded = readRunnerUpdateState(f.home);
  expect(decoded.runtimeCapabilities?.['https://deployment.invalid']).toBeUndefined();
  expect(decoded.metadataFailure?.reason).toContain('Invalid runner update record');
});

it('retains runtime capabilities for two runners sharing one home', () => {
  const f = localFixture('multiple-runtime-capabilities');
  const otherUrl = 'https://second-deployment.invalid';
  const other = createRunnerUpdateController({
    home: f.home, serverUrl: otherUrl, binaryPath: f.binaryPath, currentVersion: from,
    serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {},
  });
  f.controller.recordRuntimeCapability({ pid: process.pid, startedAt: 1000 });
  other.recordRuntimeCapability({ pid: process.pid, startedAt: 2000 });
  f.controller.recordRuntimeCapability({ pid: process.pid, startedAt: 3000 });
  expect(readRunnerUpdateState(f.home).runtimeCapabilities).toEqual({
    'https://deployment.invalid': { pid: process.pid, lockStartedAt: 3000, localArtifacts: true },
    [otherUrl]: { pid: process.pid, lockStartedAt: 2000, localArtifacts: true },
  });
});

it.skipIf(process.platform === 'win32')('preserves a queued local candidate when replacement journal publication fails', () => {
  const f = localFixture('queue-publication-failure');
  f.queue();
  const before = fs.readFileSync(path.join(f.home, 'runner', 'update.json'));
  const prior = readRunnerUpdateState(f.home).requests!['https://deployment.invalid']!.localCandidate!;
  const bytes = fs.readFileSync(prior.binaryPath);
  const rename = fs.renameSync;
  const publish = spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
    if (String(destination) === path.join(f.home, 'runner', 'update.json')) throw new Error('injected journal publication failure');
    return rename(source, destination);
  });
  try { expect(() => f.queue()).toThrow('injected journal publication failure'); }
  finally { publish.mockRestore(); }
  expect(fs.readFileSync(path.join(f.home, 'runner', 'update.json'))).toEqual(before);
  expect(fs.readFileSync(prior.binaryPath)).toEqual(bytes);
  expect(readRunnerUpdateState(f.home).requests!['https://deployment.invalid']!.localCandidate).toEqual(prior);
});

it('retires an old local slot only after the replacement request is durable', () => {
  const f = localFixture('queue-retired-candidate');
  f.queue();
  const prior = readRunnerUpdateState(f.home).requests!['https://deployment.invalid']!.localCandidate!;
  f.queue();
  const state = readRunnerUpdateState(f.home);
  const current = state.requests!['https://deployment.invalid']!.localCandidate!;
  expect(state.retiredCandidates).toEqual([prior]);
  expect(fs.existsSync(prior.binaryPath)).toBe(true);
  f.controller.startup();
  expect(fs.existsSync(prior.binaryPath)).toBe(false);
  expect(fs.existsSync(current.binaryPath)).toBe(true);
  expect(readRunnerUpdateState(f.home).retiredCandidates).toBeUndefined();
});

for (const version of ['0.0.0', '0.0.0-dev', '0.0.0+fixture', sourceFrom]) {
  it(`refuses remote automatic replacement of development version ${version}`, async () => {
    const f = localFixture('automatic-dev-' + version, version);
    writeInstallMarker(f.home, { source: 'curl', channel: 'alpha', bin: f.binaryPath });
    f.controller.onContact({ updateRequest: { id: 'remote', requestedAt: 1000, channel: 'alpha' } });
    expect(await f.controller.idle()).toBe('continue');
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({
      result: 'refused', reason: 'automatic updates skipped: this is a source build',
    });
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
  });
}

it('leaves guardian bytes untouched when cleanup only retires an old local candidate', () => {
  const f = localFixture('retired-only-guardian-boundary');
  f.queue();
  const retired = readRunnerUpdateState(f.home).requests!['https://deployment.invalid']!.localCandidate!;
  f.queue();
  const guardian = path.join(f.home, 'runner', 'guardian', process.platform === 'win32' ? 'myco.exe' : 'myco');
  fs.mkdirSync(path.dirname(guardian), { recursive: true });
  const bytes = Buffer.from('guardian owned by another handoff');
  fs.writeFileSync(guardian, bytes);
  f.controller.startup();
  expect(fs.existsSync(retired.binaryPath)).toBe(false);
  expect(readRunnerUpdateState(f.home).retiredCandidates).toBeUndefined();
  expect(fs.readFileSync(guardian)).toEqual(bytes);
});

it('retires a queued local candidate already adopted by another updater', async () => {
  const f = localFixture('local-already-adopted', sourceFrom);
  f.queue();
  const candidate = readRunnerUpdateState(f.home).requests!['https://deployment.invalid']!.localCandidate!;
  fs.copyFileSync(candidate.binaryPath, f.binaryPath);
  publishAdoptedMarker(f.home, f.binaryPath, sourceTo,
    { kind: 'checkout', checkout: f.home, commit: sourceCommit });
  const bytes = fs.readFileSync(f.binaryPath);
  const marker = fs.readFileSync(path.join(f.home, 'install.json'));
  const current = createRunnerUpdateController({
    home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath, currentVersion: sourceTo,
    serviceSpec: serviceSpec(f.binaryPath, f.home), log: () => {}, deps: {
      now: () => 1000, serviceInstalled: () => true,
      stage: async () => { throw new Error('already-current candidate must not be staged'); },
      installGuardian: () => { throw new Error('already-current candidate must not start a guardian'); },
    },
  });
  expect(await current.idle()).toBe('continue');
  const state = readRunnerUpdateState(f.home);
  expect(state.lastResults?.['https://deployment.invalid']).toMatchObject({
    result: 'no_update', fromVersion: sourceTo, toVersion: sourceTo,
  });
  expect(state.requests?.['https://deployment.invalid']).toBeUndefined();
  expect(state.transaction).toBeUndefined();
  expect(state.guardian).toBeUndefined();
  expect(state.cleanup).toBeUndefined();
  expect(state.retiredCandidates).toBeUndefined();
  expect(fs.existsSync(candidate.binaryPath)).toBe(false);
  expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
  expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
});

function interruptMainPublication(f: ReturnType<typeof localFixture>): void {
  const previous = path.join(path.dirname(f.binaryPath), process.platform === 'win32' ? 'myco.prev.exe' : 'myco.prev');
  beginBinaryPublication(f.home, f.binaryPath, previous);
  fs.renameSync(f.binaryPath, previous);
  shellBinary(f.binaryPath, '2.0.0-alpha.99');
}
for (const kind of ['local', 'release'] as const) {
  it(`recovers an interrupted main publication before runner ${kind} admission`, async () => {
    const f = localFixture('main-recovery-' + kind, kind === 'local' ? sourceFrom : from);
    const original = fs.readFileSync(f.binaryPath);
    const marker = fs.readFileSync(path.join(f.home, 'install.json'));
    interruptMainPublication(f);
    if (kind === 'local') {
      f.queue();
      expect(fs.readFileSync(f.binaryPath)).toEqual(original);
      expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
    } else f.controller.queueManual();
    expect(await f.controller.idle()).toBe('restart');
    expect(fs.readFileSync(f.binaryPath)).toEqual(original);
    expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
    expect(fs.existsSync(path.join(f.home, 'install-adoption.json'))).toBe(false);
    expect(readRunnerUpdateState(f.home).transaction?.fromVersion).toBe(kind === 'local' ? sourceFrom : from);
    await healthyLocal(f);
  });
}
it('refuses a stale controller before backing up or overwriting another installed version', async () => {
  const f = localFixture('stale-controller');
  f.queue();
  shellBinary(f.binaryPath, '2.0.0-alpha.9');
  publishAdoptedMarker(f.home, f.binaryPath, '2.0.0-alpha.9', { kind: 'release' });
  const bytes = fs.readFileSync(f.binaryPath);
  const marker = fs.readFileSync(path.join(f.home, 'install.json'));
  expect(await f.controller.idle()).toBe('continue');
  expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']).toMatchObject({ result: 'refused' });
  expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
  expect(fs.existsSync(versionBinaryPath(f.home, process.platform, from))).toBe(false);
  expect(fs.readFileSync(f.binaryPath)).toEqual(bytes);
  expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
});

it('excludes local queueing and a helper while an automatic guarded update is staging', async () => {
  const f = localFixture('main-stage-exclusion');
  const restore = bindSandboxChildHome(f.home);
  let releaseStage!: () => void;
  let enteredStage!: () => void;
  const entered = new Promise<void>(resolve => { enteredStage = resolve; });
  const blocked = new Promise<void>(resolve => { releaseStage = resolve; });
  const guardedHome = path.join(f.home, '.myco');
  writeInstallMarker(guardedHome, { bin: f.binaryPath, channel: 'alpha', source: 'curl' });
  const staged = path.join(f.home, 'main-stage');
  fs.mkdirSync(staged);
  shellBinary(path.join(staged, 'myco'), to);
  const main = updateBinary('automatic', {}, {
    home: guardedHome, cwd: f.home, mycoBinary: f.binaryPath, platform: 'linux', currentVersion: from,
    probeVersion: runnerProgramVersion,
    resolveRefs: async () => ({ targetVersion: to, assetName: asset, assetUrl: 'fixture', sha256sumsUrl: 'fixture' }),
    stageBinary: async () => { enteredStage(); await blocked; return { version: to, versionDir: staged }; },
    placeBinary: (src, dest, options) => placeExecutable(src, dest, { ...options, ready: () => ({ runs: true }) }),
  });
  try {
    await entered;
    expect(() => f.queue()).toThrow('machine installation');
    expect(readRunnerUpdateState(f.home).requests).toBeUndefined();
    const tx = {
      id: 'contending-helper', serverUrl: 'https://deployment.invalid', fromVersion: from, toVersion: to,
      binaryPath: f.binaryPath, home: f.home, platform: 'linux' as const, serviceSpec: serviceSpec(f.binaryPath, f.home),
      installMarker: { source: 'curl' as const, channel: 'alpha' as const, bin: f.binaryPath },
      ownerPid: 12345, startedAt: 1000, phase: 'waiting' as const,
    };
    withRunnerUpdateState(f.home, state => { state.transaction = tx; });
    await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
      alive: () => false,
      stop: () => { throw new Error('contending helper stopped the runner'); },
    });
    expect(readRunnerUpdateState(f.home).transaction).toEqual(tx);
    withRunnerUpdateState(f.home, state => { delete state.transaction; });
  } finally { releaseStage(); }
  try { expect((await main).kind).toBe('adopted'); }
  finally { restore(); }
});

it('keeps the installation lease throughout helper health and admits the main updater after completion', async () => {
  const f = localFixture('helper-health-exclusion');
  f.queue();
  expect(await f.controller.idle()).toBe('restart');
  const staged = path.join(f.home, 'after-health');
  fs.mkdirSync(staged);
  shellBinary(path.join(staged, 'myco'), to);
  let resolutions = 0;
  const deps: BinaryUpdateDeps = {
    home: f.home, cwd: f.home, mycoBinary: f.binaryPath, platform: 'linux', currentVersion: sourceTo,
    probeVersion: runnerProgramVersion,
    resolveRefs: async () => { resolutions++; return { targetVersion: to, assetName: asset, assetUrl: 'fixture', sha256sumsUrl: 'fixture' }; },
    stageBinary: async () => ({ version: to, versionDir: staged }),
    placeBinary: (src, dest, options) => placeExecutable(src, dest, { ...options, ready: () => ({ runs: true }) }),
  };
  let running = true;
  let waits = 0;
  await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
    now: () => 2000, alive: () => false,
    stop: () => { running = false; }, stopped: () => !running,
    start: () => { running = true; return installGuardian(); },
    probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'), removeGuardian,
    wait: async () => {
      waits++;
      expect(await updateBinary('manual', {}, deps)).toMatchObject({ kind: 'failed', reason: 'an update is running' });
      expect(resolutions).toBe(0);
      withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'healthy'; });
    },
  });
  expect(waits).toBe(1);
  expect((await updateBinary('manual', {}, deps)).kind).toBe('adopted');
  expect(resolutions).toBe(1);
});

it('refuses local admission without quarantining an unreadable pending runner journal', () => {
  const f = localFixture('strict-local-admission');
  const file = path.join(f.home, 'runner', 'update.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = JSON.stringify({ version: 1, nextCheckAt: 0, lastCheckAt: null, latestVersion: null, failures: 0,
    transaction: { id: 'unknown-in-flight-authority' } });
  fs.writeFileSync(file, raw);
  expect(() => f.queue()).toThrow('Invalid runner update record');
  expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  expect(fs.existsSync(path.join(f.home, 'runner', 'candidates'))).toBe(false);
});

it('keeps quarantined ownership metadata from admitting another runner publication', async () => {
  const f = localFixture('quarantined-admission');
  const file = path.join(f.home, 'runner', 'update.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{unreadable pending handoff');
  f.controller.contactPayload();
  f.controller.queueManual();
  const before = fs.readFileSync(f.binaryPath);
  expect(await f.controller.idle()).toBe('continue');
  expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
  expect(readRunnerUpdateState(f.home).metadataFailure).toBeDefined();
  expect(fs.readFileSync(f.binaryPath)).toEqual(before);
  expect(() => f.queue()).toThrow('metadata requires recovery');
});

it('refuses publication when quarantine exists but its recovery record is missing', () => {
  const f = localFixture('missing-quarantine-recovery-record');
  const file = path.join(f.home, 'runner', 'update.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.quarantine-fixture', '{unknown pending handoff');
  expect(() => f.queue()).toThrow('metadata recovery is incomplete');
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.existsSync(path.join(f.home, 'runner', 'candidates'))).toBe(false);
});

for (const phase of ['placing', 'rollback'] as const) {
  it(`retains an expired ${phase} transaction for rollback when a stale controller resumes`, async () => {
    const f = localFixture('expired-stale-' + phase, sourceFrom);
    const original = fs.readFileSync(f.binaryPath);
    const marker = fs.readFileSync(path.join(f.home, 'install.json'));
    f.queue();
    expect(await f.controller.idle()).toBe('restart');
    const tx = readRunnerUpdateState(f.home).transaction!;
    const candidate = tx.localCandidate!;
    fs.copyFileSync(candidate.binaryPath, f.binaryPath);
    withRunnerUpdateState(f.home, state => {
      state.transaction!.phase = phase;
      state.transaction!.startedAt = -30_000;
      state.transaction!.deadlineAt = 999;
      if (phase === 'rollback') {
        state.transaction!.failureReason = 'interrupted rollback';
        state.transaction!.rollbackResult = 'failed';
      }
    });
    expect(await f.controller.idle()).toBe('hold');
    expect(readRunnerUpdateState(f.home).transaction).toMatchObject({ id: tx.id, phase });
    expect(readRunnerUpdateState(f.home).guardian).toBeDefined();
    expect(fs.existsSync(candidate.binaryPath)).toBe(true);
    expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
    let running = true;
    await runRunnerUpdateHelper(path.join(f.home, 'runner', 'update.json'), {
      now: () => 2000, alive: () => false,
      stop: () => { running = false; }, stopped: () => !running,
      start: () => {
        expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
        running = true;
        return installGuardian();
      },
      probe: (file, version) => strictRunnerReleaseProbe(file, version, 'linux'), removeGuardian,
    });
    expect(fs.readFileSync(f.binaryPath)).toEqual(original);
    expect(fs.readFileSync(path.join(f.home, 'install.json'))).toEqual(marker);
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
    expect(readRunnerUpdateState(f.home).lastResults?.['https://deployment.invalid']?.result).toBe('failed');
  });
}

it('keeps an expired waiting handoff while another publisher holds the installation lease', async () => {
  const f = localFixture('expired-waiting-lease', sourceFrom);
  f.queue();
  expect(await f.controller.idle()).toBe('restart');
  withRunnerUpdateState(f.home, state => { state.transaction!.deadlineAt = 999; });
  const installation = acquireInstallationLease(f.home);
  if (!installation.acquired) throw new Error('fixture installation lease unavailable');
  try {
    expect(await f.controller.idle()).toBe('hold');
    expect(readRunnerUpdateState(f.home).transaction?.phase).toBe('waiting');
  } finally { installation.release(); }
  expect(await f.controller.idle()).toBe('continue');
  expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
});

it('retains rollback authority when a controller with a superseded version sees placing', async () => {
  const f = localFixture('superseded-placing', sourceFrom);
  f.queue();
  expect(await f.controller.idle()).toBe('restart');
  const tx = readRunnerUpdateState(f.home).transaction!;
  fs.copyFileSync(tx.localCandidate!.binaryPath, f.binaryPath);
  withRunnerUpdateState(f.home, state => { state.transaction!.phase = 'placing'; });
  const stale = createRunnerUpdateController({
    home: f.home, serverUrl: 'https://deployment.invalid', binaryPath: f.binaryPath,
    currentVersion: '2.0.0-alpha.9', serviceSpec: tx.serviceSpec, log: () => {},
    deps: { now: () => 1000, installGuardian, removeGuardian },
  });
  expect(await stale.idle()).toBe('continue');
  expect(readRunnerUpdateState(f.home).transaction).toMatchObject({ id: tx.id, phase: 'placing' });
  expect(readRunnerUpdateState(f.home).guardian).toBeDefined();
});
