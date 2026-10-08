import { legacyWorker } from './helpers/worker-principal.js';
import { expect, it } from 'bun:test';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { WORKER_CAPABILITIES } from '@goondocks/myco-shared/repository';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { memberWriteStore } from '@myco-server-worker/auth/member-write-store.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { dispatchTask, claimNextRun } from '@myco-server-worker/core/harness.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { prepareWorkerRepository } from '@myco-server-worker/core/worker-repository.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';

const SOURCE = { url: 'https://example.test/team/source', branch: 'main' };
const COMMIT = 'a'.repeat(40);
const MEMBER = 'mem_worker';

async function rig(onSql: (sql: string, sqlite: ReturnType<typeof sqliteEnv>['sqlite']) => void) {
  const e = sqliteEnv({ workerLogin: true, onSql });
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

for (const change of ['demotion', 'revocation'] as const) {
  it(`refuses a map pin before its guarded write after ${change}, leaving the pin and lease untouched`, async () => {
    let armed = false;
    let changed = false;
    const r = await rig((sql, sqlite) => {
      if (!armed || changed || !/^UPDATE agent_runs SET run_context = json_set/.test(sql.trim())) return;
      changed = true;
      sqlite.run(change === 'demotion' ? "UPDATE members SET role='member' WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [MEMBER]);
    });
    try {
      const before = r.state();
      armed = true;
      const response = await r.request({ ...SOURCE, commit: COMMIT });
      expect(changed).toBe(true);
      expect(await response.json()).toMatchObject({ persisted: false, code: 'not_admin' });
      expect(r.state()).toEqual(before);
    } finally { r.e.sqlite.close(); }
  });

  it(`answers a committed map pin after ${change} without a later guarded write`, async () => {
    let armed = false;
    let changed = false;
    const r = await rig(() => {});
    try {
      const db = r.e.env.MYCO_DB as RelationalStore;
      r.e.env.MYCO_DB = {
        prepare: (sql: string) => db.prepare(sql),
        batch: async (statements: Parameters<RelationalStore['batch']>[0]) => {
          const results = await db.batch(statements);
          if (armed && !changed && statements.some((statement) => /^UPDATE agent_runs SET run_context = json_set/.test(String((statement as { sql?: string }).sql).trim()))) {
            changed = true;
            r.e.sqlite.run(change === 'demotion' ? "UPDATE members SET role='member' WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [MEMBER]);
          }
          return results;
        },
      };
      const before = r.state();
      armed = true;
      const response = await r.request({ ...SOURCE, commit: COMMIT });
      expect(changed).toBe(true);
      expect(await response.json()).toMatchObject({ persisted: true, held: true, pin: { ...SOURCE, commit: COMMIT } });
      expect(r.state().lease).toBe(before.lease);
      expect(JSON.parse(r.state().context)).toMatchObject({ repository: { ...SOURCE, commit: COMMIT }, canopy: { inputHash: expect.any(String), priorRevision: null } });
    } finally { r.e.sqlite.close(); }
  });
}

for (const task of ['map', 'repository', 'credential'] as const) {
  it(`checks the database clock at the ${task} pin write after a stale worker clock passed initial lease admission`, async () => {
    let armed = false;
    let expired = false;
    const r = await rig((sql, sqlite) => {
      const write = task === 'credential' ? /^UPDATE agent_runs SET lease_expires_at/ : /^UPDATE agent_runs SET run_context = json_set/;
      if (!armed || expired || !write.test(sql.trim())) return;
      expired = true;
      sqlite.run('UPDATE agent_runs SET lease_expires_at = ? WHERE id = ?', [Date.now() - 1_000, r.runId]);
    });
    try {
      if (task === 'repository') r.e.sqlite.run("UPDATE agent_runs SET task='vault-seed' WHERE id=?", [r.runId]);
      const stale = Date.now() - 60_000;
      const env = { ...r.e.serverEnv, db: memberWriteStore(r.e.db, MEMBER, 'admin') };
      const before = r.state().context;
      armed = true;
      const result = await prepareWorkerRepository(env, { worker: legacyWorker(r.credential.tokenId, 'm1'), clock: () => stale }, {
        projectId: 'proj_1', runId: r.runId, body: task === 'credential' ? {} : { ...SOURCE, commit: COMMIT },
      });
      expect(expired).toBe(true);
      expect(result).toMatchObject(task === 'credential' ? { held: false } : { persisted: true, held: false, pin: null });
      expect(r.state().context).toBe(before);
      expect(r.state().lease).toBeGreaterThan(stale);
      expect(r.state().lease).toBeLessThan(Date.now());
    } finally { r.e.sqlite.close(); }
  });
}

it('withholds a repository credential when revocation precedes its final authority write', async () => {
  let armed = false;
  let changed = false;
  const r = await rig((sql, sqlite) => {
    if (!armed || changed || !/^UPDATE agent_runs SET lease_expires_at/.test(sql.trim())) return;
    changed = true;
    sqlite.run('UPDATE members SET revoked_at=1 WHERE id=?', [MEMBER]);
  });
  try {
    const before = r.state();
    armed = true;
    const response = await r.request({});
    expect(changed).toBe(true);
    expect(await response.json()).toMatchObject({ persisted: false, code: 'not_admin' });
    expect(r.state()).toEqual(before);
  } finally { r.e.sqlite.close(); }
});

it('answers an expired lease against a legacy repository-only map pin without changing the pin', async () => {
  let armed = false;
  let expired = false;
  const r = await rig((sql, sqlite) => {
    if (!armed || expired || !/^UPDATE agent_runs SET run_context = json_set/.test(sql.trim())) return;
    expired = true;
    sqlite.run('UPDATE agent_runs SET lease_expires_at = ? WHERE id = (SELECT id FROM agent_runs WHERE task = ? ORDER BY queued_at DESC LIMIT 1)', [0, MAP_TASK]);
  });
  try {
    const initial = r.state();
    const legacy = { ...JSON.parse(initial.context), repository: { ...SOURCE, commit: COMMIT } };
    r.e.sqlite.run('UPDATE agent_runs SET run_context = ? WHERE task = ?', [JSON.stringify(legacy), MAP_TASK]);
    armed = true;
    const response = await r.request({ ...SOURCE, commit: COMMIT });
    expect(expired).toBe(true);
    expect(await response.json() as Record<string, unknown>).toEqual({ persisted: true, held: false, reason: 'the run no longer holds its map input' });
    expect(JSON.parse(r.state().context)).toEqual(legacy);
  } finally { r.e.sqlite.close(); }
});

for (const change of ['demotion', 'revocation'] as const) {
  it(`answers a committed repository pin after worker ${change}`, async () => {
    let armed = false;
    let changed = false;
    const r = await rig(() => {});
    try {
      r.e.sqlite.run("UPDATE agent_runs SET task='vault-seed' WHERE task=?", [MAP_TASK]);
      const db = r.e.env.MYCO_DB as RelationalStore;
      r.e.env.MYCO_DB = {
        prepare: (sql: string) => db.prepare(sql),
        batch: async (statements: Parameters<RelationalStore['batch']>[0]) => {
          const results = await db.batch(statements);
          if (armed && !changed && statements.some((statement) => /^UPDATE agent_runs SET run_context = json_set/.test(String((statement as { sql?: string }).sql).trim()))) {
            changed = true;
            r.e.sqlite.run(change === 'demotion' ? "UPDATE members SET role='member' WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [MEMBER]);
          }
          return results;
        },
      };
      armed = true;
      const response = await r.request({ ...SOURCE, commit: COMMIT });
      expect(changed).toBe(true);
      expect(await response.json()).toMatchObject({ persisted: true, held: true, pin: { ...SOURCE, commit: COMMIT } });
      expect(JSON.parse(r.state().context)).toMatchObject({ repository: { ...SOURCE, commit: COMMIT } });
    } finally { r.e.sqlite.close(); }
  });
}
