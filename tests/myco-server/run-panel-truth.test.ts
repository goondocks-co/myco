import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const COMMIT = 'a'.repeat(40);
const REQUESTED = { tier: 'high', model: 'gpt-requested', effort: 'high', sources: { tier: 'task', model: 'configured' } };
const IDENTITY = { status: 'reported', source: 'harness', primary: { model: 'gpt-actual', provider: 'openai' }, models: [{ model: 'gpt-actual', provider: 'openai', source: 'harness', usage: null }] };

type Answer = Record<string, any>;
async function fixture() {
  const f = sqliteEnv();
  f.sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('audit_agent', 'audit', 'built-in', 1, ?)`, [NOW]);
  const run = (id: string, task = 'canopy-map', status = 'completed', at = NOW - 1_000, context: object = {}) => {
    f.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, instruction, queued_at, started_at, completed_at, run_context, execution_overrides, usage_data)
      VALUES ('proj_1', ?, 'audit_agent', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, task, status, 'Stored prompt\nwith exact launch text.', at - 2_000, at - 1_000, at, JSON.stringify(context), JSON.stringify({ requested: REQUESTED }), JSON.stringify({ identity: IDENTITY })]);
  };
  const event = (id: string, type: string, tool: string, outcome: string, payload: object, at = NOW - 500) => {
    f.sqlite.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, duration_ms, payload, recorded_at)
      VALUES ('proj_1', ?, ?, ?, ?, 12, ?, ?)`, [id, type, tool, outcome, JSON.stringify(payload), at]);
  };
  const get = async (path: string): Promise<Answer> => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now()), 'cf-connecting-ip': '1.2.3.4' } }), { ...f.env, ...OWNER_ENV });
    expect(res.status).toBe(200);
    return await res.json() as Answer;
  };
  return { ...f, run, event, get };
}

