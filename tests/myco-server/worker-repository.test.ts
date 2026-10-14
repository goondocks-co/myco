import { legacyWorker } from './helpers/worker-principal.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { afterEach, describe, expect, it } from 'bun:test';
import { REPOSITORY_CHECKOUT_CAPABILITY, MAX_REPOSITORY_HISTORY_DEPTH, WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { claimNextRun, expireLeases } from '@myco-server-worker/core/harness.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { prepareWorkerRepository } from '@myco-server-worker/core/worker-repository.js';
import { withLeasedRun } from '@myco-server-worker/core/worker-run.js';
import { WORKER_LEASE_MS } from '@myco-server-worker/constants.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { jsonBody } from '../helpers/json-body.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const SOURCE = { url: 'https://example.test/team/source', branch: 'main' };
const CREDENTIAL = { username: 'reader', token: 'synthetic-source-read-credential' };
const CAPABILITIES = [REPOSITORY_CHECKOUT_CAPABILITY];
const OFFERED = [offeredHarness('claude-code')];
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  cleanups.push(() => e.sqlite.close());
  e.env.SECRET_WRAP_KEY = { get: async () => btoa('r'.repeat(32)) };
  const now = Date.now();
  await ensureMember(e.db, 'mem_worker', now, 'admin', 'worker');
  await ensureMember(e.db, 'mem_other', now, 'admin', 'other worker');
  const owner = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, now);
  const other = await issueMemberToken(e.db, { memberId: 'mem_other', machineId: 'm2' }, now);
  const repositories = projectRepositories(e.db, deploymentSecretStore(e.db, e.serverEnv.wrappingKey));
  await repositories.save('proj_1', { ...SOURCE, revision: null, credential: CREDENTIAL }, 'mem_worker', now);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [now]);
  e.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context)
    VALUES ('proj_1','run_seed','myco-agent','vault-seed','queued',?,'worker',?,'{}')`, [now, JSON.stringify({ serverUrl: 'https://s', actor: 'mem_worker' })]);
  const claim = (tokenId = owner.tokenId, at = now, capabilities: readonly string[] = CAPABILITIES) =>
    claimNextRun(e.serverEnv, { principal: legacyWorker(tokenId, 'm1'), now: at, harnesses: OFFERED, capabilities });
  const prepare = (body: Record<string, unknown> = {}, tokenId = owner.tokenId, at = now) =>
    prepareWorkerRepository(e.serverEnv, { worker: legacyWorker(tokenId, 'm1'), clock: () => at }, { projectId: 'proj_1', runId: 'run_seed', body });
  return { e, now, owner, other, repositories, claim, prepare };
}

describe('a worker preparing its claimed source', () => {
  it('withholds an opened result when the lease expires or the attempt changes during preparation', async () => {
    for (const fault of ['expired', 'reclaimed'] as const) {
      const r = await rig();
      await r.claim();
      let now = r.now;
      const prepare = withLeasedRun(async () => {
        if (fault === 'expired') now += WORKER_LEASE_MS + 1;
        else r.e.sqlite.run(`UPDATE agent_runs SET dispatched_by=? WHERE id='run_seed'`, [r.other.tokenId]);
        return { credential: CREDENTIAL };
      });
      expect(await prepare(r.e.serverEnv, { worker: legacyWorker(r.owner.tokenId, 'm1'), clock: () => now }, { projectId: 'proj_1', runId: 'run_seed' }))
        .toEqual({ held: false, reason: 'the lease is no longer held' });
    }
  });

  it('keeps older workers off checkout work and hands a capable worker only the prompt identity', async () => {
    const r = await rig();
    expect(await r.claim(r.owner.tokenId, r.now, [])).toEqual({ claimed: false, reason: 'no_work' });
    const result = await r.claim();
    if (!result.claimed) throw new Error('not claimed');
    expect(result.run.repository).toEqual({ ...SOURCE, historyDepth: MAX_REPOSITORY_HISTORY_DEPTH });
    expect(JSON.stringify(result)).not.toContain(CREDENTIAL.token);
    expect(result.run.instruction).toContain(SOURCE.url);
    const context = r.e.sqlite.query(`SELECT run_context AS context FROM agent_runs WHERE id='run_seed'`).get() as { context: string };
    expect(JSON.parse(context.context).checkout).toEqual(result.run.repository);
    expect(context.context).not.toContain(CREDENTIAL.token);
    const response = await worker.fetch(new Request('https://s/worker/repository', {
      method: 'POST', headers: memberHeaders(r.owner.token), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_seed' }),
    }), r.e.env);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await jsonBody(response)).toEqual({ persisted: true, held: true, repository: { ...SOURCE, credential: CREDENTIAL } });
    const denied = await worker.fetch(new Request('https://s/worker/repository', {
      method: 'POST', headers: memberHeaders(result.run.runToken), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_seed' }),
    }), r.e.env);
    expect(await jsonBody(denied)).toMatchObject({ persisted: false, code: 'run_scope' });
    const legacy = await worker.fetch(new Request('https://s/runs/repository', {
      method: 'POST', headers: memberHeaders(result.run.runToken), body: JSON.stringify({ runId: 'run_seed' }),
    }), r.e.env);
    expect(legacy.status).toBe(401);
    expect(await jsonBody(legacy)).toEqual({ error: 'unauthorized' });
  });

  it('pins once, reuses the first commit, and refuses a reconnected source', async () => {
    const r = await rig();
    await r.claim();
    const first = { ...SOURCE, commit: 'a'.repeat(40) };
    expect(await r.prepare(first)).toEqual({ persisted: true, held: true, pin: first });
    expect(await r.prepare({ ...SOURCE, commit: 'b'.repeat(40) })).toEqual({ persisted: true, held: true, pin: first });
    expect(await r.prepare()).toMatchObject({ repository: { ...SOURCE, commit: first.commit } });
    const connection = await r.repositories.describe('proj_1');
    await r.repositories.save('proj_1', { ...SOURCE, url: 'https://example.test/team/other', revision: connection!.revision, credential: null }, 'mem_worker', r.now + 1);
    expect(await r.prepare()).toEqual({ persisted: true, held: true, error: 'Repository connection changed. Start a new run.' });
  });

  it('refuses other workers, other projects and expired leases before opening credentials', async () => {
    const r = await rig();
    await r.claim();
    expect(await r.prepare({}, r.other.tokenId)).toEqual({ held: false, reason: 'the lease is no longer held' });
    expect(await prepareWorkerRepository(r.e.serverEnv, { worker: legacyWorker(r.owner.tokenId, 'm1'), clock: () => r.now }, { projectId: 'proj_other', runId: 'run_seed', body: {} }))
      .toEqual({ held: false, reason: 'no run of that id' });
    r.e.sqlite.run(`UPDATE agent_runs SET lease_expires_at=? WHERE id='run_seed'`, [r.now - 1]);
    expect(await r.prepare()).toEqual({ held: false, reason: 'the lease is no longer held' });
    await expireLeases(r.e.serverEnv, r.now);
    const reclaimed = await r.claim(r.other.tokenId, r.now + 1);
    expect(reclaimed.claimed).toBe(true);
    expect(await r.prepare({ ...SOURCE, commit: 'c'.repeat(40) })).toEqual({ held: false, reason: 'the lease is no longer held' });
    expect(await r.prepare({}, r.other.tokenId, r.now + 2)).toMatchObject({ held: true, repository: SOURCE });
  });
});

describe('a worker reporting repository preparation failure', () => {
  const end = async (r: Awaited<ReturnType<typeof rig>>, body: Record<string, unknown>, token = r.owner.token) =>
    jsonBody(await worker.fetch(new Request('https://s/worker/end', {
      method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ projectId: 'proj_1', runId: 'run_seed', status: 'failed', error: 'the worker failed while driving the run (repository_unprepared)', ...body }),
    }), r.e.env));

  it('persists a closed reason with sanitized summary under the lease and projects it to runs and work', async () => {
    const r = await rig();
    const claimed = await r.claim();
    expect(claimed.claimed).toBe(true);
    const secret = 'synthetic-repository-secret-999';
    const summary = `fatal: could not fetch https://reader:${secret}@github.com/example/source.git token=${secret}`;
    const body = { repositoryFailure: { code: 'fetch_failed', summary } };
    expect(await end(r, body, r.other.token)).toMatchObject({ persisted: true, ended: false });
    r.e.sqlite.run("UPDATE agent_runs SET lease_expires_at=? WHERE id='run_seed'", [r.now - 1]);
    expect(await end(r, body)).toMatchObject({ persisted: true, ended: false });
    r.e.sqlite.run("UPDATE agent_runs SET lease_expires_at=? WHERE id='run_seed'", [Date.now() + WORKER_LEASE_MS]);
    expect(await end(r, body)).toMatchObject({ persisted: true, ended: true });
    const record = r.e.sqlite.query("SELECT status, error_code, run_context FROM agent_runs WHERE id='run_seed'").get() as { status: string; error_code: string; run_context: string };
    expect(record.status).toBe('failed');
    expect(record.error_code).toBe('repository_unprepared');
    expect(record.run_context).toContain('fetch_failed');
    expect(record.run_context).not.toContain(secret);
    expect(record.run_context).not.toContain('reader:');
    const env = { ...r.e.env, ...OWNER_ENV };
    const headers = { cookie: await ownerCookie(r.e.db), 'cf-connecting-ip': '1.2.3.4' };
    const detail = await jsonBody(await worker.fetch(new Request('https://s/api/projects/proj_1/runs/run_seed', { headers }), env)) as any;
    expect(detail.run.repositoryFailure).toMatchObject({ code: 'fetch_failed', summary: expect.stringContaining('fatal:') });
    expect(JSON.stringify(detail)).not.toContain(secret);
    const work = await jsonBody(await worker.fetch(new Request(`https://s/api/work?since=${r.now - 1000}&until=${r.now + 10_000}`, { headers }), env)) as any;
    expect(work.runs.find((run: any) => run.id === 'run_seed').failure.repositoryFailure).toEqual(detail.run.repositoryFailure);
    expect(JSON.stringify(work)).not.toContain(secret);
  });

  it('accepts an older end without metadata and ignores unknown reasons', async () => {
    for (const repositoryFailure of [undefined, { code: 'unknown_reason', summary: 'private detail' }]) {
      const r = await rig();
      expect((await r.claim()).claimed).toBe(true);
      expect(await end(r, repositoryFailure === undefined ? {} : { repositoryFailure })).toMatchObject({ persisted: true, ended: true });
      const row = r.e.sqlite.query("SELECT run_context FROM agent_runs WHERE id='run_seed'").get() as { run_context: string };
      expect(row.run_context).not.toContain('repositoryFailureCode');
      if (repositoryFailure === undefined) {
        r.e.sqlite.run("UPDATE agent_runs SET error_code='run_failed' WHERE id='run_seed'");
        const env = { ...r.e.env, ...OWNER_ENV };
        const headers = { cookie: await ownerCookie(r.e.db), 'cf-connecting-ip': '1.2.3.4' };
        const detail = await jsonBody(await worker.fetch(new Request('https://s/api/projects/proj_1/runs/run_seed', { headers }), env)) as any;
        expect(detail.run.errorCode).toBe('repository_unprepared');
        expect(detail.run.repositoryFailure).toBeUndefined();
        const work = await jsonBody(await worker.fetch(new Request(`https://s/api/work?since=${r.now - 1000}&until=${r.now + 10_000}`, { headers }), env)) as any;
        expect(work.runs.find((run: any) => run.id === 'run_seed').failure).toMatchObject({ code: 'repository_unprepared' });
      }
    }
  });
});
