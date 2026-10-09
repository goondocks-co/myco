import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRunnerUpdateController, readRunnerUpdateState, withRunnerUpdateState, type RunnerUpdateDeps } from '@myco/runner/update.js';
import { writeInstallMarker, versionBinaryPath } from '@myco/install/managed-binary.js';
import { renderUnit, servicePaths, type ServiceSpec } from '@myco/server/service.js';
import { runWorker } from '@myco/runner/loop.js';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-availability-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const from = '2.0.0-alpha.2', to = '2.0.0-alpha.3', serverUrl = 'https://availability.invalid';
function fixture(name: string, overrides: RunnerUpdateDeps = {}) {
  const home = path.join(root, name), binaryPath = path.join(home, 'bin', 'myco');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, `#!/bin/sh\nprintf '%s\\n' '${from}'\n`, { mode: 0o755 });
  writeInstallMarker(home, { channel: 'alpha', source: 'curl', bin: binaryPath });
  const spec: ServiceSpec = { binaryPath, home, pathEnv: '', logDir: home, env: { MYCO_HOME: home },
    unit: { label: 'fixture', unitName: 'fixture', description: 'fixture', args: ['runner', 'run'], logName: 'fixture', restartDelaySeconds: 1 } };
  const time = { now: 1000 }, logs: string[] = [], headers: Headers[] = [];
  const asset = 'myco-darwin-arm64';
  const controller = createRunnerUpdateController({ home, binaryPath, serverUrl, currentVersion: from, serviceSpec: spec,
    log: line => logs.push(line), deps: { now: () => time.now, random: () => 0, serviceInstalled: () => true,
      targetTriple: () => 'darwin-arm64',
      fetch: (async (_url, init) => { const h = new Headers(init?.headers); headers.push(h);
        return h.has('if-none-match') ? new Response(null, { status: 304 }) : Response.json([{ tag_name: `myco/v${to}`, prerelease: true,
          assets: [{ name: asset, browser_download_url: 'https://fixture.invalid/binary' }, { name: 'SHA256SUMS', browser_download_url: 'https://fixture.invalid/sums' }] }], { headers: { etag: 'fixture-etag' } }); }) as typeof fetch,
      stage: async () => { const file = versionBinaryPath(home, process.platform, to); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `#!/bin/sh\ncase "$1" in --version) printf '%s\\n' '${to}' ;; *) exit 23 ;; esac\n`, { mode: 0o755 });
        return { versionDir: path.dirname(file), version: to }; },
      probe: () => ({ runs: true }), installGuardian: () => ({ unitFile: 'fixture', loaded: true, running: true, changed: true }), removeGuardian: () => {},
      ...overrides,
    } });
  return { home, binaryPath, controller, time, logs, headers };
}

async function claimsWork(f: ReturnType<typeof fixture>) {
  const stopping = new AbortController();
  let claims = 0, contacts = 0;
  f.controller.startup();
  await runWorker({ serverUrl, token: 'fixture', lockDir: null, runRoot: path.join(f.home, 'runs'), only: [], signal: stopping.signal,
    pollIdleMs: 1, log: () => {}, contactBody: () => ({ update: f.controller.contactPayload() }),
    onContact: async body => f.controller.onContact(body), onIdle: async () => { const result = await f.controller.idle(); return result === 'continue' ? undefined : result; },
    fetchImpl: (async input => { if (new URL(String(input)).pathname === '/worker/claim') { claims++; stopping.abort(); }
      else if (++contacts > 3) stopping.abort();
      return Response.json({ persisted: true, claimed: false, updateRequest: null }, { headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE } }); }) as typeof fetch,
  });
  expect(claims).toBe(1);
}

