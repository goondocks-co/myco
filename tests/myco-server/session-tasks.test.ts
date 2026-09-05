/**
 * The two routes a titling run reads and writes through, driven over the
 * deployed entry: admitted only to the harness credential that dispatched a
 * live `title-summary` run bound to the named session, writing in the mode
 * the dispatch recorded and inside the title's bounds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { OWNER_TITLING_WINDOW_MS } from '@myco-server-worker/core/titling.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_700_000_000_000;

async function setup() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.provider.type', '"anthropic"', ?, 'test')`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`, [NOW]);
  // Credentials are minted on the live clock: the pipeline reads their lifetime against its own.
  await ensureMember(e.db, HARNESS_MEMBER_ID, Date.now(), 'harness runtime');
  const harnessToken = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
  const otherHarnessToken = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
  const memberToken = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());

  const session = (id: string, over: { endedAt?: number | null; title?: string; summary?: string } = {}) =>
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at, title, summary)
                  VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?, ?, ?)`, [id, NOW - 10_000, NOW, NOW - 10_000, over.endedAt === undefined ? NOW : over.endedAt, over.title ?? null, over.summary ?? null]);
  const prompt = (session: string, id: string, text: string, at: number) =>
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
                  VALUES ('proj_1', ?, ?, ?, ?, 'user', ?, ?, ?, 'tok_1', ?)`, [session, id, `e_${id}`, text, `h_${id}`, at, at, at]);
  const response = (session: string, promptId: string, id: string, text: string, at: number) =>
    e.sqlite.run(`INSERT INTO responses (project_id, session_id, response_id, prompt_id, event_id, text, content_hash, created_at, token_id, received_at)
                  VALUES ('proj_1', ?, ?, ?, ?, ?, ?, ?, 'tok_1', ?)`, [session, id, promptId, `e_${id}`, text, `h_${id}`, at, at]);

  const post = async (token: string, path: string, body: unknown, extra: Record<string, string> = {}) =>
    (await worker.fetch(new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(token, extra), body: JSON.stringify(body) }), e.env)).json() as Promise<Record<string, unknown>>;
  /** A dispatch as the server records it, then the claim as the container makes it: the context is the server's, the claim moves the row to running. */
  const claim = async (credential: { token: string; tokenId: string }, runId: string, task: string, params: unknown, at = Date.now()) => {
    expect(await recordDispatch(e.db, { projectId: 'proj_1' }, { id: runId, agentId: 'myco-agent', task, provider: 'anthropic', model: null, runContext: JSON.stringify(params), dispatchedBy: credential.tokenId, startedAt: at })).toBe(true);
    const answered = await post(credential.token, '/runs/claim', { id: runId, agentId: 'myco-agent', task, captureDriven: task === 'title-summary', ...(task === 'title-summary' ? {} : { capability: 'cortex' }), runContext: JSON.stringify(params) });
    expect(answered).toEqual({ persisted: true, claimed: true, runId });
  };
  const row = (id: string) => e.sqlite.query(`SELECT title, summary, titled_at, titled_by FROM sessions WHERE session_id = ?`).get(id) as { title: string | null; summary: string | null; titled_at: number | null; titled_by: string | null };
  return { ...e, harness: harnessToken, otherHarness: otherHarnessToken, harnessToken: harnessToken.token, otherHarnessToken: otherHarnessToken.token, memberToken: memberToken.token, session, prompt, response, post, claim, row };
}

const logged: string[] = [];
const originalLog = console.log;
beforeEach(() => { logged.length = 0; console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); }; });
afterEach(() => { console.log = originalLog; });

