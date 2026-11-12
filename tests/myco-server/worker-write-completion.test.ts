import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from './helpers/member-token.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { offeredHarness } from './helpers/offered-harness.js';
import { legacyWorker } from './helpers/worker-principal.js';
import { workerRunLeaseExpiry } from '@myco-server-worker/db/runs/leases.js';
import { changingAtStatement, failingStatement } from './helpers/store-faults.js';

const ACTOR = 'mem_machine_2';

it('lease renewal returns its committed expiry without a later fallible read', async () => {
  const f = sqliteEnv({ workerLogin: true });
  try {
    const now = Date.now();
    f.sqlite.run("UPDATE members SET role='admin' WHERE id=?", [ACTOR]);
    turnOnGatedCapabilities(f.sqlite);
    const issued = await issueMemberToken(f.db, { memberId: ACTOR, machineId: 'worker-machine' }, now);
    f.sqlite.run("INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)", [now]);
    f.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
      VALUES ('proj_1','renewal-run','myco-agent','title-summary','queued',?,'worker',?,'{}','do it')`, [now, JSON.stringify({ params: { session_id: 'fixture-session', mode: 'claim' }, serverUrl: 'https://s', actor: ACTOR, timeoutSeconds: 300 })]);
    const request = (path: string, body: unknown) => worker.fetch(new Request(`https://s/worker/${path}`, { method: 'POST', headers: memberHeaders(issued.token), body: JSON.stringify(body) }), f.env);
    expect(await (await request('claim', { harnesses: [offeredHarness('claude-code')] })).json()).toMatchObject({ claimed: true });
    // A renewal that had to read the expiry back would die here; the answer is the row the renewal stored.
    await workerRunLeaseExpiry(f.db, { projectId: 'proj_1' }, 'renewal-run', legacyWorker(issued.tokenId, 'worker-machine'), now);
    const expiry = failingStatement(f.db, 'runs.leaseExpiryMember', { error: () => new Error('injected post-renewal read failure') });
    f.env.MYCO_DB = expiry.store;
    const answer = await (await request('lease', { projectId: 'proj_1', runId: 'renewal-run' })).json() as { persisted: boolean; held: boolean; expiresAt: number };
    expect(expiry.failures()).toBe(0);
    expect(answer).toMatchObject({ persisted: true, held: true });
    expect(f.sqlite.query("SELECT lease_expires_at AS expiresAt FROM agent_runs WHERE id='renewal-run'").get()).toEqual({ expiresAt: answer.expiresAt });
  } finally { f.sqlite.close(); }
});

const BOUNDARY_STATEMENTS = {
  'claim contact': ['claim.workerContactUpsertMemberAttempt'],
  'claim input': ['runs.claimInputWrite'],
  'lease contact': ['claim.workerContactUpsertOpen', 'claim.workerContactUpsertMember', 'claim.workerContactUpsertMemberAttempt'],
  'end credential': ['credential.retireEndedAttempt'],
} as const;

