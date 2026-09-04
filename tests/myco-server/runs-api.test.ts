/**
 * The run control plane over HTTP, through the deployed entry.
 *
 * `runs.test.ts` proves the store's atomicity directly. This proves the surface
 * the agent actually calls: that the compare-and-swap survives being split into
 * a read and a guarded write across two requests, which is the only form
 * `mutateState` can take once its caller is in another process.
 */
import { describe, expect, it } from 'bun:test';
import { memberPost, sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import worker from '@myco-server-worker/index.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';

const AGENT = 'agent_1';

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const t = await issueMemberToken(fixture.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
  fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(Date.now());
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, Date.now());
  // Absence means NOT admitted; a fixture expecting a claim to land says so.
  fixture.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(Date.now());
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> =>
    await (await worker.fetch(memberPost(t.token, body, path), env)).json() as Record<string, unknown>;
  return { ...fixture, env, token: t, post };
}

describe('POST /runs/claim', () => {
  it('claims each id once and reports the row to a repeat, both answered as persisted; a second run of the task claims too', async () => {
    const { post } = await harness();
    const first = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(first).toEqual({ persisted: true, claimed: true, runId: 'r1' });
    expect(await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'digest', capability: 'cortex' })).toEqual({ persisted: true, claimed: true, runId: 'r2' });

    const repeat = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(repeat.persisted).toBe(true);
    expect(repeat.claimed).toBe(false);
    expect((repeat.running as { id: string }).id).toBe('r1');
    // The field that once named an age floor is refused, never ignored.
    expect(await post('/runs/claim', { id: 'r3', agentId: AGENT, task: 'digest', capability: 'cortex', maxAgeSeconds: 3600 })).toMatchObject({ persisted: false, code: 'parse' });
  });

  it('attributes the run to the presented credential and never to a body field', async () => {
    const { post, sqlite, token } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex', dispatchedBy: 'someone_else' });
    expect((sqlite.query(`SELECT dispatched_by d FROM agent_runs WHERE id = 'r1'`).get() as { d: string }).d).toBe(token.tokenId);
  });

  it('answers a Project not admitted to the capability distinctly from one whose task is running', async () => {
    const { post, sqlite } = await harness();
    sqlite.query(`DELETE FROM project_capabilities WHERE project_id = 'proj_1'`).run();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(res).toEqual({ persisted: true, claimed: false, notAdmitted: 'cortex' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(0);
  });

  it('admits a capture-driven claim on a configured provider, without any Project capability', async () => {
    const { post, sqlite } = await harness();
    sqlite.query(`DELETE FROM project_capabilities`).run();
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by)
      VALUES ('agent.provider.type', '"anthropic"', ?, 'test')`).run(Date.now());
    expect(await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'title-summary', captureDriven: true }))
      .toEqual({ persisted: true, claimed: true, runId: 'r1' });
  });

  it('answers a capture-driven claim with no provider distinctly, so a caller reports what to configure', async () => {
    const { post, sqlite } = await harness();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'title-summary', captureDriven: true });
    expect(res).toEqual({ persisted: true, claimed: false, noProvider: true });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(0);
  });

  it('refuses a claim naming no capability, so admission cannot be skipped by omission', async () => {
    const { post, sqlite } = await harness();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest' });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(0);
  });

  it('refuses a malformed claim terminally, in the route shape and with a code', async () => {
    const { post, sqlite } = await harness();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(0);
  });

  it('claims per project: the same task in another Project is not blocked', async () => {
    const { post, sqlite, env, token } = await harness();
    sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'proj_2', ?)`).run(Date.now());
    sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_2', 'cortex', 1, ?, 'test')`).run(Date.now());
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    const other = await (await worker.fetch(
      memberPost(token.token, { id: 'r2', agentId: AGENT, task: 'digest', capability: 'cortex' }, '/runs/claim', { 'x-myco-project': 'proj_2' }),
      env)).json() as Record<string, unknown>;
    expect(other).toEqual({ persisted: true, claimed: true, runId: 'r2' });
  });
});

