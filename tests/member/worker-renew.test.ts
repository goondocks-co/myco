/**
 * A worker renews the credential it runs under the way a hook does: before a
 * request once the refresh window is open, and once after the Deployment
 * refuses it, before that refusal is taken as final. Driven through the
 * worker's own attach options against the real server pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { attachOptions } from '@myco/cli/worker.js';
import { acquireRegistryLock, readDeploymentMembership, writeDeploymentMembership } from '@myco/member/registry.js';
import { probeWorkerAdmission, RENEW_BUSY_WAIT_MS } from '@myco/runner/loop.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.ts';
import { tempMycoHome } from './helpers/server.js';

const SERVER_URL = 'https://deployment.example';
const DAY_MS = 24 * 60 * 60 * 1000;

let mycoHome: string;
const savedHome = process.env.MYCO_HOME;
beforeEach(() => { mycoHome = tempMycoHome(); process.env.MYCO_HOME = mycoHome; });
afterEach(() => { process.env.MYCO_HOME = savedHome; });

async function deployment(issuedAt: number) {
  const e = sqliteEnv();
  const server = createServer({ now: () => Date.now(), sourceOf: () => '1.2.3.4', fetchImpl: (input, init) => fetch(input, init) });
  const paths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(typeof input === 'string' || input instanceof URL ? String(input) : input.url, init);
    paths.push(new URL(req.url).pathname);
    return server.handleRequest(req, e.serverEnv);
  }) as unknown as typeof fetch;
  await ensureMember(e.db, 'mem_admin', issuedAt, 'admin', 'mem_admin');
  const issued = await issueMemberToken(e.db, { memberId: 'mem_admin', machineId: 'machine_1' }, issuedAt);
  writeDeploymentMembership({ serverUrl: SERVER_URL, token: issued.token, tokenId: issued.tokenId, expiresAt: issued.expiresAt, machineId: 'machine_1', joinedAt: issuedAt, updatedAt: issuedAt }, { mycoHome });
  const ask = () => probeWorkerAdmission({ ...attachOptions(SERVER_URL, mycoHome, fetchImpl), fetchImpl, signal: AbortSignal.timeout(5_000) });
  return { e, issued, paths, ask };
}

describe('a worker\'s credential', () => {
  it('renews before a request once its window is open, and asks nothing while it is not', async () => {
    const d = await deployment(Date.now() - MEMBER_TOKEN_TTL_MS + DAY_MS);
    expect(await d.ask()).toBe('admitted');
    expect(d.paths).toEqual(['/tokens/refresh', '/worker/lease']);
    const renewed = readDeploymentMembership(SERVER_URL, mycoHome)!;
    expect(renewed.token).not.toBe(d.issued.token);
    d.paths.length = 0;
    expect(await d.ask()).toBe('admitted');
    expect(d.paths).toEqual(['/worker/lease']);
  });

  it('renews a credential that lapsed with the worker stopped, and is admitted on it', async () => {
    const d = await deployment(Date.now() - 20 * DAY_MS);
    expect(await d.ask()).toBe('admitted');
    expect(d.paths.filter((p) => p === '/tokens/refresh')).toHaveLength(1);
    expect(readDeploymentMembership(SERVER_URL, mycoHome)!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('asks once more after a refusal, and takes a refusal the renewal confirms as final without asking again', async () => {
    const d = await deployment(Date.now());
    d.e.sqlite.query('UPDATE member_credentials SET revoked_at = ? WHERE id = ?').run(Date.now(), d.issued.tokenId);
    expect(await d.ask()).toBe('unauthorized');
    expect(d.paths).toEqual(['/worker/lease', '/tokens/refresh']);
    expect(readDeploymentMembership(SERVER_URL, mycoHome)!.refreshTerminal).toBe(true);
    d.paths.length = 0;
    expect(await d.ask()).toBe('unauthorized');
    expect(d.paths).toEqual(['/worker/lease']);
  });

  it('waits on a registry another process holds rather than ending: once it is free, the lapsed credential rotates and the worker is admitted', async () => {
    const d = await deployment(Date.now() - 20 * DAY_MS);
    const lock = acquireRegistryLock(mycoHome);
    if (!lock.acquired) throw new Error('the test could not take the registry lock');
    setTimeout(() => { lock.lock.release(); }, RENEW_BUSY_WAIT_MS * 3);
    expect(await d.ask()).toBe('admitted');
    const held = readDeploymentMembership(SERVER_URL, mycoHome)!;
    expect({ rotated: held.token !== d.issued.token, terminal: held.refreshTerminal }).toEqual({ rotated: true, terminal: undefined });
  });

  it('never takes a registry held the whole time for a refusal: the worker waits, and nothing is recorded as final', async () => {
    const d = await deployment(Date.now() - 20 * DAY_MS);
    const lock = acquireRegistryLock(mycoHome);
    if (!lock.acquired) throw new Error('the test could not take the registry lock');
    try {
      expect(await d.ask()).toBe('unknown');
    } finally {
      lock.lock.release();
    }
    expect(readDeploymentMembership(SERVER_URL, mycoHome)!.refreshTerminal).toBeUndefined();
    expect(await d.ask()).toBe('admitted');
  }, 20_000);
});
