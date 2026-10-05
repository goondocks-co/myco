import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { runControlResult, RunControlError } from '@goondocks/myco-shared/run-control';
import { ROUTES } from '@myco-server-worker/routes.js';
import { memberPost, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';

const OFFERS = {
  '/runs/claim': { id: 'target', agentId: 'myco-agent', task: 'title-summary', captureDriven: true, dryRun: true },
  '/runs/update': { runId: 'target', update: { tokens_used: 17 } },
  '/runs/report': { runId: 'target', agentId: 'myco-agent', action: 'summary', summary: 'done' },
  '/runs/embedding-step': { runId: 'target' },
  '/runs/repository': { runId: 'target' },
  '/runs/canopy-map': { runId: 'target', op: 'prepare' },
} as const;
const TASKS: Record<string, string> = { '/runs/embedding-step': 'embedding-reconcile', '/runs/repository': 'vault-seed', '/runs/canopy-map': 'canopy-map' };

async function fixture(target: 'cloudflare' | 'native', path: string, onSql?: Parameters<typeof sqliteEnv>[0], controlledClock = false) {
  const f = sqliteEnv(onSql);
  let now = Date.now();
  turnOnGatedCapabilities(f.sqlite);
  await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
  const mint = (memberId = HARNESS_MEMBER_ID) => issueMemberToken(f.db, { memberId, machineId: 'machine_1' }, now);
  const holder = await mint();
  const sibling = await mint();
  const foreign = await mint();
  const unheld = await mint();
  const member = await mint('mem_machine_1');
  const admin = await mint('mem_machine_2');
  f.sqlite.run("UPDATE members SET role = 'admin' WHERE id = 'mem_machine_2'");
  const task = TASKS[path] ?? 'title-summary';
  for (const [id, projectId, credential] of [['target', 'proj_1', holder], ['sibling', 'proj_1', sibling], ['foreign', 'proj_2', foreign]] as const) {
    await recordDispatch(f.db, { projectId }, { id, agentId: 'myco-agent', task, provider: null, model: null,
      runContext: JSON.stringify({ timeoutSeconds: 120 }), startedAt: now, dispatchedBy: credential.tokenId, dryRun: true });
    if (path !== '/runs/claim') f.sqlite.run("UPDATE agent_runs SET status = 'running' WHERE id = ?", [id]);
  }
  const nativeBase = serverEnvFromBunConfig({ sqlite: f.sqlite, blobDir: '/unused-run-authority-blobs' });
  const native = { ...nativeBase, ...(onSql === undefined ? {} : { db: f.db }) };
  const pipeline = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: fetch });
  const post = async (token: string, body: unknown, project = 'proj_1', route = path) => {
    const request = memberPost(token, body, route, { 'x-myco-project': project });
    const response = target === 'cloudflare' && !controlledClock ? await worker.fetch(request, f.env)
      : await pipeline.handleRequest(request, target === 'native' ? native : f.serverEnv);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const snapshot = () => ({ runs: f.sqlite.query("SELECT *, json_remove(run_context, '$.runControlRefusals') AS run_context FROM agent_runs ORDER BY project_id,id").all(),
    reports: f.sqlite.query('SELECT * FROM agent_reports ORDER BY id').all(),
    calls: f.sqlite.query('SELECT * FROM agent_run_events ORDER BY project_id,run_id,id').all(), projects: f.sqlite.query('SELECT * FROM projects ORDER BY project_id').all() });
  return { ...f, holder, sibling, foreign, unheld, member, admin, post, snapshot, now, advanceClock: (at: number) => { now = at; } };
}

