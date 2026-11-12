import { legacyWorker } from './helpers/worker-principal.js';
import { expect, it } from 'bun:test';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { memberWriteStore } from '@myco-server-worker/auth/member-write-store.js';
import { issueMemberToken } from './helpers/member-token.js';
import { dispatchTask, claimNextRun } from '@myco-server-worker/core/harness.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { prepareWorkerRepository } from '@myco-server-worker/core/worker-repository.js';
import { renewRunLease } from '@myco-server-worker/db/runs/leases.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { changingAt, changingAtStatement, observing, storingCall } from './helpers/store-faults.js';

const SOURCE = { url: 'https://example.test/team/source', branch: 'main' };
const COMMIT = 'a'.repeat(40);
const MEMBER = 'mem_worker';

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  e.env.SECRET_WRAP_KEY = { get: async () => btoa('r'.repeat(32)) };
  const now = Date.now();
  await ensureMember(e.db, MEMBER, now, 'admin', 'worker');
  const credential = await issueMemberToken(e.db, { memberId: MEMBER, machineId: 'm1' }, now);
  e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by)
    VALUES ('proj_1', 'canopy', 1, ?, 'test')`, [now]);
  const repositories = projectRepositories(e.db, deploymentSecretStore(e.db, e.serverEnv.wrappingKey));
  await repositories.save('proj_1', { ...SOURCE, revision: null, credential: { username: 'reader', token: 'synthetic-source-secret' } }, MEMBER, now);
  const dispatch = await dispatchTask(e.serverEnv, MAP_TASK, 'proj_1', { serverUrl: 'https://s', actor: MEMBER }, now);
  if (!dispatch.dispatched) throw new Error('fixture map run was not dispatched');
  const claimed = await claimNextRun(e.serverEnv, { principal: legacyWorker(credential.tokenId, 'm1'), harnesses: [offeredHarness('claude-code')], capabilities: WORKER_CAPABILITIES, now });
  if (!claimed.claimed) throw new Error('fixture map run was not claimed');
  const request = (body: Record<string, unknown>) => worker.fetch(new Request('https://s/worker/repository', {
    method: 'POST', headers: memberHeaders(credential.token), body: JSON.stringify({ projectId: 'proj_1', runId: claimed.run.id, ...body }),
  }), e.env);
  const state = () => e.sqlite.query('SELECT run_context AS context, lease_expires_at AS lease FROM agent_runs WHERE id = ?').get(claimed.run.id) as { context: string; lease: number };
  return { e, request, state, credential, runId: claimed.run.id };
}

type Rig = Awaited<ReturnType<typeof rig>>;

function memberChange(sqlite: Rig['e']['sqlite'], change: 'demotion' | 'revocation') {
  sqlite.run(change === 'demotion' ? "UPDATE members SET role='member' WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [MEMBER]);
}

function restoreRun(r: Rig, before: { context: string; lease: number }) {
  r.e.sqlite.run('UPDATE agent_runs SET run_context = ?, lease_expires_at = ? WHERE id = ?', [before.context, before.lease, r.runId]);
}

/** The call of `operation` that changes what `read` returns. The row is put back so the measured call can run again. */
async function storingAt(r: Rig, operation: (store: RelationalStore) => Promise<unknown>, read: () => unknown) {
  const before = r.state();
  const at = await storingCall(r.e.db, operation, read);
  restoreRun(r, before);
  if (at < 1) throw new Error('the pin stored nothing');
  return at;
}

for (const change of ['demotion', 'revocation'] as const) {
  it(`refuses a map pin before its guarded write after ${change}, leaving the pin and lease untouched`, async () => {
    const r = await rig();
    try {
      const before = r.state();
      const pin = (store: RelationalStore) => { r.e.env.MYCO_DB = store; return r.request({ ...SOURCE, commit: COMMIT }); };
      const at = await storingAt(r, pin, () => r.state().context);
      const raced = changingAt(r.e.db, at, () => memberChange(r.e.sqlite, change));
      const response = await pin(raced.store);
      expect(raced.landed()).toBe(true);
      expect(await response.json()).toMatchObject({ persisted: false, code: 'not_admin' });
      expect(r.state()).toEqual(before);
    } finally { r.e.sqlite.close(); }
  });

  it(`answers a committed map pin after ${change} without a later guarded write`, async () => {
    const r = await rig();
    try {
      const before = r.state();
      const pin = (store: RelationalStore) => { r.e.env.MYCO_DB = store; return r.request({ ...SOURCE, commit: COMMIT }); };
      const at = await storingAt(r, pin, () => r.state().context);
      let landed = false;
      const watched = observing(r.e.db, async (n, moment) => {
        if (!landed && n === at && moment === 'after') { landed = true; memberChange(r.e.sqlite, change); }
      });
      const response = await pin(watched.store);
      expect(landed).toBe(true);
      expect(await response.json()).toMatchObject({ persisted: true, held: true, pin: { ...SOURCE, commit: COMMIT } });
      expect(r.state().lease).toBe(before.lease);
      expect(JSON.parse(r.state().context)).toMatchObject({ repository: { ...SOURCE, commit: COMMIT }, canopy: { inputHash: expect.any(String), priorRevision: null } });
    } finally { r.e.sqlite.close(); }
  });
}

for (const task of ['map', 'repository', 'credential'] as const) {
  it(`checks the database clock at the ${task} pin write after a stale worker clock passed initial lease admission`, async () => {
    const r = await rig();
    try {
      if (task === 'repository') r.e.sqlite.run("UPDATE agent_runs SET task='vault-seed' WHERE id=?", [r.runId]);
      const stale = Date.now() - 60_000;
      const body = task === 'credential' ? {} : { ...SOURCE, commit: COMMIT };
      const prepare = (store: RelationalStore) => prepareWorkerRepository(
        { ...r.e.serverEnv, db: memberWriteStore(store, MEMBER, 'admin') },
        { worker: legacyWorker(r.credential.tokenId, 'm1'), clock: () => stale },
        { projectId: 'proj_1', runId: r.runId, body },
      );
      const before = r.state();
      const expire = () => { r.e.sqlite.run('UPDATE agent_runs SET lease_expires_at = ? WHERE id = ?', [Date.now() - 1_000, r.runId]); };
      const raced = task === 'credential'
        ? await (async () => {
          await renewRunLease(r.e.db, { projectId: 'proj_1' }, r.runId, legacyWorker(r.credential.tokenId, 'm1'), before.lease, Date.now(), r.credential.tokenId);
          restoreRun(r, before);
          return changingAtStatement(r.e.db, 'runs.renewLeaseMemberAttempt', expire);
        })()
        : changingAt(r.e.db, await storingAt(r, prepare, () => r.state().context), expire);
      const result = await prepare(raced.store);
      expect(raced.landed()).toBe(true);
      expect(result).toMatchObject(task === 'credential' ? { held: false } : { persisted: true, held: false, pin: null });
      expect(r.state().context).toBe(before.context);
      expect(r.state().lease).toBeGreaterThan(stale);
      expect(r.state().lease).toBeLessThan(Date.now());
    } finally { r.e.sqlite.close(); }
  });
}

it('withholds a repository credential when revocation precedes its final authority write', async () => {
  const r = await rig();
  try {
    const before = r.state();
    const at = await storingAt(r, async (store) => {
      r.e.env.MYCO_DB = store;
      await r.request({});
    }, () => r.state().lease);
    const raced = changingAt(r.e.db, at, () => { r.e.sqlite.run('UPDATE members SET revoked_at=1 WHERE id=?', [MEMBER]); });
    r.e.env.MYCO_DB = raced.store;
    const response = await r.request({});
    expect(raced.landed()).toBe(true);
    expect(await response.json()).toMatchObject({ persisted: false, code: 'not_admin' });
    expect(r.state()).toEqual(before);
  } finally { r.e.sqlite.close(); }
});

it('answers an expired lease against a legacy repository-only map pin without changing the pin', async () => {
  const r = await rig();
  try {
    const initial = r.state();
    const legacy = { ...JSON.parse(initial.context), repository: { ...SOURCE, commit: COMMIT } };
    r.e.sqlite.run('UPDATE agent_runs SET run_context = ? WHERE task = ?', [JSON.stringify(legacy), MAP_TASK]);
    const at = await storingAt(r, async (store) => {
      r.e.env.MYCO_DB = store;
      await r.request({ ...SOURCE, commit: COMMIT });
    }, () => r.state().context);
    r.e.sqlite.run('UPDATE agent_runs SET run_context = ? WHERE task = ?', [JSON.stringify(legacy), MAP_TASK]);
    const raced = changingAt(r.e.db, at, () => {
      r.e.sqlite.run('UPDATE agent_runs SET lease_expires_at = ? WHERE id = (SELECT id FROM agent_runs WHERE task = ? ORDER BY queued_at DESC LIMIT 1)', [0, MAP_TASK]);
    });
    r.e.env.MYCO_DB = raced.store;
    const response = await r.request({ ...SOURCE, commit: COMMIT });
    expect(raced.landed()).toBe(true);
    expect(await response.json() as Record<string, unknown>).toEqual({ persisted: true, held: false, reason: 'the run no longer holds its map input' });
    expect(JSON.parse(r.state().context)).toEqual(legacy);
  } finally { r.e.sqlite.close(); }
});

for (const change of ['demotion', 'revocation'] as const) {
  it(`answers a committed repository pin after worker ${change}`, async () => {
    const r = await rig();
    try {
      r.e.sqlite.run("UPDATE agent_runs SET task='vault-seed' WHERE task=?", [MAP_TASK]);
      const at = await storingAt(r, async (store) => {
        r.e.env.MYCO_DB = store;
        await r.request({ ...SOURCE, commit: COMMIT });
      }, () => r.state().context);
      r.e.sqlite.run("UPDATE agent_runs SET task='vault-seed' WHERE id=?", [r.runId]);
      let landed = false;
      const watched = observing(r.e.db, async (n, moment) => {
        if (!landed && n === at && moment === 'after') { landed = true; memberChange(r.e.sqlite, change); }
      });
      r.e.env.MYCO_DB = watched.store;
      const response = await r.request({ ...SOURCE, commit: COMMIT });
      expect(landed).toBe(true);
      expect(await response.json()).toMatchObject({ persisted: true, held: true, pin: { ...SOURCE, commit: COMMIT } });
      expect(JSON.parse(r.state().context)).toMatchObject({ repository: { ...SOURCE, commit: COMMIT } });
    } finally { r.e.sqlite.close(); }
  });
}


for (const refused of [false, true]) {
  it(`records knowledge-only preparation only when its admitted mutation lands (refused=${refused})`, async () => {
    const { budgetFixture } = await import('./helpers/budget-fixture.js');
    const { getRun } = await import('@myco-server-worker/db/runs/lifecycle.js') ; const { recordKnowledgeRepositoryUnavailable } = await import('@myco-server-worker/db/runs/preparation.js');
    const f = await budgetFixture();
    try {
      f.queue('knowledge-settlement', 'manual', 'proj_1', 'extract-curate');
      f.sqlite.run(`UPDATE agent_runs SET status='running',started_at=?,leased_by=?,dispatched_by=?,lease_expires_at=?,
        run_context=? WHERE id='knowledge-settlement'`, [f.now, f.workerTokenId, f.workerTokenId, f.now + 60000,
        JSON.stringify({ checkout: { url: 'https://example.test/repository.git' }, timeoutSeconds: 60 })]);
      const before = await getRun(f.db, { projectId: 'proj_1' }, 'knowledge-settlement');
      if (refused) f.sqlite.run(`CREATE TRIGGER refuse_knowledge_mutation BEFORE UPDATE OF instruction ON agent_runs
        WHEN OLD.id='knowledge-settlement' BEGIN SELECT RAISE(IGNORE); END`);
      const landed = await recordKnowledgeRepositoryUnavailable(f.db, { projectId: 'proj_1' }, before!,
        { code: 'fetch_failed', summary: 'Repository unavailable' }, { worker: f.principal, now: f.now });
      expect(landed).toBe(!refused);
      const after = await getRun(f.db, { projectId: 'proj_1' }, 'knowledge-settlement');
      expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id='knowledge-settlement' AND event_type='run_write'").get())
        .toEqual({ n: refused ? 0 : 1 });
      if (refused) {
        expect(f.sqlite.query("SELECT instruction FROM agent_runs WHERE id='knowledge-settlement'").get()).toEqual({ instruction: 'fixture input' });
        expect(after!.runContext).toBe(before!.runContext);
      } else expect(JSON.parse(after!.runContext!).checkout).toBeUndefined();
    } finally { f.sqlite.close(); }
  });
}
