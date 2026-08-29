/**
 * Agent runs through the product surface.
 *
 * A project that has run nothing answers an empty page, and 404 names only a
 * project this caller may not see. A failed run is visible as failed with its
 * record. Nothing the harness stored for its own use — the resolved provider
 * configuration in `checkpoints` and `execution_overrides` among it — leaves
 * through these reads.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { phasesOf } from '@myco-server-worker/read/runs.js';

const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;
const CANARY = 'sk-canary';

interface RunSeed {
  id: string;
  project?: string;
  status?: string;
  task?: string;
  startedAt?: number;
  completedAt?: number | null;
  error?: string | null;
  checkpoints?: string | null;
  resumeStatus?: string | null;
}

async function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  for (const project of ['proj_1', 'proj_2']) {
    fixture.sqlite.query(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(project, project, NOW);
  }
  fixture.sqlite.query(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  const seed = (run: RunSeed) => {
    fixture.sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, error, checkpoints, resume_status,
        execution_overrides, run_context, cost_data, tokens_used, cost_usd, cost_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1234, 0.5, 'actual')`)
      .run(run.project ?? 'proj_1', run.id, AGENT, run.task ?? 'digest', run.status ?? 'completed', run.startedAt ?? NOW, run.completedAt ?? null,
        run.error ?? null, run.checkpoints ?? null, run.resumeStatus ?? null,
        JSON.stringify({ provider: { apiKey: CANARY } }), `context ${CANARY}`, JSON.stringify({ apiKey: CANARY }));
  };
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await worker.fetch(await asOwner(path), env);
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { ...fixture, env, get, seed };
}

const ids = (body: Record<string, unknown>): string[] => (body.rows as { id: string }[]).map((r) => r.id);

describe('an empty answer is not a missing one', () => {
  it('answers 200 with an empty page for a project that has run nothing, and 404 for one this caller cannot see', async () => {
    const { get } = await harness();
    expect(await get('/api/projects/proj_1/runs')).toEqual({ status: 200, body: { rows: [], cursor: null } });
    expect((await get('/api/projects/absent/runs')).status).toBe(404);
    expect((await get('/api/projects/absent/runs/r1')).status).toBe(404);
    expect((await get('/api/projects/proj_1/runs/absent')).status).toBe(404);
  });

  it('answers 404 for a run held under another project, never that project\'s row', async () => {
    const { get, seed } = await harness();
    seed({ id: 'run_other', project: 'proj_2' });
    expect((await get('/api/projects/proj_1/runs/run_other')).status).toBe(404);
    expect(ids((await get('/api/projects/proj_1/runs')).body)).toEqual([]);
  });
});

describe('the run list', () => {
  it('is newest first, pages by cursor, and narrows by status and task', async () => {
    const { get, seed } = await harness();
    seed({ id: 'r1', startedAt: NOW + 1 });
    seed({ id: 'r2', startedAt: NOW + 2, status: 'failed', error: 'boom' });
    seed({ id: 'r3', startedAt: NOW + 3, task: 'skills' });

    const first = await get('/api/projects/proj_1/runs?limit=2');
    expect(ids(first.body)).toEqual(['r3', 'r2']);
    expect(typeof first.body.cursor).toBe('string');
    const second = await get(`/api/projects/proj_1/runs?limit=2&cursor=${encodeURIComponent(first.body.cursor as string)}`);
    expect({ ids: ids(second.body), cursor: second.body.cursor }).toEqual({ ids: ['r1'], cursor: null });

    expect(ids((await get('/api/projects/proj_1/runs?status=failed')).body)).toEqual(['r2']);
    expect(ids((await get('/api/projects/proj_1/runs?task=skills')).body)).toEqual(['r3']);
    expect((first.body.rows as { id: string; failed: boolean }[]).map((r) => [r.id, r.failed])).toEqual([['r3', false], ['r2', true]]);
  });

  it('refuses a malformed cursor and an over-long filter rather than serving page one', async () => {
    const { get, seed } = await harness();
    seed({ id: 'r1' });
    expect((await get('/api/projects/proj_1/runs?cursor=nonsense')).status).toBe(400);
    expect((await get(`/api/projects/proj_1/runs?status=${'s'.repeat(193)}`)).status).toBe(400);
    expect((await get('/api/projects/proj_1/runs?task=')).status).toBe(400);
  });

  it('serves no more than the ceiling, however large a page the caller asks for', async () => {
    const { get, seed } = await harness();
    for (let i = 0; i < 205; i += 1) seed({ id: `r${i}`, startedAt: NOW + i });
    const { body } = await get('/api/projects/proj_1/runs?limit=1000');
    expect({ n: (body.rows as unknown[]).length, more: body.cursor !== null }).toEqual({ n: 200, more: true });
  });
});

describe('the run detail', () => {
  it('shows a failed run as failed with its error and resume record, and its reports', async () => {
    const { get, seed, sqlite } = await harness();
    seed({ id: 'r_failed', status: 'failed', error: 'the model refused', resumeStatus: 'session_expired', completedAt: NOW + 5 });
    sqlite.query(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, created_at) VALUES ('proj_1', 'r_failed', ?, 'noted', 'a report', null, ?)`).run(AGENT, NOW);

    const { status, body } = await get('/api/projects/proj_1/runs/r_failed');
    const run = body.run as Record<string, unknown>;
    expect({ status, runStatus: run.status, error: run.error, resumeStatus: run.resumeStatus, failed: run.failed, completedAt: run.completedAt, tokens: run.tokensUsed, phases: body.phases, projectId: body.projectId })
      .toEqual({ status: 200, runStatus: 'failed', error: 'the model refused', resumeStatus: 'session_expired', failed: true, completedAt: NOW + 5, tokens: 1234, phases: [], projectId: 'proj_1' });
    expect((body.reports as { action: string; summary: string }[]).map((r) => [r.action, r.summary])).toEqual([['noted', 'a report']]);
  });

  it('opens a run whose id needs escaping in the path', async () => {
    const { get, seed } = await harness();
    seed({ id: 'run with space' });
    expect((await get('/api/projects/proj_1/runs/run%20with%20space')).status).toBe(200);
  });

  it('serves phases from the checkpoint, with the facts a failure leaves behind', async () => {
    const { get, seed } = await harness();
    seed({
      id: 'r_phases',
      checkpoints: JSON.stringify({
        schemaVersion: 2, harness: 'h', providerConfig: { type: 'openai', apiKey: CANARY },
        phases: {
          prepare: { name: 'prepare', status: 'completed', updatedAt: 5, turnsUsed: 2, allowedMaxTurns: 5, tokensUsed: 10, costUsd: 0.01, costSource: 'actual' },
          write: { status: 'failed', updatedAt: 6, capHit: true, postConditionFailed: true, summary: 'ran out of turns' },
        },
      }),
    });
    const { body } = await get('/api/projects/proj_1/runs/r_phases');
    expect(body.phases).toEqual([
      { name: 'prepare', status: 'completed', updatedAt: 5, summary: null, turnsUsed: 2, allowedMaxTurns: 5, tokensUsed: 10, costUsd: 0.01, costSource: 'actual', capHit: false, semanticCheckBlocked: false, postConditionFailed: false },
      { name: 'write', status: 'failed', updatedAt: 6, summary: 'ran out of turns', turnsUsed: null, allowedMaxTurns: null, tokensUsed: null, costUsd: null, costSource: null, capHit: true, semanticCheckBlocked: false, postConditionFailed: true },
    ]);
  });

  it('tells an unreadable phase record apart from an empty one', async () => {
    const { get, seed } = await harness();
    seed({ id: 'r_corrupt', checkpoints: '{"phases": {"a": {' });
    seed({ id: 'r_shapeless', checkpoints: '{"phases": []}' });
    seed({ id: 'r_none', checkpoints: null });
    seed({ id: 'r_empty', checkpoints: '{"schemaVersion": 2, "harness": "h", "phases": {}}' });
    const phases = async (id: string) => (await get(`/api/projects/proj_1/runs/${id}`)).body.phases;
    expect({ corrupt: await phases('r_corrupt'), shapeless: await phases('r_shapeless'), none: await phases('r_none'), empty: await phases('r_empty') })
      .toEqual({ corrupt: null, shapeless: null, none: [], empty: [] });
    expect(phasesOf('not json')).toBeNull();
  });
});

describe('nothing stored for the harness leaves through the reads', () => {
  it('answers list and detail with no provider key, no provider configuration, and no run context, wherever the row holds them', async () => {
    const { get, seed } = await harness();
    seed({
      id: 'r_secret',
      checkpoints: JSON.stringify({ schemaVersion: 2, harness: 'h', providerConfig: { type: 'openai', apiKey: CANARY }, phases: { p: { status: 'completed', updatedAt: 1 } } }),
    });
    const list = JSON.stringify((await get('/api/projects/proj_1/runs')).body);
    const detail = JSON.stringify((await get('/api/projects/proj_1/runs/r_secret')).body);
    for (const [name, text] of [['list', list], ['detail', detail]] as const) {
      expect({ name, canary: text.includes(CANARY), providerConfig: text.includes('providerConfig'), context: text.includes('context '), checkpoints: text.includes('checkpoints') })
        .toEqual({ name, canary: false, providerConfig: false, context: false, checkpoints: false });
    }
    expect(detail).toContain('"phases":[{"name":"p"');
  });
});
