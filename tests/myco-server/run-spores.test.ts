/**
 * The four routes a sweep run reads and writes through, driven over the
 * deployed entry: admitted only to the harness credential that dispatched a
 * live `supersession-sweep` run, answering an inventory of previews rather than
 * bodies, and validating a resolution in the same words the member's tool does.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { insertSpore, SPORE_PREVIEW_CHARS } from '@myco-server-worker/core/spores.js';
import { OWNER_TITLING_WINDOW_MS } from '@myco-server-worker/core/titling.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_700_000_000_000;
const SWEEP = 'supersession-sweep';
const LONG = `${'a'.repeat(400)} tail`;

async function setup() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'vault_evolution', 1, ?, 'test')`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`, [NOW]);
  await ensureMember(e.db, HARNESS_MEMBER_ID, Date.now(), 'harness runtime');
  const harness = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
  const otherHarness = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
  const member = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());

  const session = (id: string) =>
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at)
                  VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [id, NOW - 10_000, NOW, NOW - 10_000, NOW]);
  const prompt = (sessionId: string, id: string, at: number) =>
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1', ?, ?, ?, 'hello', 'user', ?, ?, ?, 'tok_1', ?)`, [sessionId, id, `e_${id}`, `h_${id}`, at, at, at]);
  const spore = (id: string, over: { type?: string; content?: string; status?: string; createdAt?: number } = {}) =>
    insertSpore(e.db, { projectId: 'proj_1' }, {
      id, agentId: 'myco-agent', sessionId: null, promptId: null,
      observationType: over.type ?? 'gotcha', status: (over.status ?? 'active') as 'active',
      content: over.content ?? `${id} body`, context: null, filePath: null, tags: null,
      contentHash: null, properties: null, createdAt: over.createdAt ?? NOW - 1_000,
    });

  const post = async (token: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
    (await worker.fetch(new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(token, extra), body: JSON.stringify(body) }), e.env)).json() as Promise<Record<string, unknown>>;
  const claim = async (credential: { token: string; tokenId: string }, runId: string, task: string, params: unknown = {}, at = Date.now()) => {
    expect(await recordDispatch(e.db, { projectId: 'proj_1' }, { id: runId, agentId: 'myco-agent', task, provider: 'anthropic', model: null, runContext: JSON.stringify(params), dispatchedBy: credential.tokenId, startedAt: at })).toBe(true);
    const answered = await post(credential.token, '/runs/claim', { id: runId, agentId: 'myco-agent', task, capability: task === SWEEP ? 'vault_evolution' : 'cortex', runContext: JSON.stringify(params) });
    expect(answered).toEqual({ persisted: true, claimed: true, runId });
  };
  return { ...e, harness, otherHarness, harnessToken: harness.token, otherHarnessToken: otherHarness.token, memberToken: member.token, session, prompt, spore, post, claim };
}

describe('POST /runs/spores', () => {
  it('serves an inventory of one bounded line per spore, with the total behind the page', async () => {
    const h = await setup();
    await h.spore('sp_1', { content: LONG, createdAt: NOW - 3_000 });
    await h.spore('sp_2', { type: 'decision', createdAt: NOW - 2_000 });
    await h.spore('sp_3', { status: 'obsolete', createdAt: NOW - 1_000 });
    await h.claim(h.harness, 'run_1', SWEEP);

    const answered = await h.post(h.harnessToken, '/runs/spores', { runId: 'run_1' });
    expect(answered.held).toBe(true);
    expect(answered.total).toBe(2);
    const rows = answered.spores as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.id)).toEqual(['sp_2', 'sp_1']);
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'id', 'importance', 'observationType', 'preview']);
    const long = rows.find((r) => r.id === 'sp_1')!;
    expect((long.preview as string).length).toBe(SPORE_PREVIEW_CHARS);
    expect(long.preview).not.toContain('tail');
    expect(JSON.stringify(answered)).not.toContain('tail');

    const page = await h.post(h.harnessToken, '/runs/spores', { runId: 'run_1', limit: 1, offset: 1 });
    expect({ total: page.total, ids: (page.spores as Array<{ id: string }>).map((r) => r.id) }).toEqual({ total: 2, ids: ['sp_1'] });
    const byType = await h.post(h.harnessToken, '/runs/spores', { runId: 'run_1', observation_type: 'decision' });
    expect((byType.spores as Array<{ id: string }>).map((r) => r.id)).toEqual(['sp_2']);
    const all = await h.post(h.harnessToken, '/runs/spores', { runId: 'run_1', status: 'all' });
    expect(all.total).toBe(3);
    const searched = await h.post(h.harnessToken, '/runs/spores', { runId: 'run_1', search: 'sp_2' });
    expect((searched.spores as Array<{ id: string }>).map((r) => r.id)).toEqual(['sp_2']);
    expect(await h.post(h.harnessToken, '/runs/spores', { runId: 'run_1', status: 'nonsense' })).toMatchObject({ persisted: false, code: 'parse' });
  });

  it('answers held: false to a plain member, another credential of the harness, another task, a finished run, a stale run, and another Project', async () => {
    const h = await setup();
    await h.spore('sp_1');
    await h.claim(h.harness, 'run_1', SWEEP);
    await h.claim(h.harness, 'run_other', 'container-smoke');
    await h.claim(h.harness, 'run_done', SWEEP);
    h.sqlite.run(`UPDATE agent_runs SET status = 'completed' WHERE id = 'run_done'`);
    await h.claim(h.harness, 'run_stale', SWEEP, {}, Date.now() - OWNER_TITLING_WINDOW_MS - 1);

    const refusedAll = await Promise.all([
      h.post(h.memberToken, '/runs/spores', { runId: 'run_1' }),
      h.post(h.otherHarnessToken, '/runs/spores', { runId: 'run_1' }),
      h.post(h.harnessToken, '/runs/spores', { runId: 'run_other' }),
      h.post(h.harnessToken, '/runs/spores', { runId: 'run_done' }),
      h.post(h.harnessToken, '/runs/spores', { runId: 'run_stale' }),
      h.post(h.harnessToken, '/runs/spores', { runId: 'run_absent' }),
      h.post(h.harnessToken, '/runs/spores', { runId: 'run_1' }, { 'x-myco-project': 'proj_2' }),
      h.post(h.harnessToken, '/runs/spore', { runId: 'run_other', id: 'sp_1' }),
      h.post(h.memberToken, '/runs/spore-create', { runId: 'run_1', observation_type: 'gotcha', content: 'c' }),
      h.post(h.memberToken, '/runs/spore-resolve', { runId: 'run_1', action: 'obsolete', spore_id: 'sp_1', reason: 'r' }),
    ]);
    expect(refusedAll).toEqual(refusedAll.map(() => ({ persisted: true, held: false })));
    expect(h.sqlite.query(`SELECT COUNT(*) c FROM spores`).get()).toEqual({ c: 1 });
    expect(await h.post(h.harnessToken, '/runs/spores', {})).toMatchObject({ persisted: false, code: 'parse' });
  });
});

describe('POST /runs/spore', () => {
  it('serves one spore in full with both directions of its lineage, and says when the Project holds none', async () => {
    const h = await setup();
    await h.spore('sp_old', { content: LONG });
    await h.spore('sp_new');
    await h.claim(h.harness, 'run_1', SWEEP);
    await h.post(h.harnessToken, '/runs/spore-resolve', { runId: 'run_1', action: 'supersede', spore_id: 'sp_old', new_spore_id: 'sp_new', reason: 'the newer one is complete' });

    const answered = await h.post(h.harnessToken, '/runs/spore', { runId: 'run_1', id: 'sp_old' });
    expect(answered.held).toBe(true);
    expect((answered.spore as { content: string }).content).toBe(LONG);
    expect({ by: answered.supersededBy, of: answered.supersedes }).toEqual({ by: ['sp_new'], of: [] });
    expect(await h.post(h.harnessToken, '/runs/spore', { runId: 'run_1', id: 'sp_new' })).toMatchObject({ supersededBy: [], supersedes: ['sp_old'] });
    expect(await h.post(h.harnessToken, '/runs/spore', { runId: 'run_1', id: 'nope' })).toEqual({ persisted: true, held: true, spore: null, supersededBy: [], supersedes: [] });
    expect(await h.post(h.harnessToken, '/runs/spore', { runId: 'run_1' })).toMatchObject({ persisted: false, code: 'parse' });
  });
});

describe('POST /runs/spore-create', () => {
  it('records the spore under the run\'s agent, bound to the session the dispatch named and that session\'s latest prompt', async () => {
    const h = await setup();
    h.session('s1');
    h.prompt('s1', 'p1', NOW - 9_000);
    h.prompt('s1', 'p2', NOW - 8_000);
    await h.claim(h.harness, 'run_bound', SWEEP, { session_id: 's1' });
    await h.claim(h.harness, 'run_free', SWEEP);

    const bound = await h.post(h.harnessToken, '/runs/spore-create', {
      runId: 'run_bound', observation_type: 'wisdom', content: 'one comprehensive note',
      context: 'from three sources', tags: ['spores', 'sweep'], importance: 8, properties: '{"consolidated_from":["a"]}',
    });
    expect(bound.held).toBe(true);
    expect(bound.spore).toMatchObject({
      agentId: 'myco-agent', sessionId: 's1', promptId: 'p2', observationType: 'wisdom',
      status: 'active', content: 'one comprehensive note', context: 'from three sources',
      importance: 8, tags: 'spores, sweep', properties: '{"consolidated_from":["a"]}',
    });
    expect((bound.spore as { id: string }).id.startsWith('wisdom-')).toBe(true);

    const free = await h.post(h.harnessToken, '/runs/spore-create', { runId: 'run_free', observation_type: 'gotcha', content: 'no session here' });
    expect(free.spore).toMatchObject({ sessionId: null, promptId: null, importance: 5, tags: null });
    expect(await h.post(h.harnessToken, '/runs/spore-create', { runId: 'run_free', content: 'no type' })).toMatchObject({ persisted: false, code: 'parse' });
    expect(await h.post(h.harnessToken, '/runs/spore-create', { runId: 'run_free', observation_type: 'gotcha', content: 'x'.repeat(300_000) })).toMatchObject({ persisted: false, code: 'parse' });
  });
});

describe('POST /runs/spore-resolve', () => {
  it('supersedes, obsoletes, consolidates into a recorded wisdom spore, and consolidates a set in one write', async () => {
    const h = await setup();
    h.session('s1');
    h.prompt('s1', 'p1', NOW - 9_000);
    for (const id of ['sp_a', 'sp_b', 'sp_c', 'sp_d', 'sp_e', 'sp_f']) await h.spore(id);
    await h.claim(h.harness, 'run_1', SWEEP, { session_id: 's1' });

    const superseded = await h.post(h.harnessToken, '/runs/spore-resolve', { runId: 'run_1', action: 'supersede', spore_id: 'sp_a', new_spore_id: 'sp_b', reason: 'sp_b carries the file path' });
    expect(superseded).toEqual({ persisted: true, held: true, resolved: true, action: 'supersede', spore: 'sp_a' });

    const obsoleted = await h.post(h.harnessToken, '/runs/spore-resolve', { runId: 'run_1', action: 'obsolete', spore_id: 'sp_c', reason: 'the feature was dropped' });
    expect(obsoleted).toEqual({ persisted: true, held: true, resolved: true, action: 'obsolete', spore: 'sp_c' });

    const created = await h.post(h.harnessToken, '/runs/spore-create', { runId: 'run_1', observation_type: 'wisdom', content: 'the merged note' });
    const wisdomId = (created.spore as { id: string }).id;
    const merged = await h.post(h.harnessToken, '/runs/spore-resolve', { runId: 'run_1', action: 'consolidate', spore_id: 'sp_d', new_spore_id: wisdomId, reason: 'merged' });
    expect(merged).toEqual({ persisted: true, held: true, resolved: true, action: 'consolidate', spore: 'sp_d' });

    const atOnce = await h.post(h.harnessToken, '/runs/spore-resolve', { runId: 'run_1', action: 'consolidate', source_spore_ids: ['sp_e', 'sp_f'], consolidated_content: 'both notes, whole', observation_type: 'wisdom', tags: ['merged'] });
    expect(atOnce).toMatchObject({ persisted: true, held: true, resolved: true, action: 'consolidate', consolidated: 2 });

    expect(h.sqlite.query(`SELECT id, status FROM spores WHERE id IN ('sp_a','sp_b','sp_c','sp_d','sp_e','sp_f') ORDER BY id`).all())
      .toEqual([
        { id: 'sp_a', status: 'superseded' }, { id: 'sp_b', status: 'active' }, { id: 'sp_c', status: 'obsolete' },
        { id: 'sp_d', status: 'consolidated' }, { id: 'sp_e', status: 'consolidated' }, { id: 'sp_f', status: 'consolidated' },
      ]);
    expect(h.sqlite.query(`SELECT DISTINCT agent_id a, session_id s FROM resolution_events`).all()).toEqual([{ a: 'myco-agent', s: 's1' }]);
    expect(h.sqlite.query(`SELECT session_id s, prompt_id p FROM spores WHERE id = ?`).get(atOnce.spore as string)).toEqual({ s: 's1', p: 'p1' });
  });

  it('refuses a resolution in the same words the member\'s tool refuses it', async () => {
    const h = await setup();
    await h.spore('sp_a');
    await h.claim(h.harness, 'run_1', SWEEP);
    const refusalFor = async (body: Record<string, unknown>) =>
      (await h.post(h.harnessToken, '/runs/spore-resolve', { runId: 'run_1', ...body })).reason;

    expect(await refusalFor({ action: 'supersede', spore_id: 'sp_a' })).toBe('new_spore_id is required for op: supersede');
    expect(await refusalFor({ action: 'supersede', spore_id: 'nope', new_spore_id: 'sp_a' })).toBe('old_spore_id not found');
    expect(await refusalFor({ action: 'supersede', spore_id: 'sp_a', new_spore_id: 'nope' })).toBe('new_spore_id not found');
    expect(await refusalFor({ action: 'obsolete', spore_id: 'sp_a' })).toBe('reason is required for op: obsolete');
    expect(await refusalFor({ action: 'obsolete' })).toBe('id is required for op: obsolete');
    expect(await refusalFor({ action: 'consolidate' })).toBe('source_spore_ids is required for op: consolidate');
    expect(await refusalFor({ action: 'consolidate', spore_id: 'sp_a' })).toBe('new_spore_id is required for op: consolidate');
    expect(await refusalFor({ action: 'consolidate', spore_id: 'nope', new_spore_id: 'sp_a' })).toBe('spore_id not found');
    expect(await refusalFor({ action: 'consolidate', source_spore_ids: ['sp_a'] })).toBe('consolidated_content is required for op: consolidate');
    expect(await refusalFor({ action: 'consolidate', source_spore_ids: ['sp_a'], consolidated_content: 'c' })).toBe('observation_type is required for op: consolidate');
    expect(await refusalFor({ action: 'consolidate', source_spore_ids: ['nope'], consolidated_content: 'c', observation_type: 'wisdom' })).toBe('source_spore_id not found: nope');
    expect(await refusalFor({ action: 'nonsense', spore_id: 'sp_a' })).toContain('a resolution requires runId');
    // A spore this Project does not hold moves nothing, which a caller must not read as a resolution.
    expect(await h.post(h.harnessToken, '/runs/spore-resolve', { runId: 'run_1', action: 'obsolete', spore_id: 'nope', reason: 'gone' }))
      .toEqual({ persisted: true, held: true, resolved: false, action: 'obsolete', spore: 'nope' });
    expect(h.sqlite.query(`SELECT COUNT(*) c FROM resolution_events`).get()).toEqual({ c: 0 });
  });
});