describe('run panel recorded evidence', () => {
  it('lists four admitted calls with the exact validation failure and successful correction', async () => {
    const f = await fixture();
    try {
      f.run('four');
      f.event('four', 'run_tool', 'myco_run_map', 'success', { op: 'get' }, NOW - 900);
      f.event('four', 'run_tool', 'myco_run_map', 'failed', { op: 'write', failure: { code: 'tool_call_failed', message: 'Map text must be a bounded nonempty line' } }, NOW - 800);
      f.event('four', 'run_tool', 'myco_run_map', 'success', { op: 'write' }, NOW - 700);
      f.event('four', 'run_tool', 'myco_run', 'success', { op: 'report' }, NOW - 600);
      const detail = await f.get('/api/projects/proj_1/runs/four');
      expect(detail.toolCalls.map((call: Answer) => ({ op: call.op, status: call.status }))).toEqual([
        { op: 'get', status: 'success' }, { op: 'write', status: 'failed' }, { op: 'write', status: 'success' }, { op: 'report', status: 'success' },
      ]);
      expect(detail.toolCalls[1]).toMatchObject({ durationMs: 12, recordedAt: NOW - 800, failure: { message: 'Map text must be a bounded nonempty line' } });
      expect(detail.toolCallCoverage).toEqual({ total: 4, failed: 1, cursor: null });
    } finally { f.sqlite.close(); }
  });

  it('pages 201 calls with an uncapped total and no duplicate or missing calls', async () => {
    const f = await fixture();
    try {
      f.run('many');
      for (let i = 0; i < 201; i++) f.event('many', 'run_tool', 'myco_run_map', 'success', { op: 'get' }, NOW - 500 + i);
      const first = await f.get('/api/projects/proj_1/runs/many');
      expect(first.toolCallCoverage.total).toBe(201);
      expect(first.toolCalls).toHaveLength(200);
      expect(first.toolCallCoverage.cursor).not.toBeNull();
      const second = await f.get(`/api/projects/proj_1/runs/many?callsCursor=${encodeURIComponent(first.toolCallCoverage.cursor)}`);
      expect(second.toolCallCoverage).toEqual({ total: 201, failed: 0, cursor: null });
      expect(second.toolCalls).toHaveLength(1);
      expect(new Set([...first.toolCalls, ...second.toolCalls].map((call: Answer) => call.id)).size).toBe(201);
    } finally { f.sqlite.close(); }
  });

  it('projects recorded output consistently and keeps unchanged passes in work counts', async () => {
    const f = await fixture();
    try {
      f.run('unchanged');
      f.run('titling_skip', 'title-summary');
      f.run('kept', 'canopy-map', 'failed');
      f.run('dry', 'canopy-map');
      f.sqlite.run(`UPDATE agent_runs SET dry_run = 1 WHERE id = 'dry'`);
      f.event('kept', 'run_write', 'myco_run_map', 'written', {});
      f.event('dry', 'run_write', 'myco_run_map', 'written', {});
      const listed = await f.get('/api/projects/proj_1/runs');
      const work = await f.get(`/api/work?since=${NOW - DAY}&until=${NOW}`);
      for (const [id, result] of [['unchanged', 'unchanged'], ['titling_skip', 'unchanged'], ['kept', 'failed_with_output'], ['dry', 'unchanged']]) {
        expect((await f.get(`/api/projects/proj_1/runs/${id}`)).run.result).toBe(result);
        expect(listed.rows.find((row: Answer) => row.id === id).result).toBe(result);
        const timeline = work.runs.find((row: Answer) => row.id === id);
        if (result === 'unchanged') expect(timeline).toBeUndefined();
        else expect(timeline.result).toBe(result);
      }
      expect(work.outcomes.find((outcome: Answer) => outcome.task === 'canopy-map').runs).toEqual({ completed: 2, failed: 1 });
      expect(work.outcomes.find((outcome: Answer) => outcome.task === 'title-summary').runs).toEqual({ completed: 1 });
    } finally { f.sqlite.close(); }
  });

  it('keeps terminal error distinct from a success report in work', async () => {
    const f = await fixture();
    try {
      f.run('failed', 'canopy-map', 'failed');
      f.sqlite.run(`UPDATE agent_runs SET error = 'the runtime went away', error_code = 'machine_unresponsive' WHERE id = 'failed'`);
      f.sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, created_at) VALUES ('proj_1', 'failed', 'audit_agent', 'map', 'Saved the map successfully', 'Detailed account of the pass.', ?)`, [NOW]);
      const work = await f.get(`/api/work?since=${NOW - DAY}&until=${NOW}`);
      expect(work.runs[0].failure).toEqual({ cause: 'the runtime went away', code: 'machine_unresponsive', error: 'the runtime went away', source: 'error' });
    } finally { f.sqlite.close(); }
  });

  it('serves stored instruction, report details and a pinned commit independent of the current map', async () => {
    const f = await fixture();
    try {
      f.run('pinned', 'canopy-map', 'completed', NOW - 1_000, { repository: { url: 'https://github.com/example/project', branch: 'main', commit: COMMIT } });
      f.event('pinned', 'run_write', 'myco_run_map', 'written', {});
      f.sqlite.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, created_at) VALUES ('proj_1', 'pinned', 'audit_agent', 'map', 'Saved the map', 'The exact report details.', ?)`, [NOW]);
      f.sqlite.run(`INSERT INTO canopy_maps (project_id, revision, artifact, input_hash, repository_url, repository_branch, repository_commit, source_run_id, generated_at) VALUES ('proj_1', 'newer', '{}', 'hash', 'https://github.com/example/project', 'main', ?, 'later_run', ?)`, ['b'.repeat(40), NOW]);
      const detail = await f.get('/api/projects/proj_1/runs/pinned');
      expect(detail.run.instruction).toBe('Stored prompt\nwith exact launch text.');
      expect(detail.run.instructions).toBeNull();
      expect(detail.reports[0].details).toBe('The exact report details.');
      expect(detail.source).toEqual({ branch: 'main', commit: COMMIT });
      expect(detail.map).toMatchObject({ replaced: true, sourceRunId: 'later_run', commit: 'b'.repeat(40) });
      expect(detail.run.requested).toEqual(REQUESTED);
      expect(detail.run.identity).toEqual(IDENTITY);
      const work = await f.get(`/api/work?since=${NOW - DAY}&until=${NOW}`);
      expect(work.runs[0].requested).toEqual(REQUESTED);
      expect(work.runs[0].identity).toEqual(IDENTITY);
    } finally { f.sqlite.close(); }
  });

  it('bounds project lists to the selected outcome window and leaves show-all unbounded', async () => {
    const f = await fixture();
    try {
      f.run('today');
      f.run('yesterday', 'canopy-map', 'completed', NOW - DAY - 1);
      const windowed = await f.get(`/api/projects/proj_1/runs?since=${NOW - DAY}&until=${NOW}`);
      expect(windowed.rows.map((row: Answer) => row.id)).toEqual(['today']);
      const all = await f.get('/api/projects/proj_1/runs');
      expect(all.rows.map((row: Answer) => row.id)).toContain('yesterday');
    } finally { f.sqlite.close(); }
  });
});

