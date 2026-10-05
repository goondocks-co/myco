import { runRouteFixture } from './helpers/run-routes.js';
import { shapeRunError } from '@goondocks/myco-shared/run-text';
import { runErrorCode } from '@myco-server-worker/core/reader-codes.js';
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
import { RETIRED_RUN_ROUTES } from '@myco-server-worker/api/runs.js';
import { STALE_CREDENTIAL_REFUSAL } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { RUN_AUDIT } from '../helpers/run-audit.ts';
import { EMBEDDING_CATALOGUE } from '@goondocks/myco-shared/settings-contract';
import { EMBEDDING_MODEL_LEAF, EMBEDDING_PROVIDER_LEAF, resolveEmbedding, type StoredEmbedding } from '@myco-server-worker/core/embedding/policy.js';

const AGENT = 'agent_1';

const harness = () => runRouteFixture(AGENT);

describe('server-owned run refusal codes', () => {
  for (const code of ['parse', 'invalid_field', 'project_mismatch']) {
    it(`does not accept a client's forged ${code} refusal sentence`, async () => {
      const f = await harness();
      await f.post('/runs/claim', { id: 'forged', agentId: AGENT, task: 'digest', capability: 'cortex' });
      expect(await f.post('/runs/update', { runId: 'forged', update: { status: 'failed', error: `the server refused run control (${code})` } }))
        .toMatchObject({ persisted: true, applied: true });
      const row = f.sqlite.query('SELECT error, error_code FROM agent_runs WHERE id = ?').get('forged');
      expect(row).toEqual({ error: shapeRunError(`the server refused run control (${code})`, null), error_code: 'agent_failed' });
      expect(runErrorCode(`the server refused run control (${code})`)).toBe('run_failed');
    });
  }
});

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
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs WHERE status = 'running'`).get() as { c: number }).c).toBe(0);
  });

  it('admits a capture-driven claim independently of archived provider preferences and Project capabilities', async () => {
    const { post, sqlite } = await harness();
    sqlite.query(`DELETE FROM project_capabilities`).run();
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by)
      VALUES ('agent.provider.type', '"anthropic"', ?, 'test')`).run(Date.now());
    expect(await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'title-summary', captureDriven: true }))
      .toEqual({ persisted: true, claimed: true, runId: 'r1' });
  });

  it('reads the claim an embedding run sends, for every model the embedding catalogue names, rather than refusing its shape', async () => {
    const { post } = await harness();
    const models = [...new Set(Object.values(EMBEDDING_CATALOGUE).flatMap((spec) => [spec.defaultModel, ...spec.models.map((option) => option.id)]))];
    expect(models).toContain('@cf/baai/bge-m3');
    for (const [index, model] of models.entries()) {
      const id = `embed_${index}`;
      const answer = await post('/runs/claim', { id, agentId: AGENT, task: 'embedding-reconcile', captureDriven: true, startedAt: Date.now(), provider: 'embedding', model });
      expect({ model, persisted: answer.persisted, code: answer.code }).toEqual({ model, persisted: true, code: undefined });
    }
  });

  it('reads the claim an embedding run sends with the partition identity its dispatch names as the model', async () => {
    const { post } = await harness();
    const stored: StoredEmbedding[] = [
      {},
      { [EMBEDDING_PROVIDER_LEAF]: 'ollama', [EMBEDDING_MODEL_LEAF]: '' },
      ...EMBEDDING_CATALOGUE['workers-ai'].models.map((option): StoredEmbedding => ({ [EMBEDDING_PROVIDER_LEAF]: 'workers-ai', [EMBEDDING_MODEL_LEAF]: option.id })),
    ];
    for (const [index, settings] of stored.entries()) {
      const modelKey = resolveEmbedding(settings, 'cloudflare').selection?.modelKey;
      expect({ settings, resolved: typeof modelKey }).toEqual({ settings, resolved: 'string' });
      const id = `embed_key_${index}`;
      const answer = await post('/runs/claim', { id, agentId: AGENT, task: 'embedding-reconcile', captureDriven: true, startedAt: Date.now(), provider: 'embedding', model: modelKey });
      expect({ modelKey, persisted: answer.persisted, code: answer.code }).toEqual({ modelKey, persisted: true, code: undefined });
    }
    expect(await post('/runs/claim', { id: 'embed_key_bad', agentId: AGENT, task: 'embedding-reconcile', captureDriven: true, provider: 'embedding', model: '["cloudflare","bad\u0000model"]' }))
      .toMatchObject({ persisted: false, code: 'parse' });
  });

  it('bounds embedding claim text, excludes controls, and keeps identifier validation for other tasks', async () => {
    const { post, sqlite } = await harness();
    for (const [i, model] of ['', 42, 'm'.repeat(1025), 'model\u0000name', 'model\u007fname', 'model\u0085name'].entries()) {
      expect(await post('/runs/claim', { id: `invalid_embedding_${i}`, agentId: AGENT, task: 'embedding-reconcile', captureDriven: true, model }))
        .toMatchObject({ persisted: false, code: 'parse' });
    }
    expect(await post('/runs/claim', { id: 'ordinary', agentId: AGENT, task: 'container-smoke', capability: 'cortex', model: 'custom model' }))
      .toMatchObject({ persisted: false, code: 'parse' });
    expect(sqlite.query("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'running'").get()).toEqual({ n: 0 });
    sqlite.close();
  });

  it('admits a capture-driven claim without archived provider configuration', async () => {
    const { post, sqlite } = await harness();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'title-summary', captureDriven: true });
    expect(res).toEqual({ persisted: true, claimed: true, runId: 'r1' });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(1);
  });

  it('refuses a claim naming no capability, so admission cannot be skipped by omission', async () => {
    const { post, sqlite } = await harness();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest' });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs WHERE status = 'running'`).get() as { c: number }).c).toBe(0);
  });

  it('refuses a malformed claim terminally, in the route shape and with a code', async () => {
    const { post, sqlite } = await harness();
    const res = await post('/runs/claim', { id: 'r1', agentId: AGENT });
    expect({ persisted: res.persisted, coded: typeof res.code === 'string' }).toEqual({ persisted: false, coded: true });
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs WHERE status = 'running'`).get() as { c: number }).c).toBe(0);
  });

  it('claims per project: the same task in another Project is not blocked', async () => {
    const { post, sqlite, env, token } = await harness();
    sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'proj_2', ?)`).run(Date.now());
    sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_2', 'cortex', 1, ?, 'test')`).run(Date.now());
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    const other = await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'digest', capability: 'cortex' }, 'proj_2');
    expect(other).toEqual({ persisted: true, claimed: true, runId: 'r2' });
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
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 42 } })).toEqual({ persisted: true, changed: 1, applied: true });
    expect((sqlite.query(`SELECT status FROM agent_runs WHERE id = 'r1'`).get() as { status: string }).status).toBe('completed');
  });

  it('keeps the ending a run already carries, whichever ending landed first', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 42 } })).toEqual({ persisted: true, changed: 1, applied: true });
    // The close releases the container, the container answers the release with an
    // ending of its own, and both writes are open at once. The row keeps the first.
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'failed', completed_at: 43, error: 'the runtime was replaced while the run was in flight' } }))
      .toEqual({ persisted: true, changed: 0, applied: false, reason: 'terminal' });
    expect(sqlite.query(`SELECT status, completed_at c, error FROM agent_runs WHERE id = 'r1'`).get())
      .toEqual({ status: 'completed', c: 42, error: null });

    await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r2', update: { status: 'failed', completed_at: 50, error: 'the harness stopped: error (crashed; exit code 1)' } })).toEqual({ persisted: true, changed: 1, applied: true });
    expect(await post('/runs/update', { runId: 'r2', update: { status: 'completed', completed_at: 51 } }))
      .toEqual({ persisted: true, changed: 0, applied: false, reason: 'terminal' });
    expect(sqlite.query(`SELECT status, error FROM agent_runs WHERE id = 'r2'`).get()).toEqual({ status: 'failed', error: 'the harness stopped: error (crashed; exit code 1)' });
  });

  it('applies a repeat of the ending a run already carries, so a retried close is not a refusal', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 42 } })).toEqual({ persisted: true, changed: 1, applied: true });
    expect(await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 43 } })).toEqual({ persisted: true, changed: 0, applied: true });
    expect(sqlite.query(`SELECT status, completed_at c FROM agent_runs WHERE id = 'r1'`).get()).toEqual({ status: 'completed', c: 42 });
  });

  it('refuses accounting writes after the run credential is released', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    await post('/runs/update', { runId: 'r1', update: { status: 'completed', completed_at: 42 } });
    expect(await post('/runs/update', { runId: 'r1', update: { tokens_used: 99, cost_usd: 1 } })).toEqual({ error: 'unauthorized' });
    expect(sqlite.query(`SELECT status, tokens_used t FROM agent_runs WHERE id = 'r1'`).get()).toEqual({ status: 'completed', t: null });
  });

  it('serves no route a plain member could write instructions through: the artifact is the dispatched run\'s to file', async () => {
    const { env, token, sqlite } = await harness();
    const res = await worker.fetch(memberPost(token.token, { agentId: AGENT, content: 'first', inputHash: 'h1' }, '/runs/cortex-instructions'), env);
    expect(res.status).toBe(401);
    expect((sqlite.query(`SELECT COUNT(*) c FROM cortex_instructions`).get() as { c: number }).c).toBe(0);
  });
});