describe('POST /runs/session-material', () => {
  it('serves the session\'s facts and material to the run that holds it, in the mode the dispatch recorded', async () => {
    const h = await setup();
    h.session('s1', { title: 'Old title', summary: 'Old summary' });
    h.prompt('s1', 'p1', 'Fix the flaky test', NOW - 9000);
    h.response('s1', 'p1', 'r1', 'Looking now.', NOW - 8500);
    h.prompt('s1', 'p2', 'Now add the retry', NOW - 8000);
    await h.claim(h.harness, 'run_1', 'title-summary', { session_id: 's1', mode: 'claim' });

    const answered = await h.post(h.harnessToken, '/runs/session-material', { runId: 'run_1', sessionId: 's1' });
    expect(answered).toEqual({
      persisted: true,
      held: true,
      material: {
        session_id: 's1', status: 'completed', agent: 'claude-code', branch: 'main', prompt_count: 2,
        current_title: 'Old title', current_summary: 'Old summary',
        batches: [
          { prompt_number: 1, user_prompt: 'Fix the flaky test', response_excerpt: 'Looking now.' },
          { prompt_number: 2, user_prompt: 'Now add the retry', response_excerpt: null },
        ],
      },
    });

    h.session('open', { endedAt: null });
    h.prompt('open', 'q1', 'hello', NOW - 9000);
    await h.claim(h.harness, 'run_2', 'title-summary', { session_id: 'open', mode: 'owner' });
    const owner = await h.post(h.harnessToken, '/runs/session-material', { runId: 'run_2', sessionId: 'open' });
    expect((owner.material as Record<string, unknown>).status).toBe('active');
    expect((owner.material as Record<string, unknown>).note).toContain('earliest and latest');
    expect((owner.material as Record<string, unknown>).current_title).toBeUndefined();
  });

  it('answers held: false to a plain member, another credential of the harness, another task, a finished run, and a run bound to another session', async () => {
    const h = await setup();
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.session('s2');
    h.prompt('s2', 'p2', 'hello', NOW - 9000);
    await h.claim(h.harness, 'run_1', 'title-summary', { session_id: 's1', mode: 'claim' });
    await h.claim(h.harness, 'run_other', 'container-smoke', { session_id: 's1', mode: 'claim' });
    await h.claim(h.harness, 'run_done', 'title-summary', { session_id: 's1', mode: 'claim' });
    h.sqlite.run(`UPDATE agent_runs SET status = 'completed' WHERE id = 'run_done'`);
    await h.claim(h.harness, 'run_stale', 'title-summary', { session_id: 's1', mode: 'claim' }, Date.now() - OWNER_TITLING_WINDOW_MS - 1);

    const refusedAll = await Promise.all([
      h.post(h.memberToken, '/runs/session-material', { runId: 'run_1', sessionId: 's1' }),
      h.post(h.otherHarnessToken, '/runs/session-material', { runId: 'run_1', sessionId: 's1' }),
      h.post(h.harnessToken, '/runs/session-material', { runId: 'run_other', sessionId: 's1' }),
      h.post(h.harnessToken, '/runs/session-material', { runId: 'run_done', sessionId: 's1' }),
      h.post(h.harnessToken, '/runs/session-material', { runId: 'run_1', sessionId: 's2' }),
      h.post(h.harnessToken, '/runs/session-material', { runId: 'run_absent', sessionId: 's1' }),
      // A run whose attempt began past its own window is not live, whatever its row says.
      h.post(h.harnessToken, '/runs/session-material', { runId: 'run_stale', sessionId: 's1' }),
      // The same run under another Project's header.
      h.post(h.harnessToken, '/runs/session-material', { runId: 'run_1', sessionId: 's1' }, { 'x-myco-project': 'proj_2' }),
    ]);
    expect(refusedAll).toEqual(refusedAll.map(() => ({ persisted: true, held: false })));
    // The dispatched credential cannot mint a second run naming another session: the claim is refused for an id the server never dispatched.
    const minted = await h.post(h.harnessToken, '/runs/claim', { id: 'run_self', agentId: 'myco-agent', task: 'title-summary', captureDriven: true, runContext: JSON.stringify({ session_id: 's2', mode: 'owner' }) });
    expect(minted).toEqual({ persisted: true, claimed: false, running: null });
    expect(await h.post(h.harnessToken, '/runs/session-material', { runId: 'run_self', sessionId: 's2' })).toEqual({ persisted: true, held: false });
    // Nor can it rewrite the context of its own run at the claim: the server's record stands.
    expect(h.sqlite.query(`SELECT run_context c FROM agent_runs WHERE id = 'run_1'`).get()).toEqual({ c: JSON.stringify({ session_id: 's1', mode: 'claim' }) });
    // A request missing its ids is a refusal of the request, coded.
    expect(await h.post(h.harnessToken, '/runs/session-material', { runId: 'run_1' })).toMatchObject({ persisted: false, code: 'parse' });
  });
});