for (const target of ['cloudflare', 'native'] as const) describe(`${target}: run route authority`, () => {
  it('covers every active run route', () => {
    expect(Object.keys(OFFERS).sort()).toEqual(ROUTES.filter(r => r.path.startsWith('/runs/') && !('retired' in r && r.retired)).map(r => r.path).sort());
  });
  for (const [path, body] of Object.entries(OFFERS)) {
    for (const principal of ['member', 'admin', 'sibling', 'foreign', 'unheld', 'expired', 'stale', 'wrong-project', 'ambiguous'] as const) {
      it(`${path} refuses ${principal} without changing rows`, async () => {
        const f = await fixture(target, path);
        try {
          if (principal === 'expired') f.sqlite.run('UPDATE agent_runs SET lease_expires_at = ? WHERE id = ?', [f.now - 1, 'target']);
          if (principal === 'stale') f.sqlite.run('UPDATE agent_runs SET started_at = ? WHERE id = ?', [f.now - 1_000_000, 'target']);
          if (principal === 'ambiguous') f.sqlite.run('UPDATE agent_runs SET dispatched_by = ? WHERE id = ?', [f.holder.tokenId, 'sibling']);
          const token = principal in f && ['member', 'admin', 'sibling', 'foreign', 'unheld'].includes(principal)
            ? f[principal as 'member' | 'admin' | 'sibling' | 'foreign' | 'unheld'].token : f.holder.token;
          const before = f.snapshot();
          const answer = await f.post(token, body, principal === 'wrong-project' ? 'proj_2' : 'proj_1');
          expect({ principal, path, persisted: answer.body.persisted }).toEqual({ principal, path, persisted: false });
          expect(f.snapshot()).toEqual(before);
        } finally { f.sqlite.close(); }
      });
    }
    it(`${path} admits its rightful dry-run holder`, async () => {
      const f = await fixture(target, path);
      try {
        const answer = await f.post(f.holder.token, body);
        expect(answer.body.persisted).toBe(true);
        if (path === '/runs/claim') expect(answer.body.claimed).toBe(true);
        if (path === '/runs/update') expect(answer.body.applied).toBe(true);
        if (path === '/runs/report') expect(answer.body.recorded).toBe(true);
        expect(f.sqlite.query("SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id = 'target'").get()).toEqual({ n: 1 });
      } finally { f.sqlite.close(); }
    });
  }
  for (const path of Object.keys(TASKS)) it(`${path} requires its declared task capability`, async () => {
    const f = await fixture(target, path);
    try {
      f.sqlite.run("UPDATE agent_runs SET task = 'title-summary' WHERE id = 'target'");
      const before = f.snapshot();
      expect((await f.post(f.holder.token, OFFERS[path as keyof typeof OFFERS])).body.persisted).toBe(false);
      expect(f.snapshot()).toEqual(before);
    } finally { f.sqlite.close(); }
  });
  for (const path of ['/runs/repository', '/runs/canopy-map']) it(`${path} refuses a leased worker even with its rightful credential`, async () => {
    const f = await fixture(target, path);
    try {
      f.sqlite.run("UPDATE agent_runs SET lease_expires_at = ? WHERE id = 'target'", [f.now + 10_000]);
      const before = f.snapshot();
      expect((await f.post(f.holder.token, OFFERS[path as keyof typeof OFFERS])).body.persisted).toBe(false);
      expect(f.snapshot()).toEqual(before);
    } finally { f.sqlite.close(); }
  });
  it('returns a stable credential-bound receipt for an admission refusal', async () => {
    const f = await fixture(target, '/runs/update');
    try {
      f.sqlite.run("UPDATE agent_runs SET lease_expires_at = ? WHERE id = 'target'", [f.now - 1]);
      const offer = { runId: 'target', update: { status: 'failed', error: 'runtime overrun' } };
      const first = await f.post(f.holder.token, offer);
      const second = await f.post(f.holder.token, offer);
      const receiptId = first.body.refusalId as string;
      expect({ ...first.body }).toMatchObject({ persisted: false, code: 'no_run', refusalId: expect.any(String) });
      expect(second.body.refusalId).toBe(receiptId);
      const context = f.sqlite.query("SELECT run_context AS context FROM agent_runs WHERE id = 'target'").get() as { context: string };
      expect(JSON.parse(context.context).runControlRefusals.no_run).toEqual({ id: receiptId, tokenId: f.holder.tokenId, code: 'no_run' });
      try { runControlResult(first.status, first.body, '/runs/update'); throw new Error('expected refusal'); }
      catch (error) { expect(error).toBeInstanceOf(RunControlError); expect((error as RunControlError).refusalId).toBe(receiptId); }
      f.sqlite.run("UPDATE agent_runs SET dispatched_by = ? WHERE id = 'sibling'", [f.holder.tokenId]);
      expect((await f.post(f.holder.token, offer)).body.refusalId).toBeUndefined();
    } finally { f.sqlite.close(); }
  });
  it('admits an embedding step while its rightful dispatch lease is live', async () => {
    const f = await fixture(target, '/runs/embedding-step');
    try {
      f.sqlite.run("UPDATE agent_runs SET lease_expires_at = ? WHERE id = 'target'", [f.now + 10_000]);
      expect((await f.post(f.holder.token, OFFERS['/runs/embedding-step'])).body).toMatchObject({ persisted: true, held: true });
    } finally { f.sqlite.close(); }
  });
  it('allows a late child to claim the queued dispatch that still names its credential', async () => {
    const f = await fixture(target, '/runs/claim');
    try {
      f.sqlite.run("UPDATE agent_runs SET status = 'queued' WHERE id = 'target'");
      expect((await f.post(f.holder.token, OFFERS['/runs/claim'])).body).toMatchObject({ persisted: true, claimed: true });
    } finally { f.sqlite.close(); }
  });
  for (const path of ['/runs/claim', '/runs/update', '/runs/report']) for (const bound of ['lease', 'budget'] as const) it(`${path} checks ${bound} expiry using the write clock`, async () => {
    let armed = false;
    let advance: () => void = () => {};
    const f = await fixture(target, path, { onSql: (sql) => {
      const read = path === '/runs/claim' ? sql.startsWith('SELECT project_id AS projectId, id, harness') : sql.startsWith('SELECT id, harness');
      if (armed && read) { armed = false; advance(); }
    } }, true);
    try {
      if (bound === 'lease') f.sqlite.run("UPDATE agent_runs SET lease_expires_at = ? WHERE id = 'target'", [f.now + 10]);
      advance = () => f.advanceClock(f.now + (bound === 'lease' ? 20 : 1_000_000));
      armed = true;
      const answer = await f.post(f.holder.token, OFFERS[path as keyof typeof OFFERS]);
      expect(answer.body.applied).not.toBe(true);
      expect(answer.body.recorded).not.toBe(true);
      expect(answer.body.claimed).not.toBe(true);
      expect(f.sqlite.query("SELECT tokens_used FROM agent_runs WHERE id = 'target'").get()).toEqual({ tokens_used: null });
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_reports').get()).toEqual({ n: 0 });
    } finally { f.sqlite.close(); }
  });
  for (const path of ['/runs/claim', '/runs/update', '/runs/report']) for (const race of ['credential', 'revocation', 'lease', 'terminal'] as const) {
    it(`${path} rechecks ${race} at the mutation statement`, async () => {
      let armed = false;
      const f = await fixture(target, path, { onSql: (sql, sqlite) => {
        const write = path === '/runs/claim' ? sql.startsWith('UPDATE agent_runs\n   SET status')
          : path === '/runs/update' ? sql.startsWith('UPDATE agent_runs SET tokens_used') : sql.startsWith('INSERT INTO agent_reports');
        if (!armed || !write) return;
        armed = false;
        if (race === 'credential') sqlite.run("UPDATE agent_runs SET dispatched_by = (SELECT dispatched_by FROM agent_runs WHERE id = 'sibling') WHERE id = 'target'");
        if (race === 'lease') sqlite.run("UPDATE agent_runs SET lease_expires_at = 1 WHERE id = 'target'");
        if (race === 'terminal') sqlite.run("UPDATE agent_runs SET status = 'failed' WHERE id = 'target'");
        if (race === 'revocation') sqlite.run("UPDATE member_credentials SET revoked_at = 1, revoked_by = 'mem_machine_2' WHERE id = (SELECT dispatched_by FROM agent_runs WHERE id = 'target')");
      } });
      try {
        armed = true;
        const answer = await f.post(f.holder.token, OFFERS[path as keyof typeof OFFERS]);
        expect(answer.body.applied).not.toBe(true);
        expect(answer.body.recorded).not.toBe(true);
        expect(answer.body.claimed).not.toBe(true);
        expect(f.sqlite.query("SELECT tokens_used FROM agent_runs WHERE id = 'target'").get()).toEqual({ tokens_used: null });
        expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_reports').get()).toEqual({ n: 0 });
        expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_run_events').get()).toEqual({ n: 0 });
        expect(f.sqlite.query("SELECT run_context AS context FROM agent_runs WHERE id = 'target'").get()).toEqual({ context: JSON.stringify({ timeoutSeconds: 120 }) });
      } finally { f.sqlite.close(); }
    });
  }
  it('refuses a member inventing capture-driven work or failing another dispatch', async () => {
    const f = await fixture(target, '/runs/update');
    try {
      const before = f.snapshot();
      for (const [path, body] of [['/runs/claim', { ...OFFERS['/runs/claim'], id: 'invented' }],
        ['/runs/update', { runId: 'target', update: { status: 'failed' } }]] as const) {
        expect((await f.post(f.member.token, body, 'proj_1', path)).body.persisted).toBe(false);
        expect(f.snapshot()).toEqual(before);
      }
    } finally { f.sqlite.close(); }
  });
  it('keeps a rightful close retry read-only after release revokes its credential', async () => {
    const f = await fixture(target, '/runs/update');
    try {
      const body = { runId: 'target', update: { status: 'failed', error: 'closed' } };
      expect((await f.post(f.holder.token, body)).body.applied).toBe(true);
      const before = f.snapshot();
      expect((await f.post(f.holder.token, body)).body).toMatchObject({ persisted: true, applied: true, changed: 0 });
      for (const [project, offer] of [['proj_2', body], ['proj_1', { ...body, runId: 'sibling' }],
        ['proj_1', { runId: 'target', update: { tokens_used: 999 } }],
        ['proj_1', { runId: 'target', update: { status: 'failed', tokens_used: 'junk' } }],
        ['proj_1', { runId: 'target', update: { status: 'failed', cost_data: 'not json' } }]] as const) {
        expect((await f.post(f.holder.token, offer, project)).body.applied).not.toBe(true);
      }
      expect(f.snapshot()).toEqual(before);
    } finally { f.sqlite.close(); }
  });
  for (const revocation of ['admin', 'member', 'expiry'] as const) it(`a close retry cannot bypass ${revocation} revocation`, async () => {
    const f = await fixture(target, '/runs/update');
    try {
      const offer = { runId: 'target', update: { status: 'failed' } };
      expect((await f.post(f.holder.token, offer)).body.applied).toBe(true);
      if (revocation === 'admin') f.sqlite.run('UPDATE member_credentials SET revoked_by = ? WHERE id = ?', ['mem_machine_2', f.holder.tokenId]);
      if (revocation === 'member') f.sqlite.run('UPDATE members SET revoked_at = ? WHERE id = ?', [f.now, HARNESS_MEMBER_ID]);
      if (revocation === 'expiry') f.sqlite.run('UPDATE member_credentials SET expires_at = ? WHERE id = ?', [f.now - 1, f.holder.tokenId]);
      const before = f.snapshot();
      expect((await f.post(f.holder.token, offer)).status).toBe(401);
      expect(f.snapshot()).toEqual(before);
    } finally { f.sqlite.close(); }
  });
});