describe('agent state over HTTP', () => {
  it('carries a read-modify-write across two requests, and refuses the write whose read is stale', async () => {
    const { post } = await harness();
    expect(await post('/runs/state/read', { agentId: AGENT, key: 'k' })).toEqual({ persisted: true, value: null, updatedAt: null });

    // Both callers read the same absent value; only one write may land.
    const a = await post('/runs/state/write', { agentId: AGENT, key: 'k', value: 'from-a' });
    const b = await post('/runs/state/write', { agentId: AGENT, key: 'k', value: 'from-b' });
    expect([a.applied, b.applied]).toEqual([true, false]);

    const read = await post('/runs/state/read', { agentId: AGENT, key: 'k' });
    expect(read.value).toBe('from-a');

    // The loser reads again and offers what it now holds — the retry the caller owns.
    const retry = await post('/runs/state/write', { agentId: AGENT, key: 'k', value: 'from-b', expected: read.value });
    expect(retry.applied).toBe(true);
    expect((await post('/runs/state/read', { agentId: AGENT, key: 'k' })).value).toBe('from-b');
  });

  it('keeps state per project', async () => {
    const { post, sqlite, env, token } = await harness();
    sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'proj_2', ?)`).run(Date.now());
    await post('/runs/state/write', { agentId: AGENT, key: 'shared', value: 'one' });
    await worker.fetch(memberPost(token.token, { agentId: AGENT, key: 'shared', value: 'two' }, '/runs/state/write', { 'x-myco-project': 'proj_2' }), env);
    expect((await post('/runs/state/read', { agentId: AGENT, key: 'shared' })).value).toBe('one');
  });
});

describe('agent registration', () => {
  it('is idempotent and keeps the identity across a re-declaration', async () => {
    const { env, sqlite } = await harness();
    const put = async (body: unknown) => new Request('https://s/api/agents/agent_2', {
      method: 'PUT',
      headers: { cookie: (await asOwner('/')).headers.get('cookie')!, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await worker.fetch(await put({ name: 'first', model: 'm1' }), env)).status).toBe(200);
    const created = (sqlite.query(`SELECT created_at c FROM agents WHERE id = 'agent_2'`).get() as { c: number }).c;
    expect((await worker.fetch(await put({ name: 'second', model: 'm2' }), env)).status).toBe(200);
    const row = sqlite.query(`SELECT name, model, created_at c FROM agents WHERE id = 'agent_2'`).get() as { name: string; model: string; c: number };
    expect(row).toEqual({ name: 'second', model: 'm2', c: created });
  });
});

describe('run lifecycle over HTTP', () => {
  it('refuses an update naming a column it may not set, rather than ignoring it', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    const res = await post('/runs/update', { runId: 'r1', update: { status: 'failed', project_id: 'proj_2', dispatched_by: 'someone' } });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
    expect(String(res.reason)).toContain('dispatched_by');
    expect(String(res.reason)).toContain('project_id');
    // Nothing moved: the refusal is whole, not partial.
    const row = sqlite.query(`SELECT project_id AS p, status FROM agent_runs WHERE id = 'r1'`).get() as { p: string; status: string };
    expect(row).toEqual({ p: 'proj_1', status: 'running' });
  });

  it('applies an update of settable columns and reports rows moved', async () => {
    const { post } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 42 } })).toEqual({ persisted: true, changed: 1 });
    const got = await post('/runs/get', { runId: 'r1' });
    expect((got.run as { status: string; completedAt: number }).status).toBe('completed');
  });

  it('keeps the ending a run already carries, whichever ending landed first', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 42 } })).toEqual({ persisted: true, changed: 1 });
    // The close releases the container, the container answers the release with an
    // ending of its own, and both writes are open at once. The row keeps the first.
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'failed', completed_at: 43, error: 'the runtime was replaced while the run was in flight' } }))
      .toEqual({ persisted: true, changed: 0, applied: false, reason: 'terminal' });
    expect(sqlite.query(`SELECT status, completed_at c, error FROM agent_runs WHERE id = 'r1'`).get())
      .toEqual({ status: 'completed', c: 42, error: null });

    await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r2', update: { status: 'failed', completed_at: 50, error: 'boom' } })).toEqual({ persisted: true, changed: 1 });
    expect(await post('/runs/update', { runId: 'r2', update: { status: 'completed', completed_at: 51 } }))
      .toEqual({ persisted: true, changed: 0, applied: false, reason: 'terminal' });
    expect(sqlite.query(`SELECT status, error FROM agent_runs WHERE id = 'r2'`).get()).toEqual({ status: 'failed', error: 'boom' });
  });

  it('applies an update naming no status to a run that has already ended', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 42 } });
    expect(await post('/runs/update', { runId: 'r1', update: { tokens_used: 99, cost_usd: 1 } })).toEqual({ persisted: true, changed: 1 });
    expect(sqlite.query(`SELECT status, tokens_used t FROM agent_runs WHERE id = 'r1'`).get()).toEqual({ status: 'completed', t: 99 });
  });

  it('reads a run in another Project as absent rather than refusing, so existence is not confirmed', async () => {
    const { post, sqlite, env, token } = await harness();
    sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'proj_2', ?)`).run(Date.now());
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    const other = await (await worker.fetch(memberPost(token.token, { runId: 'r1' }, '/runs/get', { 'x-myco-project': 'proj_2' }), env)).json() as Record<string, unknown>;
    expect(other).toEqual({ persisted: true, run: null });
  });

  it('serves no route a plain member could write instructions through: the artifact is the dispatched run\'s to file', async () => {
    const { env, token, sqlite } = await harness();
    const res = await worker.fetch(memberPost(token.token, { agentId: AGENT, content: 'first', inputHash: 'h1' }, '/runs/cortex-instructions'), env);
    expect(res.status).toBe(401);
    expect((sqlite.query(`SELECT COUNT(*) c FROM cortex_instructions`).get() as { c: number }).c).toBe(0);
  });
});