describe('runner update execution availability', () => {
  for (const [label, contents] of [['forward', JSON.stringify({ version: 2 })], ['corrupt', '{broken'],
    ['attempts', JSON.stringify({ version: 1, nextCheckAt: 0, lastCheckAt: null, latestVersion: null, failures: 0, attempts: 5 })],
    ['blocks', JSON.stringify({ version: 1, nextCheckAt: 0, lastCheckAt: null, latestVersion: null, failures: 0, blockedVersions: { bad: {} } })]] as const) {
    it(`quarantines ${label} metadata, reports it, and continues claiming`, async () => {
      const f = fixture(label);
      fs.mkdirSync(path.join(f.home, 'runner'), { recursive: true });
      fs.writeFileSync(path.join(f.home, 'runner', 'update.json'), contents);
      await claimsWork(f);
      expect(f.controller.contactPayload().lastResult).toMatchObject({ result: 'failed' });
      expect(fs.readdirSync(path.join(f.home, 'runner')).some(name => name.startsWith('update.json.quarantine-'))).toBe(true);
      expect(f.logs.some(line => /metadata|record/i.test(line))).toBe(true);
    });
  }

  it('abandons a stuck helper by its hard deadline and resumes claiming', async () => {
    const f = fixture('deadline');
    expect(await f.controller.idle()).toBe('restart');
    f.time.now += 30 * 60_000;
    await claimsWork(f);
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
    expect(f.controller.contactPayload().lastResult).toMatchObject({ result: 'failed', toVersion: to });
  });

  it('reports a helper nonzero start through the service stub and keeps claiming', async () => {
    const f = fixture('helper-exit', { installGuardian: () => ({ unitFile: 'fixture', loaded: true, running: false, changed: true, detail: 'helper exited 23' }) });
    await claimsWork(f);
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
    expect(f.controller.contactPayload().lastResult).toMatchObject({ result: 'failed', reason: expect.stringContaining('helper exited 23') });
  });

  it('reports cleanup failure with backoff while continuing to claim', async () => {
    let removals = 0;
    const f = fixture('cleanup', { removeGuardian: () => { removals++; throw new Error('versions folder cannot be pruned'); } });
    expect(await f.controller.idle()).toBe('restart');
    withRunnerUpdateState(f.home, state => { delete state.transaction; state.cleanup = { failedVersion: to, currentVersion: from, platform: process.platform }; });
    await claimsWork(f);
    expect(f.controller.contactPayload().lastResult?.reason).toContain('cleanup');
    await f.controller.idle();
    expect(removals).toBe(1);
  });

  it('backs off refused versions exponentially, retains the ETag and attempt identity', async () => {
    let stages = 0;
    const f = fixture('backoff', { stage: async () => { stages++; return { error: 'unsigned candidate' }; } });
    expect(await f.controller.idle()).toBe('continue');
    const first = f.controller.contactPayload().lastResult;
    f.time.now += 60 * 60_000;
    await f.controller.idle();
    expect(stages).toBe(2);
    expect(f.headers[1]?.get('if-none-match')).toBe('fixture-etag');
    expect(readRunnerUpdateState(f.home).nextCheckAt - f.time.now).toBe(2 * 60 * 60_000);
    expect(first?.attemptId).toBeString();
    expect(f.controller.contactPayload().lastResult?.attemptId).toBe(first?.attemptId);
    f.time.now += 60 * 60_000;
    await f.controller.idle();
    expect(stages).toBe(2);
  });

  it('reports unprunable version slots without holding execution or retrying every idle tick', async () => {
    let prunes = 0;
    const f = fixture('prune', { prune: () => { prunes++; } });
    for (const version of [from, to, '2.0.0-alpha.1']) fs.mkdirSync(path.dirname(versionBinaryPath(f.home, process.platform, version)), { recursive: true });
    withRunnerUpdateState(f.home, state => { state.cleanup = { currentVersion: from, platform: process.platform }; });
    await claimsWork(f);
    expect(prunes).toBe(1);
    expect(f.controller.contactPayload()).toMatchObject({ lastResult: { result: 'failed' }, updateState: { phase: 'cleanup_pending' } });
    await f.controller.idle();
    expect(prunes).toBe(1);
  });

  it('lets unexpected staging errors fail open and reports the failure', async () => {
    const f = fixture('stage-throws', { stage: async () => { throw new Error('unexpected stage IO error'); } });
    await claimsWork(f);
    expect(f.controller.contactPayload().lastResult).toMatchObject({ result: 'failed', reason: expect.stringContaining('stage IO error') });
    withRunnerUpdateState(f.home, state => { state.lastResults![serverUrl] = { fromVersion: from, toVersion: to, result: 'updated', at: f.time.now + 1 }; });
    expect(f.controller.contactPayload().lastResult?.result).toBe('updated');
  });

  for (const clear of ['expiry', 'manual', 'dashboard'] as const) it(`retries an expiring block through ${clear}`, async () => {
    let stages = 0;
    const f = fixture(`clear-${clear}`, { stage: async () => { stages++; return { error: 'candidate refused' }; } });
    withRunnerUpdateState(f.home, state => { state.blockedVersions = { [to]: { until: f.time.now + 24 * 60 * 60_000, reason: 'crashed' } }; });
    await f.controller.idle();
    expect(stages).toBe(0);
    expect(f.controller.contactPayload().blockedVersion?.version).toBe(to);
    if (clear === 'expiry') f.time.now += 24 * 60 * 60_000;
    else if (clear === 'manual') f.controller.queueManual();
    else f.controller.onContact({ updateRequest: { id: 'retry-block', requestedAt: f.time.now, clearBlock: true } });
    await f.controller.idle();
    expect(stages).toBe(1);
    expect(f.controller.contactPayload().blockedVersion).toBeUndefined();
    expect(f.controller.contactPayload().lastResult?.result).toBe('refused');
  });

  it('drops the conditional release cache when the install channel changes', async () => {
    const f = fixture('channel-cache', { stage: async () => ({ error: 'refused alpha' }) });
    await f.controller.idle();
    writeInstallMarker(f.home, { channel: 'stable', source: 'curl', bin: f.binaryPath });
    f.time.now += 60 * 60_000;
    await f.controller.idle();
    expect(f.headers[1]?.has('if-none-match')).toBe(false);
    expect(f.controller.contactPayload().latestVersion).toBeNull();
  });

  for (const operation of ['idle-success', 'idle-failure', 'check', 'stage-refusal'] as const) it(`preserves a manual request arriving during ${operation}`, async () => {
    let arrived: () => void = () => {};
    let stages = 0, queued = false;
    const f = fixture(`arrival-${operation}`, operation === 'stage-refusal' ? { stage: async () => { stages++; arrived(); return { error: 'stage refused' }; } }
      : { fetch: (async _url => { arrived(); return operation === 'idle-failure' ? new Response(null, { status: 503 }) : Response.json([]); }) as typeof fetch });
    arrived = () => { if (!queued) { queued = true; f.controller.queueManual(); } };
    if (operation === 'check') await f.controller.check(); else await f.controller.idle();
    expect(readRunnerUpdateState(f.home).nextCheckAt).toBe(0);
    expect(readRunnerUpdateState(f.home).requests?.[serverUrl]?.manual).toBe(true);
    if (operation === 'stage-refusal') {
      const requestId = readRunnerUpdateState(f.home).requests?.[serverUrl]?.id;
      await f.controller.idle();
      expect(stages).toBe(2);
      expect(f.controller.contactPayload().lastResult?.requestId).toBe(requestId);
    }
  });

  it('uses a one-shot guardian copied from the trusted current binary', async () => {
    const f = fixture('trusted', { probe: (_file, version) => version === from ? { runs: false, detail: 'strict current signature rejected' } : { runs: true } });
    expect(await f.controller.idle()).toBe('restart');
    const guardian = readRunnerUpdateState(f.home).guardian!;
    expect(guardian.binaryPath).toBe(path.join(f.home, 'runner', 'guardian', process.platform === 'win32' ? 'myco.exe' : 'myco'));
    expect(fs.readFileSync(guardian.binaryPath)).toEqual(fs.readFileSync(f.binaryPath));
    const candidate = versionBinaryPath(f.home, process.platform, to);
    expect(spawnSync(candidate, ['runner', '__apply-update'], { cwd: f.home, env: process.env }).status).toBe(23);
    expect(guardian.unit).toHaveProperty('restart', 'never');
    expect(renderUnit(guardian, servicePaths(guardian, 'darwin'), 'darwin')).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(renderUnit(guardian, servicePaths(guardian, 'linux'), 'linux')).toContain('Restart=no');
    expect(renderUnit(guardian, servicePaths(guardian, 'win32'), 'win32')).not.toContain('<RestartOnFailure>');
  });

  it('only accepts health refusal from the installed transaction program', async () => {
    const f = fixture('refusal-owner');
    expect(await f.controller.idle()).toBe('restart');
    const tx = readRunnerUpdateState(f.home).transaction!;
    const otherPath = path.join(f.home, 'other', 'myco');
    const other = createRunnerUpdateController({ home: f.home, serverUrl, binaryPath: otherPath, currentVersion: to,
      serviceSpec: { ...tx.serviceSpec, binaryPath: otherPath }, log: () => {} });
    other.recordHealthRefusal('foreign program refused');
    expect(readRunnerUpdateState(f.home).transaction?.healthRefusal).toBeUndefined();
    const installed = createRunnerUpdateController({ home: f.home, serverUrl, binaryPath: f.binaryPath, currentVersion: to,
      serviceSpec: tx.serviceSpec, log: () => {} });
    installed.recordHealthRefusal('installed program refused');
    expect(readRunnerUpdateState(f.home).transaction?.healthRefusal).toBe('installed program refused');
  });

  it('supersedes a stale handoff after another installed version takes over and resumes claiming', async () => {
    const f = fixture('superseded');
    expect(await f.controller.idle()).toBe('restart');
    const tx = readRunnerUpdateState(f.home).transaction!;
    const currentVersion = '2.0.0-alpha.4';
    fs.writeFileSync(f.binaryPath, `#!/bin/sh\nprintf '%s\\n' '${currentVersion}'\n`);
    const installed = createRunnerUpdateController({ home: f.home, serverUrl, binaryPath: f.binaryPath, currentVersion,
      serviceSpec: tx.serviceSpec, log: () => {}, deps: { now: () => f.time.now, removeGuardian: () => {} } });
    await claimsWork({ ...f, controller: installed });
    expect(readRunnerUpdateState(f.home).transaction).toBeUndefined();
    expect(installed.contactPayload().lastResult).toMatchObject({ result: 'failed', reason: expect.stringContaining('superseded') });
    expect(readRunnerUpdateState(f.home).blockedVersions?.[to]).toBeUndefined();
    expect(fs.readFileSync(f.binaryPath, 'utf8')).toContain(currentVersion);
  });

  it('keeps a foreground program from holding or abandoning the installed handoff', async () => {
    const f = fixture('foreground-handoff');
    expect(await f.controller.idle()).toBe('restart');
    const tx = readRunnerUpdateState(f.home).transaction!;
    const otherPath = path.join(f.home, 'other-program', 'myco');
    const foreground = createRunnerUpdateController({ home: f.home, serverUrl, binaryPath: otherPath, currentVersion: from,
      serviceSpec: { ...tx.serviceSpec, binaryPath: otherPath }, log: () => {}, deps: { now: () => f.time.now } });
    await claimsWork({ ...f, controller: foreground });
    f.time.now += 30 * 60_000;
    await claimsWork({ ...f, controller: foreground });
    expect(readRunnerUpdateState(f.home).transaction?.id).toBe(tx.id);
    expect(readRunnerUpdateState(f.home).lastResults?.[serverUrl]).toBeUndefined();
  });
});
