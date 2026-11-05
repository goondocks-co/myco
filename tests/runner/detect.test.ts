import { runnerAgentLoginReady } from '@goondocks/myco-shared/runner-fleet';
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker } from '@myco/runner/loop.js';
import { detectHarnesses, detectHarnessesAsync, HARNESS_DETECTION_MAX_MS, HARNESS_LOGIN_RECHECK_MS, harnessDetection, offerOf, type DetectedHarness } from '@myco/runner/detect.js';
import { SUSPEND_SLACK_MS } from '@myco/runner/wake.js';
import { FEATURES_HEADER } from '@goondocks/myco-shared/member-protocol';
import { EXECUTION_PROFILE_FEATURE } from '@goondocks/myco-shared/execution-profile';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.js';
import { STUB_PROFILE } from '../helpers/stub-profile-harness.js';

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

async function withProbeFixture(run: (fixture: { root: string; probes: string; running: string }) => Promise<void>, slow = false): Promise<void> {
  const root = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-probe-')));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home); mkdirSync(bin);
  const probes = join(root, 'probes');
  const running = join(root, 'running');
  writeFileSync(join(bin, 'claude'), [
    '#!/bin/sh',
    `printf 'probe\\n' >> ${quote(probes)}`,
    `touch ${quote(running)}`,
    slow ? 'sleep 0.2' : '',
    `rm ${quote(running)}`,
    'exit 0',
  ].join('\n'), { mode: 0o755 });
  const before = { ...process.env };
  Object.assign(process.env, { HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), MYCO_HOME: join(home, '.myco'), PATH: `${bin}:/usr/bin:/bin` });
  try { await run({ root, probes, running }); } finally {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
  }
}

const answer = (body: Record<string, unknown>): Response => Response.json(body, {
  headers: { [FEATURES_HEADER]: EXECUTION_PROFILE_FEATURE },
});

describe('worker login probe cadence', () => {
  it('runs two login probes across a minute of two-second idle polls', async () => {
    await withProbeFixture(async ({ root, probes }) => {
      const stopping = new AbortController();
      let now = 0;
      let claims = 0;
      await runWorker({
        serverUrl: 'https://fixture.invalid', token: 'fixture', lockDir: null, runRoot: join(root, 'runs'),
        only: ['claude-code'], pollIdleMs: 1, signal: stopping.signal, clock: () => now, log: () => {},
        fetchImpl: (async (input) => {
          if (new URL(String(input)).pathname === '/worker/claim') {
            now += 2_000;
            if (++claims === 30) stopping.abort();
          }
          return answer({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 1 });
        }) as typeof fetch,
      });
      expect(claims).toBe(30);
      expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(2);
    });
  });

  it('lets the event loop progress during slow probes, including a fresh probe after a failed claim', async () => {
    await withProbeFixture(async ({ root, probes, running }) => {
      const stopping = new AbortController();
      let claims = 0;
      const progressed = new Set<number>();
      const timer = setInterval(() => {
        if (existsSync(running)) progressed.add(readFileSync(probes, 'utf8').trim().split('\n').length);
      }, 10);
      try {
        await runWorker({
          serverUrl: 'https://fixture.invalid', token: 'fixture', lockDir: null, runRoot: join(root, 'runs'),
          only: ['claude-code'], pollIdleMs: 1, signal: stopping.signal, log: () => {},
          fetchImpl: (async (input) => {
            if (new URL(String(input)).pathname === '/worker/claim') {
              if (++claims === 1) return Response.json({ error: 'unavailable' }, { status: 503 });
              stopping.abort();
            }
            return answer({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 1 });
          }) as typeof fetch,
        });
        expect(claims).toBe(2);
        expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(2);
        expect([...progressed]).toEqual([1, 2]);
      } finally { clearInterval(timer); stopping.abort(); }
    }, true);
  });

  it('expires the offer after a failed run before the next claim', async () => {
    await withProbeFixture(async ({ root, probes }) => {
      const stopping = new AbortController();
      let claims = 0;
      await runWorker({
        serverUrl: 'https://fixture.invalid', token: 'fixture', lockDir: null, runRoot: join(root, 'runs'),
        only: ['claude-code'], pollIdleMs: 1, signal: stopping.signal, log: () => {},
        fetchImpl: (async (input) => {
          if (new URL(String(input)).pathname === '/worker/claim') {
            if (++claims === 1) return answer({ persisted: true, claimed: true, leaseMs: 60_000, heartbeatMs: 30_000,
              run: { id: 'run_probe', projectId: 'proj_fixture', task: 'extract-curate', harness: 'claude-code',
                instruction: null, instructions: null, timeoutSeconds: 60, runToken: 'fixture', credentialEnv: {}, profile: STUB_PROFILE },
            });
            stopping.abort();
          }
          return answer({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 1, ended: true });
        }) as typeof fetch,
      });
      expect(claims).toBe(2);
      expect(readFileSync(probes, 'utf8').trim().split('\n')).toHaveLength(2);
    });
  });

  it('waits for the machine to settle after sleeping during an asynchronous probe', async () => {
    await withProbeFixture(async ({ root, running }) => {
      const stopping = new AbortController();
      const settleMs = 5;
      let now = 0;
      let slept = false;
      let lastProbeTick = 0;
      let claimAt: number | null = null;
      const timer = setInterval(() => {
        if (existsSync(running)) {
          if (!slept) { now += HARNESS_DETECTION_MAX_MS + SUSPEND_SLACK_MS + 1; slept = true; }
          lastProbeTick = now;
        } else if (slept) now += 1;
      }, 2);
      try {
        await runWorker({
          serverUrl: 'https://fixture.invalid', token: 'fixture', lockDir: null, runRoot: join(root, 'runs'),
          only: ['claude-code'], pollIdleMs: 1, signal: stopping.signal, log: () => {}, clock: () => now,
          wakeSettle: { baseMs: settleMs, maxMs: settleMs },
          fetchImpl: (async (input) => {
            if (new URL(String(input)).pathname === '/worker/claim') { claimAt = now; stopping.abort(); }
            return answer({ persisted: true, claimed: false, reason: 'no_work', pollAfterMs: 1 });
          }) as typeof fetch,
        });
        expect(slept).toBe(true);
        expect(claimAt).not.toBeNull();
        expect(claimAt! - lastProbeTick).toBeGreaterThanOrEqual(settleMs);
      } finally { clearInterval(timer); stopping.abort(); }
    }, true);
  });
});