it('orders the window list by the outcome time, including a run queued long ago', async () => {
  const f = await fixture();
  try {
    f.run('long_wait', 'canopy-map', 'completed', NOW - 10);
    f.sqlite.run(`UPDATE agent_runs SET queued_at = ? WHERE id = 'long_wait'`, [NOW - 2 * DAY]);
    f.run('earlier_finish', 'canopy-map', 'completed', NOW - 100);
    const first = await f.get(`/api/projects/proj_1/runs?since=${NOW - DAY}&until=${NOW}&limit=1`);
    expect(first.rows[0].id).toBe('long_wait');
    const second = await f.get(`/api/projects/proj_1/runs?since=${NOW - DAY}&until=${NOW}&limit=1&cursor=${encodeURIComponent(first.cursor)}`);
    expect(second.rows[0].id).toBe('earlier_finish');
  } finally { f.sqlite.close(); }
});

it('projects the stored harness estimate message without inventing provenance for an unnamed estimate', async () => {
  const f = await fixture();
  try {
    f.run('known_estimate');
    f.run('unknown_estimate');
    f.sqlite.run('UPDATE agent_runs SET cost_data = ?, cost_usd = 2.7343128 WHERE id = ?', [JSON.stringify({ message: 'Estimate reported by the harness; not a billing statement' }), 'known_estimate']);
    f.sqlite.run('UPDATE agent_runs SET cost_data = ?, cost_usd = 1 WHERE id = ?', [JSON.stringify({ message: 'An estimate with no source' }), 'unknown_estimate']);
    expect((await f.get('/api/projects/proj_1/runs/known_estimate')).run.costProvenance).toBe('harness_estimate');
    expect((await f.get('/api/projects/proj_1/runs/unknown_estimate')).run.costProvenance).toBeNull();
  } finally { f.sqlite.close(); }
});

it('redacts an access-key canary in the prompt projection and preserves the stored instruction', async () => {
  const f = await fixture();
  try {
    f.run('secret_canary');
    const canary = `sk-proj-${'Q'.repeat(40)}`;
    const budgets = 'Keep max_tokens=4096 and token_budget: 12000; token_limit=8000.';
    const instruction = `Use this key: ${canary}\nKeep map entries bounded.\n${budgets}`;
    f.sqlite.run('UPDATE agent_runs SET instruction = ? WHERE id = ?', [instruction, 'secret_canary']);
    const detail = await f.get('/api/projects/proj_1/runs/secret_canary');
    expect(JSON.stringify(detail)).not.toContain(canary);
    expect(detail.run.instruction).toContain('Keep map entries bounded.');
    expect(detail.run.instruction).toContain('[REDACTED]');
    expect(detail.run.instruction).toContain(budgets);
    expect(f.sqlite.query('SELECT instruction FROM agent_runs WHERE id = ?').get('secret_canary')).toEqual({ instruction });
  } finally { f.sqlite.close(); }
});