describe('failure and resume admission over HTTP', () => {
  const claim = (id: string, task = 'digest') =>
    ({ id, agentId: AGENT, task, capability: 'cortex' });

  it('classifies an ordinary failure as resumable and keeps its checkpoint', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', claim('r1'));
    sqlite.query(`UPDATE agent_runs SET checkpoints = '{"phase":1}' WHERE id='r1'`).run();

    const res = await post('/runs/failed', { runId: 'r1', errorClass: 'other', error: 'boom' });
    expect({ resumable: res.resumable, status: res.status, cleared: res.clearCheckpoints })
      .toEqual({ resumable: true, status: 'ready', cleared: false });
    const row = sqlite.query(`SELECT resumable, resume_status s, checkpoints c FROM agent_runs WHERE id='r1'`).get() as { resumable: number; s: string; c: string };
    expect(row).toEqual({ resumable: 0 + 1, s: 'ready', c: '{"phase":1}' });
  });

  it('discards the poisoned checkpoint with the same write that records the failure', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', claim('r1'));
    sqlite.query(`UPDATE agent_runs SET checkpoints = '{"ref":"dead"}' WHERE id='r1'`).run();

    await post('/runs/failed', { runId: 'r1', errorClass: 'session-expired', error: 'session gone', wasResume: true, hadPriorSession: true });
    const row = sqlite.query(`SELECT resumable, resume_status s, checkpoints c FROM agent_runs WHERE id='r1'`).get() as { resumable: number; s: string; c: string | null };
    expect(row).toEqual({ resumable: 0, s: 'session_expired', c: null });
  });

  it('decides the class from what was observed, never from a class the caller asserts', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', claim('r1'));
    // A caller claiming session-expired without having been a resume gets the
    // ordinary answer: the guard needs all three observations.
    const res = await post('/runs/failed', { runId: 'r1', errorClass: 'session-expired', error: 'x', resumable: 0, status: 'exhausted' });
    expect(res.status).toBe('ready');
    expect((sqlite.query(`SELECT resume_status s FROM agent_runs WHERE id='r1'`).get() as { s: string }).s).toBe('ready');
  });

  it('refuses an error class it does not know rather than mapping it to a default', async () => {
    const { post } = await harness();
    await post('/runs/claim', claim('r1'));
    const res = await post('/runs/failed', { runId: 'r1', errorClass: 'invented', error: 'x' });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
  });

  it('admits a resume and consumes an attempt, then exhausts at the cap', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', claim('r1'));
    await post('/runs/failed', { runId: 'r1', errorClass: 'other', error: 'boom' });

    for (let i = 1; i <= 3; i += 1) {
      expect(await post('/runs/resume-admission', { runId: 'r1' })).toEqual({ persisted: true, admit: true, attempt: i });
    }
    expect(await post('/runs/resume-admission', { runId: 'r1' })).toEqual({ persisted: true, admit: false, status: 'exhausted' });
    expect((sqlite.query(`SELECT resumable, resume_status s FROM agent_runs WHERE id='r1'`).get() as { resumable: number; s: string }))
      .toEqual({ resumable: 0, s: 'exhausted' });
  });

  it('refuses to resume a run already retired, reporting why it was retired', async () => {
    const { post } = await harness();
    await post('/runs/claim', claim('r1'));
    await post('/runs/failed', { runId: 'r1', errorClass: 'session-expired', error: 'x', wasResume: true, hadPriorSession: true });
    expect(await post('/runs/resume-admission', { runId: 'r1' }))
      .toEqual({ persisted: true, admit: false, status: 'session_expired' });
  });

  it('answers absent for a run this Project does not hold', async () => {
    const { post } = await harness();
    expect(await post('/runs/resume-admission', { runId: 'nope' }))
      .toEqual({ persisted: true, admit: false, status: 'absent' });
  });
});