describe('worker detection snapshots', () => {
  const detected: DetectedHarness[] = [{ id: 'claude-code', installed: true, authenticated: true }];

  it('coalesces concurrent reads and refreshes at the thirty-second boundary', async () => {
    let now = 0;
    let probes = 0;
    const detection = harnessDetection({ clock: () => now, detect: async () => { probes += 1; return detected; } });
    expect(await Promise.all([detection.read(), detection.read()])).toEqual([detected, detected]);
    expect(probes).toBe(1);
    now = 29_999;
    expect(await detection.read()).toEqual(detected);
    expect(probes).toBe(1);
    now = 30_000;
    expect(await Promise.all([detection.read(), detection.read()])).toEqual([detected, detected]);
    expect(probes).toBe(2);
  });

  it('refuses an in-flight snapshot invalidated before its probe settles', async () => {
    const oldProbe = Promise.withResolvers<DetectedHarness[]>();
    const newProbe = Promise.withResolvers<DetectedHarness[]>();
    const refreshed = [{ id: 'claude-code', installed: true, authenticated: false }];
    let probes = 0;
    const detection = harnessDetection({ clock: () => 0, detect: () => ++probes === 1 ? oldProbe.promise : newProbe.promise });
    const firstRead = detection.read();
    detection.invalidate();
    const nextRead = detection.read();
    oldProbe.resolve(detected);
    newProbe.resolve(refreshed);
    expect(await Promise.all([firstRead, nextRead])).toEqual([refreshed, refreshed]);
    expect(await detection.read()).toEqual(refreshed);
    expect(probes).toBe(2);
  });

  it('propagates probe failures and retries instead of caching an empty offer', async () => {
    let probes = 0;
    const detection = harnessDetection({ clock: () => 0, detect: async () => {
      if (++probes === 1) throw new Error('fixture probe failed');
      return detected;
    } });
    await expect(detection.read()).rejects.toThrow('fixture probe failed');
    expect(await detection.read()).toEqual(detected);
    expect(probes).toBe(2);
  });
});

it('reports absent and signed-out agents while stored sign-in admits only installed agents', () => {
  const { offered } = offerOf([
    { id: 'claude-code', installed: true, authenticated: false },
    { id: 'codex', installed: false, authenticated: false },
  ]);
  expect(offered.map(offer => ({ id: offer.id, installed: offer.installed, authenticated: offer.authenticated })))
    .toEqual([{ id: 'claude-code', installed: true, authenticated: false }, { id: 'codex', installed: false, authenticated: false }]);
  expect(runnerAgentLoginReady(offered[0]!, { 'claude-code': 'stored' })).toBe(true);
  expect(runnerAgentLoginReady(offered[1]!, { codex: 'stored' })).toBe(false);
});