for (const boundary of ['claim contact', 'claim input', 'lease contact', 'end credential'] as const) {
  for (const revoke of [false, true]) {
    it(`${boundary}: late ${revoke ? 'revocation' : 'demotion'} keeps the response aligned with committed state`, async () => {
      const f = sqliteEnv({ workerLogin: true });
      try {
        const now = Date.now();
        f.sqlite.run("UPDATE members SET role='admin' WHERE id=?", [ACTOR]);
        turnOnGatedCapabilities(f.sqlite);
        const issued = await issueMemberToken(f.db, { memberId: ACTOR, machineId: 'worker-machine' }, now);
        f.sqlite.run("INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)", [now]);
        f.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
          VALUES ('proj_1','completion-run','myco-agent','title-summary','queued',?,'worker',?,'{}','do it')`, [now, JSON.stringify({ params: { session_id: 'fixture-session', mode: 'claim' }, serverUrl: 'https://s', actor: ACTOR, timeoutSeconds: 300 })]);
        const request = (path: string, body: unknown) => worker.fetch(new Request(`https://s/worker/${path}`, { method: 'POST', headers: memberHeaders(issued.token), body: JSON.stringify(body) }), f.env);
        const claimBody = { harnesses: [offeredHarness('claude-code')] };
        if (boundary.startsWith('lease') || boundary.startsWith('end')) {
          expect(await (await request('claim', claimBody)).json()).toMatchObject({ persisted: true, claimed: true });
          f.sqlite.run("UPDATE worker_contacts SET last_seen_at=0");
          f.sqlite.run("UPDATE agent_runs SET lease_expires_at=? WHERE id='completion-run'", [now + 1000]);
        }
        const snapshot = () => ['agent_runs', 'agent_run_attempts', 'member_credentials'].map(table => f.sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
        const before = snapshot();
        const change = () => { f.sqlite.run(revoke ? 'UPDATE members SET revoked_at=1 WHERE id=?' : "UPDATE members SET role='member' WHERE id=?", [ACTOR]); };
        let store = f.db;
        const landings = BOUNDARY_STATEMENTS[boundary].map((name) => {
          const landing = changingAtStatement(store, name, change);
          store = landing.store;
          return landing;
        });
        f.env.MYCO_DB = store;
        const path = boundary.startsWith('claim') ? 'claim' : boundary.startsWith('lease') ? 'lease' : 'end';
        const response = await request(path, path === 'claim' ? claimBody : { projectId: 'proj_1', runId: 'completion-run', status: 'failed', error: 'fixture' });
        expect(landings.some((landing) => landing.landed())).toBe(true);
        const answer = await response.json() as { persisted: boolean; code?: string; claimed?: boolean; held?: boolean; ended?: boolean };
        if (!answer.persisted) {
          expect(answer.code).toBe('not_admin');
          expect(snapshot()).toEqual(before);
        } else {
          expect(answer[path === 'claim' ? 'claimed' : path === 'lease' ? 'held' : 'ended']).toBe(true);
        }
      } finally { f.sqlite.close(); }
    });
  }
}

for (const revoke of [false, true]) {
  it(`lost claim: ${revoke ? 'revocation' : 'demotion'} before its final contact leaves no orphan credential`, async () => {
    const f = sqliteEnv({ workerLogin: true });
    try {
      const now = Date.now();
      f.sqlite.run("UPDATE members SET role='admin' WHERE id=?", [ACTOR]);
      turnOnGatedCapabilities(f.sqlite);
      const issued = await issueMemberToken(f.db, { memberId: ACTOR, machineId: 'worker-machine' }, now);
      f.sqlite.run("INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)", [now]);
      f.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,dispatch_spec,run_context,instruction)
        VALUES ('proj_1','lost-run','myco-agent','title-summary','queued',?,'worker',?,'{}','do it')`, [now, JSON.stringify({ params: { session_id: 'fixture-session', mode: 'claim' }, serverUrl: 'https://s', actor: ACTOR, timeoutSeconds: 300 })]);
      const credentials = f.sqlite.query('SELECT * FROM member_credentials ORDER BY rowid').all();
      const lost = changingAtStatement(f.db, 'runs.queuedinactiveMemberAnyObserved', () => {
        f.sqlite.run("UPDATE agent_runs SET status='failed' WHERE id='lost-run'");
        f.sqlite.run(revoke ? 'UPDATE members SET revoked_at=1 WHERE id=?' : "UPDATE members SET role='member' WHERE id=?", [ACTOR]);
      });
      f.env.MYCO_DB = lost.store;
      const response = await worker.fetch(new Request('https://s/worker/claim', { method: 'POST', headers: memberHeaders(issued.token), body: JSON.stringify({ harnesses: [offeredHarness('claude-code')] }) }), f.env);
      expect(lost.landed()).toBe(true);
      expect(await response.json()).toMatchObject({ persisted: false, code: 'not_admin' });
      expect(f.sqlite.query('SELECT * FROM member_credentials ORDER BY rowid').all()).toEqual(credentials);
      expect(f.sqlite.query("SELECT dispatched_by,leased_by,lease_expires_at FROM agent_runs WHERE id='lost-run'").get()).toEqual({ dispatched_by: null, leased_by: null, lease_expires_at: null });
      expect(f.sqlite.query("SELECT count(*) AS n FROM agent_run_attempts WHERE run_id='lost-run'").get()).toEqual({ n: 0 });
    } finally { f.sqlite.close(); }
  });
}