describe('POST /runs/report', () => {
  it('writes a report against a claimed run; a run this Project does not hold, an agent it does not know and a task held to no rule are refused', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    const written = await post('/runs/report', { runId: 'r1', agentId: AGENT, action: 'container-smoke', summary: 'the finding', details: '{"n":1}' });
    expect(written).toEqual({ persisted: true, recorded: true });
    expect(sqlite.query(`SELECT action, summary, details FROM agent_reports WHERE run_id = 'r1'`).all()).toEqual([{ action: 'container-smoke', summary: 'the finding', details: '{"n":1}' }]);

    const foreign = await post('/runs/report', { runId: 'r_unknown', agentId: AGENT, action: 'container-smoke', summary: 's' });
    expect(foreign.persisted).toBe(false);
    const ghost = await post('/runs/report', { runId: 'r1', agentId: 'agent_nobody_knows', action: 'container-smoke', summary: 's' });
    expect(ghost.persisted).toBe(false);
    await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await post('/runs/report', { runId: 'r2', agentId: AGENT, action: 'summary', summary: 's' })).toMatchObject({ persisted: false, reason: 'a digest run closes under no rule, so it takes no report' });
  });
});

describe('the run routes no 2.0 path sends', () => {
  it('refuses each with route_retired and what replaced it, and stores nothing', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    sqlite.run(`UPDATE agent_runs SET status = 'failed', resumable = 1, resume_status = 'ready', resume_attempts = 2, checkpoints = '{"cursor":7}' WHERE id = 'r1'`);
    sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES ('proj_1', 'r1', ?, 'container-smoke', 'retained history', ?)`, [AGENT, Date.now()]);
    const snapshot = () => Object.fromEntries(['agent_runs', 'agent_reports', 'agent_run_events'].map((table) => [table, sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    const before = snapshot();
    const routes = new Set<string>();
    for (const [path, body] of [
      ['/runs/get', { runId: 'r1' }],
      ['/runs/failed', { runId: 'r1', errorClass: 'other', error: 'boom' }],
      ['/runs/resume-admission', { runId: 'r1' }],
      ['/runs/supersede', { excludeRunId: 'r1', agentId: AGENT, taskName: 'container-smoke', dryRun: false }],
      ['/runs/reports', { runId: 'r1' }],
      ['/runs/events', { events: [{ runId: 'r1', eventType: 'post_tool_use', toolName: 'Bash', payload: '{"toolInput":{"command":"cat .env"}}' }] }],
    ] as const) {
      routes.add(path);
      const answered = await post(path, body);
      expect({ path, persisted: answered.persisted, code: answered.code, retired: String(answered.reason).startsWith(`${path} is retired: `) })
        .toEqual({ path, persisted: false, code: 'route_retired', retired: true });
    }
    expect([...routes].sort()).toEqual(Object.keys(RETIRED_RUN_ROUTES).sort());
    expect(snapshot()).toEqual(before);
  });

  it('refuses every update column no runtime sets, and a claim that carries an instruction, with field_retired', async () => {
    const { post, sqlite } = await harness();
    await post('/runs/claim', { id: 'r1', agentId: AGENT, task: 'container-smoke', capability: 'cortex' });
    for (const column of ['actions_taken', 'run_context', 'checkpoints', 'session_ref', 'instruction', 'execution_overrides', 'task', 'harness', 'provider', 'model', 'resumable', 'resume_status', 'resume_mode', 'resumed_at', 'resume_attempts', 'dry_run', 'reasoning_level']) {
      const answered = await post('/runs/update', { runId: 'r1', update: { [column]: 'x' } });
      expect({ column, code: answered.code }).toEqual({ column, code: 'field_retired' });
    }
    expect(await post('/runs/claim', { id: 'r2', agentId: AGENT, task: 'container-smoke', capability: 'cortex', instruction: 'do it' })).toMatchObject({ persisted: false, code: 'field_retired' });
    expect(sqlite.query(`SELECT COUNT(*) c FROM agent_runs WHERE id = 'r2' AND status = 'running'`).get()).toEqual({ c: 0 });
  });
});

describe('POST /runs/update at a terminal status from the dispatched runtime', () => {
  async function dispatchedRun() {
    const fixture = sqliteEnv();
    const now = Date.now();
    fixture.sqlite.query(`INSERT OR IGNORE INTO members (id, label, created_at, revoked_at) VALUES ('mem_harness', 'harness runtime', ?, NULL)`).run(now);
    fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`).run(now);
    fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, now);
    fixture.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(now);
    const minted = await issueMemberToken(fixture.db, { memberId: 'mem_harness', machineId: 'harness' }, now);
    const env = { ...fixture.env, ...OWNER_ENV };
    const post = async (token: string, path: string, body: unknown): Promise<Record<string, unknown>> =>
      await (await worker.fetch(memberPost(token, body, path), env)).json() as Record<string, unknown>;
    const credRevokedAt = (tokenId: string): unknown => (fixture.sqlite.query(`SELECT revoked_at r FROM member_credentials WHERE id = ?`).get(tokenId) as { r: unknown }).r;
    // The runtime member claims only a run the server dispatched under its credential: the dispatch record comes first.
    const dispatch = (runId: string, credential: { tokenId: string }) =>
      recordDispatch(fixture.db, { projectId: 'proj_1' }, { id: runId, agentId: AGENT, task: 'digest', provider: null, model: null, runContext: null, dispatchedBy: credential.tokenId, startedAt: now });
    const run = (runId: string) => fixture.sqlite.query(`SELECT status, dispatched_by AS dispatchedBy FROM agent_runs WHERE id = ?`).get(runId) as { status: string; dispatchedBy: string | null } | null;
    return { ...fixture, env, minted, post, credRevokedAt, dispatch, run };
  }

  it('does not carry a refusal into a replacement dispatch credential', async () => {
    const f = await dispatchedRun();
    await f.dispatch('refusal-attempt', f.minted);
    const refused = await f.post(f.minted.token, '/runs/claim', { id: 'refusal-attempt', agentId: '', task: 'digest', capability: 'cortex' });
    expect(refused)
      .toMatchObject({ persisted: false, code: 'parse' });
    const next = await issueMemberToken(f.db, { memberId: 'mem_harness', machineId: 'harness' }, Date.now());
    f.sqlite.query('UPDATE agent_runs SET dispatched_by = ? WHERE id = ?').run(next.tokenId, 'refusal-attempt');
    expect(await f.post(next.token, '/runs/update', { runId: 'refusal-attempt', refusalId: refused.refusalId, update: { status: 'failed', error: 'the server refused run control (parse)' } }))
      .toMatchObject({ persisted: true, applied: true });
    expect(f.sqlite.query('SELECT error_code FROM agent_runs WHERE id = ?').get('refusal-attempt')).toEqual({ error_code: 'agent_failed' });
  });

  it('uses the terminal diagnostic when a refusal was recovered and the runtime sends no receipt', async () => {
    const f = await dispatchedRun();
    await f.dispatch('refusal-recovered', f.minted);
    expect(await f.post(f.minted.token, '/runs/claim', { id: 'refusal-recovered', agentId: '', task: 'digest', capability: 'cortex' }))
      .toMatchObject({ persisted: false, code: 'parse' });
    expect(await f.post(f.minted.token, '/runs/claim', { id: 'refusal-recovered', agentId: AGENT, task: 'digest', capability: 'cortex' }))
      .toMatchObject({ persisted: true, claimed: true });
    expect(await f.post(f.minted.token, '/runs/update', { runId: 'refusal-recovered', update: { status: 'failed', error: 'the worker reported a failure (timed_out)' } }))
      .toMatchObject({ persisted: true, applied: true });
    expect(f.sqlite.query('SELECT error_code FROM agent_runs WHERE id = ?').get('refusal-recovered')).toEqual({ error_code: 'agent_timed_out' });
  });

  for (const refusedFirst of [false, true]) {
    it(`preserves malformed historical context when closing a run, prior refusal: ${refusedFirst}`, async () => {
      const f = await dispatchedRun();
      await f.dispatch('legacy-context', f.minted);
      f.sqlite.query('UPDATE agent_runs SET run_context = ? WHERE id = ?').run('legacy malformed context', 'legacy-context');
      let refusalId: unknown;
      if (refusedFirst) {
        const refused = await f.post(f.minted.token, '/runs/claim', { id: 'legacy-context', agentId: '', task: 'digest', capability: 'cortex' });
        refusalId = refused.refusalId;
        expect(refused)
          .toMatchObject({ persisted: false, code: 'parse' });
      }
      expect(await f.post(f.minted.token, '/runs/update', { runId: 'legacy-context', refusalId, update: { status: 'failed', error: 'the worker reported a failure (timed_out)' } }))
        .toMatchObject({ persisted: true, applied: true });
      const row = f.sqlite.query('SELECT error_code, run_context FROM agent_runs WHERE id = ?').get('legacy-context') as { error_code: string; run_context: string };
      expect(row.error_code).toBe(refusedFirst ? 'parse' : 'agent_timed_out');
      expect(refusedFirst ? JSON.parse(row.run_context).unparsedRunContext : row.run_context).toBe('legacy malformed context');
    });
  }

  it('refuses another run credential changing error-only accounting on a sibling run', async () => {
    const f = await dispatchedRun();
    const sibling = await issueMemberToken(f.db, { memberId: 'mem_harness', machineId: 'harness' }, Date.now());
    await f.dispatch('own-run', f.minted);
    await f.dispatch('sibling-run', sibling);
    expect(await f.post(f.minted.token, '/runs/update', { runId: 'sibling-run', update: { error: 'the server refused run control (parse)' } }))
      .toMatchObject({ persisted: false, code: 'no_run' });
    expect(f.sqlite.query('SELECT error, error_code FROM agent_runs WHERE id = ?').get('sibling-run')).toEqual({ error: null, error_code: null });
  });

  it('keeps issued receipts across overlapping routes and resolves the receipt the runtime returns', async () => {
    const f = await dispatchedRun();
    await f.dispatch('refusal-overlap', f.minted);
    const claim = () => f.post(f.minted.token, '/runs/claim', { id: 'refusal-overlap', agentId: '', task: 'digest', capability: 'cortex' });
    const first = await claim();
    const [again, second, accepted] = await Promise.all([
      claim(),
      f.post(f.minted.token, '/runs/update', { runId: 'refusal-overlap', update: { cost_source: 'not a name' } }),
      f.post(f.minted.token, '/runs/update', { runId: 'refusal-overlap', update: { tokens_used: 5 } }),
    ]);
    expect({ ...first }).toMatchObject({ persisted: false, code: 'parse', refusalId: expect.any(String) });
    expect(again.refusalId).toBe(first.refusalId);
    expect({ ...second }).toMatchObject({ persisted: false, code: 'invalid_field', refusalId: expect.any(String) });
    expect(second.refusalId).not.toBe(first.refusalId);
    expect(accepted).toMatchObject({ persisted: true, applied: true });
    expect(await f.post(f.minted.token, '/runs/update', { runId: 'refusal-overlap', refusalId: first.refusalId,
      update: { status: 'failed', error: 'the server refused run control (invalid_field)' } })).toMatchObject({ persisted: true, applied: true });
    expect(f.sqlite.query('SELECT error_code FROM agent_runs WHERE id = ?').get('refusal-overlap')).toEqual({ error_code: 'parse' });
  });

  it('does not accept an invented receipt even after it issued another refusal', async () => {
    const f = await dispatchedRun();
    await f.dispatch('refusal-forged-receipt', f.minted);
    expect(await f.post(f.minted.token, '/runs/claim', { id: 'refusal-forged-receipt', agentId: '', task: 'digest', capability: 'cortex' }))
      .toMatchObject({ persisted: false, code: 'parse' });
    expect(await f.post(f.minted.token, '/runs/update', { runId: 'refusal-forged-receipt', refusalId: crypto.randomUUID(),
      update: { status: 'failed', error: 'the server refused run control (parse)' } })).toMatchObject({ persisted: true, applied: true });
    expect(f.sqlite.query('SELECT error_code FROM agent_runs WHERE id = ?').get('refusal-forged-receipt')).toEqual({ error_code: 'agent_failed' });
  });

  for (const status of [undefined, 'completed']) {
    it(`uses a refusal receipt only on a failed close, not status ${status}`, async () => {
      const f = await dispatchedRun();
      await f.dispatch('receipt-nonfailure', f.minted);
      const refusal = await f.post(f.minted.token, '/runs/claim', { id: 'receipt-nonfailure', agentId: '', task: 'digest', capability: 'cortex' });
      expect(await f.post(f.minted.token, '/runs/update', { runId: 'receipt-nonfailure', refusalId: refusal.refusalId,
        update: { ...(status === undefined ? {} : { status }), error: 'the server refused run control (parse)' } })).toMatchObject({ persisted: true, applied: true });
      expect(f.sqlite.query('SELECT error_code FROM agent_runs WHERE id = ?').get('receipt-nonfailure')).toEqual({ error_code: 'agent_failed' });
    });
  }

  it('revokes its own credential at a terminal status, and admits no further write on it', async () => {
    const { env, minted, post, credRevokedAt, dispatch } = await dispatchedRun();
    await dispatch('run_t1', minted);
    const claim = await post(minted.token, '/runs/claim', { id: 'run_t1', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);

    const progress = await post(minted.token, '/runs/update', { runId: 'run_t1', update: { tokens_used: 5 } });
    expect({ persisted: progress.persisted, changed: progress.changed, revoked: credRevokedAt(minted.tokenId) }).toEqual({ persisted: true, changed: 1, revoked: null });

    const terminal = await post(minted.token, '/runs/update', { runId: 'run_t1', update: { status: 'completed', completed_at: Date.now() } });
    expect({ persisted: terminal.persisted, changed: terminal.changed }).toEqual({ persisted: true, changed: 1 });
    expect(typeof credRevokedAt(minted.tokenId)).toBe('number');

    const after = await worker.fetch(memberPost(minted.token, { runId: 'run_t1', update: { tokens_used: 6 } }, '/runs/update'), env);
    expect(after.status).toBe(401);
  });

  it('revokes the credential at the skipped status too', async () => {
    const { minted, post, credRevokedAt, dispatch } = await dispatchedRun();
    await dispatch('run_t2', minted);
    const claim = await post(minted.token, '/runs/claim', { id: 'run_t2', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);
    const terminal = await post(minted.token, '/runs/update', { runId: 'run_t2', update: { status: 'skipped', completed_at: Date.now() } });
    expect({ persisted: terminal.persisted, changed: terminal.changed, applied: terminal.applied }).toEqual({ persisted: true, changed: 1, applied: true });
    expect(typeof credRevokedAt(minted.tokenId)).toBe('number');
  });

  it('answers the credential refusal before it answers what the row already ended as', async () => {
    // A stale post to a run that has already closed learns which of the two it
    // is: the credential is the caller's problem, and the ending is not its
    // business at all.
    const { db, minted, post, dispatch, run } = await dispatchedRun();
    const sibling = await issueMemberToken(db, { memberId: 'mem_harness', machineId: 'harness' }, Date.now());
    await dispatch('run_t7', sibling);
    expect((await post(sibling.token, '/runs/claim', { id: 'run_t7', agentId: AGENT, task: 'digest', capability: 'cortex' })).claimed).toBe(true);
    expect((await post(sibling.token, '/runs/update', { runId: 'run_t7', update: { status: 'completed', completed_at: Date.now() } })).applied).toBe(true);
    expect(run('run_t7')?.status).toBe('completed');

    const answered = await post(minted.token, '/runs/update', { runId: 'run_t7', update: { status: 'failed', completed_at: Date.now() } });
    expect({ persisted: answered.persisted, reason: answered.reason }).toEqual({ persisted: false, reason: 'credential holds no live run' });
  });

  it('refuses a failure recorded under a credential the row does not name, and queues no successor for it', async () => {
    const { db, minted, post, dispatch, run, sqlite } = await dispatchedRun();
    const sibling = await issueMemberToken(db, { memberId: 'mem_harness', machineId: 'harness' }, Date.now());
    await dispatch('run_t6', sibling);
    expect((await post(sibling.token, '/runs/claim', { id: 'run_t6', agentId: AGENT, task: 'digest', capability: 'cortex' })).claimed).toBe(true);

    // A failure can ask for a successor; it is keyed on the row's credential.
    const failed = await post(minted.token, '/runs/update', { runId: 'run_t6', update: { status: 'failed', completed_at: Date.now(), error: 'stale' }, replaced: true });
    expect({ persisted: failed.persisted, reason: failed.reason }).toEqual({ persisted: false, reason: 'credential holds no live run' });
    expect(run('run_t6')?.status).toBe('running');
    expect((sqlite.query(`SELECT COUNT(*) c FROM agent_runs`).get() as { c: number }).c).toBe(1);
  });

  it("refuses a status write under a credential the run's row does not name, and leaves the row as it stands", async () => {
    // The shape a relaunch makes: an earlier attempt's runtime, or the
    // supervisor closing for it, posting onto a row that has moved on. Ending
    // that run would kill work its successor is doing.
    const { db, minted, post, credRevokedAt, dispatch, run } = await dispatchedRun();
    const sibling = await issueMemberToken(db, { memberId: 'mem_harness', machineId: 'harness' }, Date.now());
    await dispatch('run_t3', sibling);
    const claim = await post(sibling.token, '/runs/claim', { id: 'run_t3', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.claimed).toBe(true);

    const terminal = await post(minted.token, '/runs/update', { runId: 'run_t3', update: { status: 'completed', completed_at: Date.now() } });
    expect({ persisted: terminal.persisted, reason: terminal.reason }).toEqual({ persisted: false, reason: 'credential holds no live run' });
    expect(run('run_t3')?.status).toBe('running');
    expect({ writer: credRevokedAt(minted.tokenId), dispatcher: credRevokedAt(sibling.tokenId) }).toEqual({ writer: null, dispatcher: null });

    // The credential the row does name closes it.
    const own = await post(sibling.token, '/runs/update', { runId: 'run_t3', update: { status: 'completed', completed_at: Date.now() } });
    expect({ persisted: own.persisted, applied: own.applied }).toEqual({ persisted: true, applied: true });
    expect(run('run_t3')?.status).toBe('completed');
  });

  it('refuses member claims and terminal writes without revoking their credential', async () => {
    const { db, post, credRevokedAt } = await dispatchedRun();
    const member = await issueMemberToken(db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const claim = await post(member.token, '/runs/claim', { id: 'run_t4', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(claim.persisted).toBe(false);
    const terminal = await post(member.token, '/runs/update', { runId: 'run_t4', update: { status: 'failed', completed_at: Date.now() } });
    expect(terminal).toMatchObject({ persisted: false, code: 'run_scope' });
    expect(credRevokedAt(member.tokenId)).toBe(null);
  });

  it('holds the release until an update actually lands: a terminal status for a run outside the Project changes nothing', async () => {
    const { minted, post, credRevokedAt } = await dispatchedRun();
    const miss = await post(minted.token, '/runs/update', { runId: 'run_ghost', update: { status: 'completed' } });
    expect({ persisted: miss.persisted, changed: miss.changed, revoked: credRevokedAt(minted.tokenId) }).toEqual({ persisted: false, changed: undefined, revoked: null });
  });
});

describe('POST /runs/update holds a run to what its task owes at close', () => {
  const sweep = async () => {
    const h = await harness();
    h.sqlite.query(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'vault_evolution', 1, ?, 'test')`).run(Date.now());
    expect(await h.post('/runs/claim', { id: 'r_sweep', agentId: AGENT, task: 'extract-curate', capability: 'vault_evolution' })).toMatchObject({ claimed: true });
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

  it('closes a pass that recorded its skip, whatever counts the report carries', async () => {
    const h = await sweep();
    await h.post('/runs/report', { runId: 'r_sweep', agentId: AGENT, action: 'skip', summary: 'nothing to read', details: JSON.stringify({ prompts: 0 }), audit: RUN_AUDIT });
    expect(await h.post('/runs/update', { runId: 'r_sweep', update: { status: 'completed', completed_at: 44 } }))
      .toEqual({ persisted: true, changed: 1, applied: true });
    expect(row(h)).toEqual({ status: 'completed', error: null });
  });

  it('holds only the tasks that owe a report, and never a run moving to a status other than completed', async () => {
    const h = await sweep();
    expect(await h.post('/runs/update', { runId: 'r_sweep', update: { status: 'skipped', completed_at: 45 } })).toEqual({ persisted: true, changed: 1, applied: true });
    await h.post('/runs/claim', { id: 'r_digest', agentId: AGENT, task: 'digest', capability: 'cortex' });
    expect(await h.post('/runs/update', { runId: 'r_digest', update: { status: 'completed', completed_at: 46 } })).toEqual({ persisted: true, changed: 1, applied: true });
  });
});