describe('POST /runs/session-title', () => {
  it('writes only where no title exists at a session\'s end, and over whatever is there on an owner\'s ask', async () => {
    const h = await setup();
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.sqlite.run(`UPDATE sessions SET titled_at = ? WHERE session_id = 's1'`, [NOW]);
    await h.claim(h.harness, 'run_1', 'title-summary', { session_id: 's1', mode: 'claim' });
    expect(await h.post(h.harnessToken, '/runs/session-title', { runId: 'run_1', sessionId: 's1', title: ' Retry added to the runner. ', summary: ' Added a retry. ' }))
      .toEqual({ persisted: true, held: true, written: true });
    expect(h.row('s1')).toEqual({ title: 'Retry added to the runner', summary: 'Added a retry.', titled_at: NOW, titled_by: null });
    expect(logged.some((l) => l.includes('session_titled') && l.includes('"mode":"claim"') && l.includes('run_1'))).toBe(true);
    expect(logged.join('\n')).not.toContain('Retry added');

    // A title already there is kept at a session's end.
    expect(await h.post(h.harnessToken, '/runs/session-title', { runId: 'run_1', sessionId: 's1', title: 'Second', summary: 'second' }))
      .toEqual({ persisted: true, held: true, written: false });
    expect(h.row('s1').title).toBe('Retry added to the runner');

    // An owner's ask writes over it, naming the member whose ask it was.
    await h.claim(h.harness, 'run_2', 'title-summary', { session_id: 's1', mode: 'owner', by: 'mem_asker' });
    expect(await h.post(h.harnessToken, '/runs/session-title', { runId: 'run_2', sessionId: 's1', title: 'Second', summary: 'second' }))
      .toEqual({ persisted: true, held: true, written: true });
    expect(h.row('s1')).toEqual({ title: 'Second', summary: 'second', titled_at: NOW, titled_by: 'mem_asker' });
  });

  it('leaves the session\'s stamp when the run fails, and the credential no longer serves', async () => {
    const h = await setup();
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    h.sqlite.run(`UPDATE sessions SET titled_at = ? WHERE session_id = 's1'`, [NOW]);
    await h.claim(h.harness, 'run_1', 'title-summary', { session_id: 's1', mode: 'claim' });
    expect(await h.post(h.harnessToken, '/runs/update', { runId: 'run_1', update: { status: 'failed', error: 'provider unreachable', completed_at: NOW } })).toEqual({ persisted: true, changed: 1, applied: true });
    expect(h.row('s1')).toEqual({ title: null, summary: null, titled_at: NOW, titled_by: null });
    // The terminal status revoked the run's credential: the routes answer 401, not a held run.
    const res = await worker.fetch(new Request('https://s/runs/session-title', { method: 'POST', headers: memberHeaders(h.harnessToken), body: JSON.stringify({ runId: 'run_1', sessionId: 's1', title: 'Late', summary: 'late' }) }), h.env);
    expect(res.status).toBe(401);
    expect(h.row('s1').title).toBeNull();
  });

  it('refuses a title or summary outside its bounds, or a half, so the run can offer another; and writes nothing for a caller that holds no run', async () => {
    const h = await setup();
    h.session('s1');
    h.prompt('s1', 'p1', 'hello', NOW - 9000);
    await h.claim(h.harness, 'run_1', 'title-summary', { session_id: 's1', mode: 'claim' });
    for (const body of [
      { title: 't'.repeat(81), summary: 'ok' },
      { title: 'ok', summary: 's'.repeat(1201) },
      { title: 'ok' },
      { summary: 'ok' },
      { title: '   ', summary: 'ok' },
    ]) {
      expect(await h.post(h.harnessToken, '/runs/session-title', { runId: 'run_1', sessionId: 's1', ...body })).toMatchObject({ persisted: false, code: 'parse' });
    }
    expect(await h.post(h.memberToken, '/runs/session-title', { runId: 'run_1', sessionId: 's1', title: 'T', summary: 'S' })).toEqual({ persisted: true, held: false, written: false });
    expect(h.row('s1')).toEqual({ title: null, summary: null, titled_at: null, titled_by: null });
  });
});