it('a failing command probe is not rescued by a credential file in either detection mode', async () => {
  await withProbeFixture(async ({ root }) => {
    const claude = join(process.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
    mkdirSync(process.env.CLAUDE_CONFIG_DIR!, { recursive: true });
    writeFileSync(claude, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-only' } }));
    writeFileSync(join(root, 'bin', 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(detectHarnesses(['claude-code'])).toEqual([{ id: 'claude-code', installed: true, authenticated: false }]);
    for (const credentialBytes of [true, false]) expect(await detectHarnessesAsync(['claude-code'], undefined, { credentialBytes }))
      .toEqual([{ id: 'claude-code', installed: true, authenticated: false }]);
  });
});

it('holds only the failed harness through invalidation and failed rechecks', async () => {
  let now = 0;
  let authenticated = true;
  const exclusions: string[][] = [];
  const detection = harnessDetection({ clock: () => now, detect: async excluded => {
    exclusions.push([...excluded]);
    return ['claude-code', 'codex'].filter(id => !excluded.includes(id)).map(id => ({ id, installed: true, authenticated }));
  } });
  await detection.read();
  detection.loginMissing('claude-code');
  detection.invalidate();
  expect(await detection.read()).toContainEqual({ id: 'claude-code', installed: true, authenticated: false, unavailableReason: 'login_missing' });
  expect(exclusions.at(-1)).toEqual(['claude-code']);
  now = HARNESS_LOGIN_RECHECK_MS;
  authenticated = false;
  expect((await detection.read()).find(h => h.id === 'claude-code')?.unavailableReason).toBe('login_missing');
  authenticated = true;
  now += 30_000;
  detection.invalidate();
  expect((await detection.read()).find(h => h.id === 'claude-code')?.authenticated).toBe(false);
  now += HARNESS_LOGIN_RECHECK_MS;
  expect((await detection.read()).find(h => h.id === 'claude-code')).toEqual({ id: 'claude-code', installed: true, authenticated: true });
});

it('probes sign-in with the launch environment exclusions declared by the harness', async () => {
  await withProbeFixture(async ({ root }) => {
    const before = process.env.CLAUDE_CODE_USE_VERTEX;
    process.env.CLAUDE_CODE_USE_VERTEX = 'fixture-provider-override';
    writeFileSync(join(root, 'bin', 'claude'), '#!/bin/sh\ntest -z "$CLAUDE_CODE_USE_VERTEX"\n', { mode: 0o755 });
    try {
      expect(detectHarnesses(['claude-code'])).toEqual([{ id: 'claude-code', installed: true, authenticated: true }]);
      expect(await detectHarnessesAsync(['claude-code'])).toEqual([{ id: 'claude-code', installed: true, authenticated: true }]);
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CODE_USE_VERTEX;
      else process.env.CLAUDE_CODE_USE_VERTEX = before;
    }
  });
});

it('releases stored-sign-in holds on schedule even without a local login', async () => {
  let now = 0;
  let probes = 0;
  const detection = harnessDetection({ clock: () => now, detect: async excluded => {
    if (excluded.includes('claude-code')) return [];
    probes++;
    return [{ id: 'claude-code', installed: true, authenticated: false }];
  } });
  const stored = { 'claude-code': 'stored' as const };
  const offer = async () => offerOf(await detection.read()).offered[0]!;
  expect(runnerAgentLoginReady(await offer(), stored)).toBe(true);
  for (let recheck = 0; recheck < 20; recheck++) {
    detection.loginMissing('claude-code', 'stored');
    const held = await offer();
    expect(runnerAgentLoginReady(held, stored)).toBe(false);
    expect(held.signInFailure).toMatchObject({ name: 'Claude Code', source: 'stored' });
    expect(held.signInFailure?.hint).toContain('Deployment Settings');
    expect(held.signInFailure?.hint).not.toContain('GUI Terminal');
    for (let poll = 0; poll < 10; poll++) {
      detection.invalidate();
      expect(runnerAgentLoginReady(await offer(), stored)).toBe(false);
      expect(probes).toBe(recheck + 1);
    }
    now += HARNESS_LOGIN_RECHECK_MS + 1;
    detection.invalidate();
    const recovered = await offer();
    expect(recovered.authenticated).toBe(false);
    expect(recovered.unavailableReason).toBeUndefined();
    expect(runnerAgentLoginReady(recovered, stored)).toBe(true);
  }
  expect(probes).toBe(21);
});

it('reports the failed agent’s display name and its own manifest sign-in hint', () => {
  const { offered } = offerOf([
    { id: 'claude-code', installed: true, authenticated: false, unavailableReason: 'login_missing' },
    { id: 'codex', installed: true, authenticated: false, unavailableReason: 'login_missing' },
  ]);
  expect(offered[0]?.signInFailure?.name).toBe('Claude Code');
  expect(offered[1]?.signInFailure).toEqual({ name: 'Codex', source: 'own', hint: 'Run codex login on this runner.' });
  expect(offered[1]?.signInFailure?.hint).not.toContain('claude');
});
