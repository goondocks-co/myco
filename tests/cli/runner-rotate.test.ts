/**
 * Runner credential rotation: the successor is written to the record before it
 * is sent, a lost reply is retried with the same candidate, and one process at a
 * time sends.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/runner.js';
import { publishRunnerRecord, readRunnerRecord, RUNNER_RECORD_VERSION, withRunnerLock, type RunnerRecord } from '@myco/runner/runner-registry.js';
import { rotateRunnerCredential, runnerRenewer } from '@myco/runner/runner-rotation.js';

const SERVER = 'https://myco.example.com';
const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const FIRST = `mycorun_${'a'.repeat(43)}`;
const BEARER = /^mycorun_[A-Za-z0-9_-]{43}$/;

interface Call { body: { candidate?: string }; authorization: string | null }

describe('runner credential rotation', () => {
  let home: string;
  let calls: Call[];

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-rotate-'));
    calls = [];
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  const seed = async (over: Partial<RunnerRecord> = {}): Promise<void> => {
    fs.rmSync(path.join(home, 'runner'), { recursive: true, force: true });
    const record: RunnerRecord = {
      version: RUNNER_RECORD_VERSION, serverUrl: SERVER, name: 'box', runnerId: 'run_1', deploymentId: 'dep_1', token: FIRST, tokenId: 'rc_0',
      tokenExpiresAt: NOW + DAY_MS, refreshAfter: NOW - 1000, ...over,
    };
    await withRunnerLock(SERVER, (lock) => publishRunnerRecord(lock, record), home);
  };
  const rotatingFetch = (handler: (call: Call) => Response | Promise<Response>): typeof fetch =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/runners/rotate');
      const call = { body: await request.json() as Call['body'], authorization: request.headers.get('authorization') };
      calls.push(call);
      return handler(call);
    }) as typeof fetch;
  const rotated = (n: number): Response => Response.json({ persisted: true, rotated: true, credentialId: `rc_${n}`, expiresAt: NOW + 7 * DAY_MS, refreshAfter: NOW + 5 * DAY_MS });
  const opts = (fetchImpl: typeof fetch, extra = {}) => ({ mycoHome: home, fetch: fetchImpl, now: () => NOW, ...extra });

  it('writes the candidate to the record before sending it, presents the current token, and swaps on success', async () => {
    await seed();
    let pendingAtSend: RunnerRecord['pending'];
    const fetchImpl = rotatingFetch((call) => {
      pendingAtSend = readRunnerRecord(SERVER, home)!.pending;
      expect(call.authorization).toBe(`Bearer ${FIRST}`);
      return rotated(1);
    });
    const report = await rotateRunnerCredential(SERVER, opts(fetchImpl));
    const candidate = calls[0]!.body.candidate!;
    expect(candidate).toMatch(BEARER);
    expect(pendingAtSend).toMatchObject({ kind: 'rotate', candidate, predecessorTokenId: 'rc_0' });
    expect(report.status).toBe('refreshed');
    const record = readRunnerRecord(SERVER, home)!;
    expect(record).toMatchObject({ token: candidate, tokenId: 'rc_1', tokenExpiresAt: NOW + 7 * DAY_MS, refreshAfter: NOW + 5 * DAY_MS });
    expect(record.pending).toBeUndefined();
  });

  it('sends nothing before the window opens, unless forced', async () => {
    await seed({ refreshAfter: NOW + DAY_MS });
    const fetchImpl = rotatingFetch(() => rotated(1));
    expect((await rotateRunnerCredential(SERVER, opts(fetchImpl))).status).toBe('not-due');
    expect(calls).toEqual([]);
    expect((await rotateRunnerCredential(SERVER, opts(fetchImpl, { force: true }))).status).toBe('refreshed');
    expect(calls).toHaveLength(1);
  });

  it('retries a lost reply with the same candidate, then swaps', async () => {
    await seed();
    let attempt = 0;
    const fetchImpl = rotatingFetch(() => {
      attempt += 1;
      if (attempt === 1) throw new TypeError('connection lost');
      return rotated(1);
    });
    const first = await rotateRunnerCredential(SERVER, opts(fetchImpl));
    expect(first.status).toBe('retry');
    const kept = readRunnerRecord(SERVER, home)!;
    expect(kept.token).toBe(FIRST);
    expect(kept.pending).toMatchObject({ kind: 'rotate', candidate: calls[0]!.body.candidate });

    // The window is not open, yet the unconfirmed candidate is still sent.
    await seed({ refreshAfter: NOW + DAY_MS, pending: kept.pending });
    const second = await rotateRunnerCredential(SERVER, opts(fetchImpl));
    expect(second.status).toBe('refreshed');
    expect(calls[1]!.body.candidate).toBe(calls[0]!.body.candidate);
    expect(readRunnerRecord(SERVER, home)).toMatchObject({ token: calls[0]!.body.candidate });
  });

  it('records the instant a too-early answer names and drops the candidate', async () => {
    await seed();
    const opens = NOW + 3 * DAY_MS;
    const fetchImpl = rotatingFetch(() => Response.json({ persisted: true, rotated: false, code: 'refresh_too_early', refreshAfter: opens }));
    const report = await rotateRunnerCredential(SERVER, opts(fetchImpl));
    expect(report.status).toBe('too-early');
    const record = readRunnerRecord(SERVER, home)!;
    expect(record).toMatchObject({ token: FIRST, refreshAfter: opens });
    expect(record.pending).toBeUndefined();
  });

  it('prints the instant when the rotate verb is told it is too early', async () => {
    await seed();
    const opens = NOW + 3 * DAY_MS;
    const out: string[] = [];
    const fetchImpl = rotatingFetch(() => Response.json({ persisted: true, rotated: false, code: 'refresh_too_early', refreshAfter: opens }));
    expect(await run(['rotate'], { fetch: fetchImpl, mycoHome: home, now: () => NOW, stdout: (l) => out.push(l) })).toBe(true);
    expect(out.join('\n')).toContain(new Date(opens).toISOString());
  });

  it('reports lineage_expired as terminal and drops the candidate', async () => {
    await seed();
    const fetchImpl = rotatingFetch(() => Response.json({ persisted: false, code: 'lineage_expired', reason: 'idle too long' }));
    const report = await rotateRunnerCredential(SERVER, opts(fetchImpl));
    expect(report.status).toBe('lineage-expired');
    expect(readRunnerRecord(SERVER, home)!.pending).toBeUndefined();
    const err: string[] = [];
    await seed();
    expect(await run(['rotate'], { fetch: fetchImpl, mycoHome: home, now: () => NOW, stdout: () => {}, stderr: (l) => err.push(l) })).toBe(false);
    expect(err.join('\n')).toContain('--replace');
  });

  it('reports a refused bearer as unauthorized and keeps the record for the person to replace', async () => {
    await seed();
    const fetchImpl = rotatingFetch(() => new Response('{}', { status: 401 }));
    const report = await rotateRunnerCredential(SERVER, opts(fetchImpl));
    expect(report.status).toBe('unauthorized');
    expect(readRunnerRecord(SERVER, home)).toMatchObject({ token: FIRST });
  });

  it('never prints or logs a bearer', async () => {
    await seed();
    const out: string[] = [];
    const err: string[] = [];
    const fetchImpl = rotatingFetch(() => rotated(1));
    expect(await run(['rotate'], { fetch: fetchImpl, mycoHome: home, now: () => NOW, stdout: (l) => out.push(l), stderr: (l) => err.push(l) })).toBe(true);
    const everything = [...out, ...err].join('\n');
    expect(everything).not.toContain(FIRST);
    expect(everything).not.toContain(calls[0]!.body.candidate!);
  });

  it('sends one candidate when two renewals run at once', async () => {
    await seed();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = rotatingFetch(async () => { await gate; return rotated(1); });
    const first = rotateRunnerCredential(SERVER, opts(fetchImpl));
    const second = rotateRunnerCredential(SERVER, opts(fetchImpl));
    await Bun.sleep(50);
    release();
    const statuses = [(await first).status, (await second).status].sort();
    expect(statuses).toEqual(['busy', 'refreshed']);
    expect(calls).toHaveLength(1);
  });

  it('lets the loop renew through the same path and stays quiet after an unreachable Deployment', async () => {
    await seed();
    let clock = NOW;
    const fetchImpl = rotatingFetch(() => { throw new TypeError('connection lost'); });
    const lines: string[] = [];
    const renew = runnerRenewer(SERVER, { mycoHome: home, fetch: fetchImpl, now: () => clock, notify: (l) => lines.push(l) });
    expect(await renew(false)).toBe('retry');
    expect(await renew(false)).toBe('not-due');
    expect(calls).toHaveLength(1);
    expect(await renew(true)).toBe('retry');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.candidate).toBe(calls[0]!.body.candidate);
    clock += 60_000;
    expect(await renew(false)).toBe('retry');
    expect(calls).toHaveLength(3);
    expect(lines.join('\n')).not.toContain(FIRST);
  });
});