describe('POST /runs/report and /runs/events', () => {
  it('writes a report against a claimed run and reads it back; a run this Project does not hold is refused', async () => {
    const { post } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    const written = await post('/runs/report', { runId: 'r1', agentId: AGENT, action: 'summary', summary: 'the finding', details: '{"n":1}' });
    expect(written).toEqual({ persisted: true, recorded: true });
    const read = await post('/runs/reports', { runId: 'r1' });
    expect((read.reports as Array<{ action: string; summary: string }>).map((r) => [r.action, r.summary])).toEqual([['summary', 'the finding']]);

    const foreign = await post('/runs/report', { runId: 'r_unknown', agentId: AGENT, action: 'a', summary: 's' });
    expect(foreign.persisted).toBe(false);

    const ghost = await post('/runs/report', { runId: 'r1', agentId: 'agent_nobody_knows', action: 'a', summary: 's' });
    expect(ghost.persisted).toBe(false);
  });

  it('records an event burst with tenancy anchored on the run, refuses an unknown eventType, and bounds the burst', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    const burst = await post('/runs/events', { events: [
      { runId: 'r1', eventType: 'phase_start', phaseName: 'p1' },
      { runId: 'r1', eventType: 'post_tool_use', toolName: 'vault_report', outcome: 'success', durationMs: 12, payload: '{}' },
      { runId: 'r_unknown', eventType: 'phase_end' },
    ] });
    expect(burst).toEqual({ persisted: true, recorded: 2 });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_run_events WHERE run_id = 'r1'`).get() as { c: number }).c).toBe(2);

    const bad = await post('/runs/events', { events: [{ runId: 'r1', eventType: 'not_a_kind' }] });
    expect(bad.persisted).toBe(false);
    const over = await post('/runs/events', { events: Array.from({ length: 33 }, () => ({ runId: 'r1', eventType: 'phase_start' })) });
    expect(over.persisted).toBe(false);
    const clock = await post('/runs/events', { events: [{ runId: 'r1', eventType: 'phase_start', recordedAt: 'yesterday' }] });
    expect(clock.persisted).toBe(false);
  });

  it('truncates an oversized payload rather than dropping the event, and takes a full 32-event burst', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    const big = await post('/runs/events', { events: [{ runId: 'r1', eventType: 'post_tool_use', payload: 'x'.repeat(20_000) }] });
    expect(big).toEqual({ persisted: true, recorded: 1 });
    const row = sqlite.query(`SELECT LENGTH(payload) l FROM agent_run_events WHERE run_id = 'r1'`).get() as { l: number };
    expect(row.l).toBe(16_384);
    const full = await post('/runs/events', { events: Array.from({ length: 32 }, () => ({ runId: 'r1', eventType: 'phase_start' })) });
    expect(full).toEqual({ persisted: true, recorded: 32 });
  });
});

describe('POST /runs/update at a terminal status from the dispatched runtime', () => {
  async function dispatchedRun(opts: { endRunThrows?: boolean } = {}) {
    const fixture = sqliteEnv();
    const now = Date.now();
    fixture.sqlite.query(`INSERT OR IGNORE INTO members (id, label, created_at, revoked_at) VALUES ('mem_harness', 'harness runtime', ?, NULL)`).run(now);
    fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(now);
    fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, now);
    fixture.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(now);
    const minted = await issueMemberToken(fixture.db, { memberId: 'mem_harness', machineId: 'harness' }, now);
    const ended: string[] = [];
    const endRun = async (name: string) => {
      if (opts.endRunThrows) throw new Error('durable object unreachable');
      ended.push(name);
    };
    const env = { ...fixture.env, ...OWNER_ENV, HARNESS: { idFromName: (name: string) => ({ name }), get: (id: { name: string }) => ({ endRun: () => endRun(id.name) }) } };
    const post = async (token: string, path: string, body: unknown): Promise<Record<string, unknown>> =>
      await (await worker.fetch(memberPost(token, body, path), env)).json() as Record<string, unknown>;
    const credRevokedAt = (tokenId: string): unknown => (fixture.sqlite.query(`SELECT revoked_at r FROM member_credentials WHERE id = ?`).get(tokenId) as { r: unknown }).r;
    // The runtime member claims only a run the server dispatched under its credential: the dispatch record comes first.
    const dispatch = (runId: string, credential: { tokenId: string }) =>
      recordDispatch(fixture.db, { projectId: 'proj_1' }, { id: runId, agentId: AGENT, task: 'digest', provider: null, model: null, runContext: null, dispatchedBy: credential.tokenId, startedAt: now });
    return { ...fixture, env, minted, ended, post, credRevokedAt, dispatch };
  }

  it('releases the container hold, revokes its own credential, and admits no further write on it', async () => {
    const { env, minted, ended, post, credRevokedAt, dispatch } = await dispatchedRun();
    await dispatch('run_t1', minted);
    const claim = await post(minted.token, '/runs/claim', { id: 'run_t1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);

    const progress = await post(minted.token, '/runs/update', { runId: 'run_t1', update: { tokens_used: 5 } });
    expect({ persisted: progress.persisted, changed: progress.changed, ended: ended.length, revoked: credRevokedAt(minted.tokenId) }).toEqual({ persisted: true, changed: 1, ended: 0, revoked: null });

    const terminal = await post(minted.token, '/runs/update', { runId: 'run_t1', update: { status: 'completed', completed_at: Date.now() } });
    expect({ persisted: terminal.persisted, changed: terminal.changed, ended }).toEqual({ persisted: true, changed: 1, ended: ['run_t1'] });
    expect(typeof credRevokedAt(minted.tokenId)).toBe('number');

    const after = await worker.fetch(memberPost(minted.token, { runId: 'run_t1', update: { tokens_used: 6 } }, '/runs/update'), env);
    expect(after.status).toBe(401);
  });

  it('still revokes the credential when the runtime release itself fails, at the skipped status too', async () => {
    const { minted, post, credRevokedAt, dispatch } = await dispatchedRun({ endRunThrows: true });
    await dispatch('run_t2', minted);
    const claim = await post(minted.token, '/runs/claim', { id: 'run_t2', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);
    const terminal = await post(minted.token, '/runs/update', { runId: 'run_t2', update: { status: 'skipped', completed_at: Date.now() } });
    expect({ persisted: terminal.persisted, changed: terminal.changed }).toEqual({ persisted: true, changed: 1 });
    expect(typeof credRevokedAt(minted.tokenId)).toBe('number');
  });

  it("keys the release on the run's own dispatched_by: a sibling run's terminal write releases nothing", async () => {
    const { db, minted, ended, post, credRevokedAt, dispatch } = await dispatchedRun();
    const sibling = await issueMemberToken(db, { memberId: 'mem_harness', machineId: 'harness' }, Date.now());
    await dispatch('run_t3', sibling);
    const claim = await post(sibling.token, '/runs/claim', { id: 'run_t3', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);
    const terminal = await post(minted.token, '/runs/update', { runId: 'run_t3', update: { status: 'completed', completed_at: Date.now() } });
    expect({ persisted: terminal.persisted, changed: terminal.changed, ended: ended.length }).toEqual({ persisted: true, changed: 1, ended: 0 });
    expect({ writer: credRevokedAt(minted.tokenId), dispatcher: credRevokedAt(sibling.tokenId) }).toEqual({ writer: null, dispatcher: null });
  });

  it('leaves any other member credential untouched at its terminal writes', async () => {
    const { db, ended, post, credRevokedAt } = await dispatchedRun();
    const member = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const claim = await post(member.token, '/runs/claim', { id: 'run_t4', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);
    const terminal = await post(member.token, '/runs/update', { runId: 'run_t4', update: { status: 'failed', completed_at: Date.now() } });
    expect({ persisted: terminal.persisted, changed: terminal.changed, ended }).toEqual({ persisted: true, changed: 1, ended: [] });
    expect(credRevokedAt(member.tokenId)).toBe(null);
  });

  it('releases through /runs/failed by the same rule: the classified failure is a terminal write too', async () => {
    const { minted, ended, post, credRevokedAt, dispatch } = await dispatchedRun();
    await dispatch('run_t5', minted);
    const claim = await post(minted.token, '/runs/claim', { id: 'run_t5', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);
    const failed = await post(minted.token, '/runs/failed', { runId: 'run_t5', error: 'provider unreachable', errorClass: 'other' });
    expect({ persisted: failed.persisted, changed: failed.changed, ended }).toEqual({ persisted: true, changed: 1, ended: ['run_t5'] });
    expect(typeof credRevokedAt(minted.tokenId)).toBe('number');
  });

  it('holds the release until an update actually lands: a terminal status for a run outside the Project changes nothing', async () => {
    const { minted, ended, post, credRevokedAt } = await dispatchedRun();
    const miss = await post(minted.token, '/runs/update', { runId: 'run_ghost', update: { status: 'completed' } });
    expect({ persisted: miss.persisted, changed: miss.changed, ended: ended.length, revoked: credRevokedAt(minted.tokenId) }).toEqual({ persisted: true, changed: 0, ended: 0, revoked: null });
  });
});

describe('POST /runs/update holds a run to what its task owes at close', () => {
  const sweep = async () => {
    const h = await harness();
    h.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'vault_evolution', 1, ?, 'test')`).run(Date.now());
    expect(await h.post('/runs/claim', { id: 'r_sweep', agentId: AGENT, task: 'supersession-sweep', capability: 'vault_evolution' })).toMatchObject({ claimed: true });
    return h;
  };
  const row = (h: Awaited<ReturnType<typeof harness>>) =>
    h.sqlite.query(`SELECT status, error FROM agent_runs WHERE id = 'r_sweep'`).get() as { status: string; error: string | null };

  it('records a sweep that closes without its report as a failure, and says the close did not land', async () => {
    const h = await sweep();
    expect(await h.post('/runs/update', { runId: 'r_sweep', update: { status: 'completed', completed_at: 42 } }))
      .toEqual({ persisted: true, changed: 1, applied: false, reason: 'postcondition' });
    expect(row(h)).toEqual({ status: 'failed', error: 'the run ended without its report' });
    // The refused close ended the run on the spot, and a second close finds the
    // row terminal ahead of anything the task owes.
    await h.post('/runs/report', { runId: 'r_sweep', agentId: AGENT, action: 'skip', summary: 'nothing found' });
    expect(await h.post('/runs/update', { runId: 'r_sweep', update: { status: 'completed', completed_at: 43 } }))
      .toEqual({ persisted: true, changed: 0, applied: false, reason: 'terminal' });
    expect(row(h)).toEqual({ status: 'failed', error: 'the run ended without its report' });
  });

  it('closes a sweep that recorded its report, whatever counts the report carries', async () => {
    const h = await sweep();
    await h.post('/runs/report', { runId: 'r_sweep', agentId: AGENT, action: 'supersession', summary: 'nothing to merge', details: JSON.stringify({ reviewed: 9, superseded: 0, consolidated: 0, obsoleted: 0 }) });
    expect(await h.post('/runs/update', { runId: 'r_sweep', update: { status: 'completed', completed_at: 44 } }))
      .toEqual({ persisted: true, changed: 1 });
    expect(row(h)).toEqual({ status: 'completed', error: null });
  });

  it('holds only the tasks that owe a report, and never a run moving to a status other than completed', async () => {
    const h = await sweep();
    expect(await h.post('/runs/update', { runId: 'r_sweep', update: { status: 'skipped', completed_at: 45 } })).toEqual({ persisted: true, changed: 1 });
    await h.post('/runs/claim', { id: 'r_digest', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await h.post('/runs/update', { runId: 'r_digest', update: { status: 'completed', completed_at: 46 } })).toEqual({ persisted: true, changed: 1 });
  });
});
