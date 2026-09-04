/**
 * The materialized tools against the real routes: a refused write is a tool
 * answer the model can act on, never a failed run; a caller holding no run is
 * told the session is not found. The sweep's tools survey by previews and pull
 * a body only when asked for one.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { insertSpore } from '@myco-server-worker/core/spores.js';
import { upsertDigest } from '@myco-server-worker/core/digests.js';
import { ServerClient } from '@myco/member/transport.js';
import {
  materializedCreateSporeTool, materializedReadDigestTool, materializedReportTool, materializedResolveSporeTool,
  materializedSessionMaterialTool, materializedSessionsTool, materializedSporeTool, materializedSporesTool,
  materializedUpdateSessionTool,
} from '@myco/agent/runtime/server-tools.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

const budget = { connectTimeoutMs: 5_000, requestTimeoutMs: 10_000 };
const textOf = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;

async function setup() {
  const e = sqliteEnv();
  const now = Date.now();
  e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.provider.type', '"anthropic"', ?, 'test')`, [now]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [now]);
  e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at, ended_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'claude-code', ?, ?)`, [now - 10_000, now, now - 10_000, now]);
  e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's1', 'p1', 'e1', 'hello', 'user', 'h1', ?, ?, 'tok_1', ?)`, [now - 9000, now - 9000, now - 9000]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, now, 'harness runtime');
  const minted = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
  const clientFor = (token: string) => new ServerClient(
    { serverUrl: 'https://s', token, projectId: 'proj_1' },
    ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      request.headers.set('cf-connecting-ip', '1.2.3.4');
      return worker.fetch(request, e.env);
    }) as typeof fetch,
  );
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_1', agentId: 'myco-agent', task: 'title-summary', provider: 'anthropic', model: null, runContext: JSON.stringify({ session_id: 's1', mode: 'claim' }), dispatchedBy: minted.tokenId, startedAt: now });
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_sweep', agentId: 'myco-agent', task: 'supersession-sweep', provider: 'anthropic', model: null, runContext: JSON.stringify({ session_id: 's1' }), dispatchedBy: minted.tokenId, startedAt: now });
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_smoke', agentId: 'myco-agent', task: 'container-smoke', provider: 'anthropic', model: null, runContext: null, dispatchedBy: minted.tokenId, startedAt: now });
  await recordDispatch(e.db, { projectId: 'proj_1' }, { id: 'run_cortex', agentId: 'myco-agent', task: 'cortex-instructions', provider: 'anthropic', model: null, runContext: JSON.stringify({ input_hash: 'server-hash' }), dispatchedBy: minted.tokenId, startedAt: now });
  e.sqlite.run(`UPDATE agent_runs SET status = 'running' WHERE id IN ('run_1', 'run_sweep', 'run_smoke', 'run_cortex')`);
  return { ...e, now, client: clientFor(minted.token) };
}

describe('the title run\'s tools', () => {
  it('read the material, answer a refused write as a tool error, and write when the title fits', async () => {
    const { client, sqlite } = await setup();
    const ctx = { client, budget, runId: 'run_1', agentId: 'myco-agent' };
    const counter = { writes: 0 };
    const material = textOf(await materializedSessionMaterialTool(ctx).handler({ session_id: 's1' }, {}));
    expect({ status: material.status, batches: material.batches }).toEqual({ status: 'completed', batches: [{ prompt_number: 1, user_prompt: 'hello', response_excerpt: null }] });

    const update = materializedUpdateSessionTool(ctx, counter);
    expect(textOf(await update.handler({ session_id: 's1', title: 't'.repeat(81), summary: 'ok' }, {})).error).toContain('a title is 1 to 80 characters');
    expect(textOf(await update.handler({ session_id: 's1', title: 'Half' }, {})).error).toContain('both title and summary are required');
    expect(textOf(await update.handler({ session_id: 's_other', title: 'T', summary: 'S' }, {})).error).toBe('Session not found: s_other');
    expect(counter.writes).toBe(0);

    expect(textOf(await update.handler({ session_id: 's1', title: 'Retry added', summary: 'Added a retry.' }, {}))).toEqual({ session_id: 's1', title: 'Retry added', summary: 'Added a retry.' });
    expect(counter.writes).toBe(1);
    expect(sqlite.query(`SELECT title, summary FROM sessions WHERE session_id = 's1'`).get()).toEqual({ title: 'Retry added', summary: 'Added a retry.' });
    expect(textOf(await update.handler({ session_id: 's1', title: 'Again', summary: 'again' }, {})).error).toContain('already carries a title');
  });
});

describe('the sweep run\'s tools', () => {
  it('survey by preview, read one body in full, record a wisdom spore and resolve its sources', async () => {
    const { client, sqlite, db, now } = await setup();
    const ctx = { client, budget, runId: 'run_sweep', agentId: 'myco-agent' };
    const counter = { writes: 0 };
    const body = `${'z'.repeat(400)} tail`;
    for (const id of ['sp_a', 'sp_b', 'sp_c']) {
      await insertSpore(db, { projectId: 'proj_1' }, {
        id, agentId: 'myco-agent', sessionId: null, promptId: null, observationType: 'gotcha',
        content: id === 'sp_a' ? body : `${id} body`, context: null, filePath: null, tags: null,
        contentHash: null, properties: null, createdAt: now - 1_000,
      });
    }

    const inventory = textOf(await materializedSporesTool(ctx).handler({ status: 'active' }, {}));
    expect(inventory.total).toBe(3);
    expect((inventory.spores as Array<{ preview: string }>).every((s) => s.preview.length <= 200)).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain('tail');

    const one = textOf(await materializedSporeTool(ctx).handler({ id: 'sp_a' }, {}));
    expect((one.spore as { content: string }).content).toBe(body);
    expect(textOf(await materializedSporeTool(ctx).handler({ id: 'nope' }, {})).error).toBe('Spore not found: nope');

    const create = materializedCreateSporeTool(ctx, counter);
    const wisdom = textOf(await create.handler({ observation_type: 'wisdom', content: 'the merged note', tags: ['sweep'] }, {}));
    const wisdomId = (wisdom.spore as { id: string }).id;
    expect((wisdom.spore as { sessionId: string; agentId: string }).sessionId).toBe('s1');
    expect(counter.writes).toBe(1);

    const resolve = materializedResolveSporeTool(ctx, counter);
    expect(textOf(await resolve.handler({ spore_id: 'sp_a', action: 'consolidate', new_spore_id: wisdomId }, {})))
      .toEqual({ action: 'consolidate', spore: 'sp_a' });
    expect(textOf(await resolve.handler({ spore_id: 'sp_b', action: 'supersede', new_spore_id: 'sp_c', reason: 'sp_c is complete' }, {})))
      .toEqual({ action: 'supersede', spore: 'sp_b' });
    expect(textOf(await resolve.handler({ spore_id: 'sp_c', action: 'obsolete' }, {})).error).toContain('reason is required for op: obsolete');
    expect(textOf(await resolve.handler({ spore_id: 'nope', action: 'obsolete', reason: 'gone' }, {})).error).toBe('Spore not found: nope');
    expect(counter.writes).toBe(3);

    // The full reads are counted per run: past the budget the tool says so rather than serving another body.
    let spent: Record<string, unknown> = {};
    for (let read = 0; read < 20; read += 1) {
      spent = textOf(await materializedSporeTool(ctx).handler({ id: 'sp_c' }, {}));
      if (typeof spent.error === 'string') break;
    }
    expect(spent.error).toContain('full-read budget');
    expect(sqlite.query(`SELECT id, status FROM spores WHERE id IN ('sp_a','sp_b','sp_c') ORDER BY id`).all())
      .toEqual([{ id: 'sp_a', status: 'consolidated' }, { id: 'sp_b', status: 'superseded' }, { id: 'sp_c', status: 'active' }]);
  });

  it('answer a run that holds no such surface as a tool error, writing nothing', async () => {
    const { client, sqlite } = await setup();
    const ctx = { client, budget, runId: 'run_smoke', agentId: 'myco-agent' };
    const counter = { writes: 0 };
    const answers = [
      textOf(await materializedSporesTool(ctx).handler({}, {})),
      textOf(await materializedSporeTool(ctx).handler({ id: 'sp_a' }, {})),
      textOf(await materializedCreateSporeTool(ctx, counter).handler({ observation_type: 'gotcha', content: 'c' }, {})),
      textOf(await materializedResolveSporeTool(ctx, counter).handler({ spore_id: 'sp_a', action: 'obsolete', reason: 'r' }, {})),
    ];
    expect(answers).toEqual(answers.map(() => ({ error: 'this run holds no such surface' })));
    expect(counter.writes).toBe(0);
    expect(sqlite.query(`SELECT COUNT(*) c FROM spores`).get()).toEqual({ c: 0 });
  });
});

describe('the instructions run\'s tools', () => {
  it('read the settled sessions and the digest, and never a session still in flight', async () => {
    const { client, sqlite, db, now } = await setup();
    const ctx = { client, budget, runId: 'run_cortex', agentId: 'myco-agent' };
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at) VALUES ('proj_1', 's_live', 'm1', 'tok_1', ?, ?, 'claude-code', ?)`, [now, now, now]);
    await upsertDigest(db, { projectId: 'proj_1' }, { id: 'd1', agentId: 'myco-agent', tier: 5000, content: 'the digest', substrateHash: null, generatedAt: now });

    const listed = textOf(await materializedSessionsTool(ctx).handler({ limit: 10 }, {}));
    expect((listed.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual(['s1']);

    expect(textOf(await materializedReadDigestTool(ctx).handler({ tier: 5000 }, {})))
      .toEqual({ digest: { tier: 5000, content: 'the digest', generatedAt: now } });
    expect(textOf(await materializedReadDigestTool(ctx).handler({}, {})))
      .toEqual({ tiers: [{ tier: 5000, generatedAt: now, contentLength: 10 }] });
  });

  it('files the artifact through the report, under the hash the run row carries', async () => {
    const { client, sqlite } = await setup();
    const ctx = { client, budget, runId: 'run_cortex', agentId: 'myco-agent' };
    const counter = { reports: 0 };
    const report = materializedReportTool(ctx, counter);
    const answer = await report.handler({ action: 'cortex_instructions', summary: 'wrote them', details: { content: '# Start here' } }, {});
    expect((answer as { content: Array<{ text: string }> }).content[0]!.text).toBe('report recorded: cortex_instructions');
    expect(counter.reports).toBe(1);
    expect(sqlite.query(`SELECT content, input_hash AS inputHash, source_run_id AS sourceRunId FROM cortex_instructions`).all())
      .toEqual([{ content: '# Start here', inputHash: 'server-hash', sourceRunId: 'run_cortex' }]);
    expect(sqlite.query(`SELECT action FROM agent_reports WHERE run_id = 'run_cortex'`).all()).toEqual([{ action: 'cortex_instructions' }]);
  });

  it('records the report even when the artifact is refused, and says so to the model', async () => {
    const { client, sqlite } = await setup();
    // A run of another task holds no instructions surface: the write is refused and the report still lands.
    const ctx = { client, budget, runId: 'run_smoke', agentId: 'myco-agent' };
    const counter = { reports: 0 };
    const answer = await materializedReportTool(ctx, counter).handler({ action: 'cortex_instructions', summary: 'tried', details: { content: '# nope' } }, {});
    expect(textOf(answer).error).toContain('holds no instructions surface');
    expect(counter.reports).toBe(1);
    expect(sqlite.query(`SELECT COUNT(*) c FROM cortex_instructions`).get()).toEqual({ c: 0 });
    expect(sqlite.query(`SELECT action FROM agent_reports WHERE run_id = 'run_smoke'`).all()).toEqual([{ action: 'cortex_instructions' }]);
  });

  it('leaves an ordinary report alone', async () => {
    const { client, sqlite } = await setup();
    const ctx = { client, budget, runId: 'run_cortex', agentId: 'myco-agent' };
    const counter = { reports: 0 };
    await materializedReportTool(ctx, counter).handler({ action: 'skip', summary: 'nothing to do' }, {});
    expect(sqlite.query(`SELECT COUNT(*) c FROM cortex_instructions`).get()).toEqual({ c: 0 });
    expect(counter.reports).toBe(1);
  });
});
