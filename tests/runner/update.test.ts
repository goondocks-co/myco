import { afterAll, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRunnerUpdateController, readRunnerUpdateState, strictRunnerReleaseProbe, withRunnerUpdateState } from '../../packages/myco/src/runner/update.js';
import { runRunnerUpdateHelper } from '../../packages/myco/src/runner/update-helper.js';
import { writeInstallMarker, versionBinaryPath } from '../../packages/myco/src/install/managed-binary.js';
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
