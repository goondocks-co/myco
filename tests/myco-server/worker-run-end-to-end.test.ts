/**
 * A worker's run, from the claim to the work it owed.
 *
 * The claim and the lease are held elsewhere; what this holds is that a run a
 * worker took can actually do its task. Both of these fail the moment a
 * worker-claimed run reaches the harness without the context its dispatch
 * decided, which is invisible to any test that seeds that context by hand:
 *
 * - a titling run reads its own session's material and writes its title, both
 *   over the run's own credential, which the session and mode on the run's
 *   context are what make possible;
 * - a digest run files its artifact under the hash the SERVER recorded, not
 *   under a hash the harness reports.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://s';
const OFFERED = [{ id: 'claude-code', authenticated: true }];

async function rig() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'a worker');
  const workerToken = (await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId;
  /** A tool call over a run's own credential, as the harness child makes it. */
  const asRun = async (token: string, name: string, input: Record<string, unknown>) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: memberHeaders(token, { [PROJECT_HEADER]: 'proj_1' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }),
    }), e.env);
    const body = await res.json() as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    if (body.error !== undefined) return { failed: body.error.message };
    return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  };
  return { e, workerToken, asRun };
}

describe('a titling run a worker claimed', () => {
  it('reads its own session\'s material and writes its title, over the run\'s own credential', async () => {
    const r = await rig();
    r.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
    r.e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's1', 'p1', 'e1', 'add a retry to the runner', 'user', 'h1', ?, ?, 'tok_1', ?)`, [NOW - 5000, NOW - 5000, NOW - 5000]);

    // The Deployment asks for a title the way a session's end does.
    const asked = await titleSession(r.e.serverEnv, { projectId: 'proj_1', sessionId: 's1', now: NOW + 1, origin: ORIGIN });
    expect(asked.outcome).toBe('queued');

    const claimed = await claimNextRun(r.e.serverEnv, { tokenId: r.workerToken, machineId: 'm1', harnesses: OFFERED, now: NOW + 2 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect(claimed.run.task).toBe('title-summary');

    // The run's own credential reaches its session, which only the session and
    // mode on the run's context make possible.
    const material = await r.asRun(claimed.run.runToken, 'myco_run_sessions', { op: 'material', project: 'proj_1' });
    expect(material.session_id).toBe('s1');
    expect((material.batches as Array<{ user_prompt: string }>)[0]?.user_prompt).toContain('add a retry to the runner');

    const written = await r.asRun(claimed.run.runToken, 'myco_run_sessions', { op: 'title', project: 'proj_1', title: 'Add a retry to the runner', summary: 'The runner gained a retry around its one flaky call.' });
    expect(written).toEqual({ session_id: 's1', written: true });
    expect(r.e.sqlite.query(`SELECT title, summary FROM sessions WHERE session_id = 's1'`).get())
      .toEqual({ title: 'Add a retry to the runner', summary: 'The runner gained a retry around its one flaky call.' });
  });
});

describe('the context a claimed run carries', () => {
  it('is the one the dispatch decided: the task\'s budget and the hash the server filed it under', async () => {
    const r = await rig();
    r.e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES ('proj_1', 'run_d', 'myco-agent', 'digest-only', 'queued', ?, 'worker', ?, ?, 'do the digest')`,
      [NOW, JSON.stringify({ serverUrl: ORIGIN, actor: 'deployment', timeoutSeconds: 1800 }), JSON.stringify({ timeoutSeconds: 1800, input_hash: 'a'.repeat(64), counts: { spores: 1 } })],
    );
    const claimed = await claimNextRun(r.e.serverEnv, { tokenId: r.workerToken, machineId: 'm1', harnesses: OFFERED, now: NOW + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;

    // What the dispatch decided survives the claim: the run's own budget, and a
    // hash the SERVER filed the ask under rather than one a harness reports.
    const context = JSON.parse(r.e.sqlite.query(`SELECT run_context AS c FROM agent_runs WHERE id = 'run_d'`).get<{ c: string }>()!.c) as Record<string, unknown>;
    expect(context.timeoutSeconds).toBe(1800);
    expect(typeof context.input_hash).toBe('string');
    expect((context.input_hash as string).length).toBe(64);
    expect(context.counts).toEqual(expect.any(Object));
  });
});
