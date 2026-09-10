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
 * - an extraction run reads its page, writes under its own credential, and is
 *   held to the mark it landed rather than to its report.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, dispatchTask, endLeasedRun, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { EXTRACTION_REPORT_ACTION, RUN_CLOSE_ARTIFACT_ERROR, RUN_CLOSE_ERROR, RUN_SKIP_ACTION, runCloseRefusal, SEEDING_REPORT_ACTION, TITLING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { getRun, RUN_TOOL_EVENT } from '@myco-server-worker/core/runs.js';
import { EXTRACTION_TASK, SEEDING_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { AGENT_LINE_MAX_CHARS } from '@myco-server-worker/core/injection.js';
import { AGENTS_BLOCK_STATE_KEY } from '@myco-server-worker/mcp/tools/run.js';
import { AGENTS_BLOCK_MAX_CHARS } from '@goondocks/myco-shared/agents-block';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
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
  /** The row a worker's outcome left behind. */
  const outcome = (runId: string) =>
    e.sqlite.query(`SELECT status, error FROM agent_runs WHERE id = ?`).get(runId) as { status: string; error: string | null };
  /** Every call a run made back, as the Deployment recorded it. */
  const calls = (runId: string) =>
    e.sqlite.query(`SELECT tool_name AS tool, outcome FROM agent_run_events WHERE run_id = ? AND event_type = ? ORDER BY id`)
      .all(runId, RUN_TOOL_EVENT) as Array<{ tool: string; outcome: string }>;
  /** A titling run a worker has claimed, for the session this rig seeds. */
  const claimedTitling = async (now: number) => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's1', 'p1', 'e1', 'add a retry to the runner', 'user', 'h1', ?, ?, 'tok_1', ?)`, [NOW - 5000, NOW - 5000, NOW - 5000]);
    const asked = await titleSession(e.serverEnv, { projectId: 'proj_1', sessionId: 's1', now, origin: ORIGIN });
    expect(asked.outcome).toBe('queued');
    const claimed = await claimNextRun(e.serverEnv, { tokenId: workerToken, machineId: 'm1', harnesses: OFFERED, now: now + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) throw new Error('the titling run was not claimed');
    return claimed.run;
  };
  /** An owner's re-title run a worker has claimed, over a session that already carries a title. */
  const claimedRetitle = async (now: number) => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at, title, summary) VALUES ('proj_1', 's2', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?, 'A title an earlier run wrote', 'And its summary.')`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's2', 'p2', 'e2', 'rename the thing', 'user', 'h2', ?, ?, 'tok_1', ?)`, [NOW - 5000, NOW - 5000, NOW - 5000]);
    const asked = await titleSession(e.serverEnv, { projectId: 'proj_1', sessionId: 's2', now, origin: ORIGIN }, { mode: 'owner', by: 'mem_worker' });
    expect(asked.outcome).toBe('queued');
    const claimed = await claimNextRun(e.serverEnv, { tokenId: workerToken, machineId: 'm1', harnesses: OFFERED, now: now + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) throw new Error('the re-title run was not claimed');
    return claimed.run;
  };
  /** The worker's own report that the harness ended its turn. */
  const workerEnds = (runId: string, status: 'completed' | 'failed', now: number) =>
    endLeasedRun(e.serverEnv, { tokenId: workerToken, now }, { projectId: 'proj_1', runId, status });
  return { e, workerToken, asRun, outcome, calls, claimedTitling, claimedRetitle, workerEnds };
}

describe('a titling run a worker claimed', () => {
  it('reads its own session\'s material and writes its title, over the run\'s own credential', async () => {
    const r = await rig();
    // The Deployment asks for a title the way a session's end does, and a worker takes it.
    const run = await r.claimedTitling(NOW + 1);
    expect(run.task).toBe('title-summary');

    // The run's own credential reaches its session, which only the session and
    // mode on the run's context make possible.
    const material = await r.asRun(run.runToken, 'myco_run_sessions', { op: 'material', project: 'proj_1' });
    expect(material.session_id).toBe('s1');
    expect((material.batches as Array<{ user_prompt: string }>)[0]?.user_prompt).toContain('add a retry to the runner');

    const written = await r.asRun(run.runToken, 'myco_run_sessions', { op: 'title', project: 'proj_1', title: 'Add a retry to the runner', summary: 'The runner gained a retry around its one flaky call.' });
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
       VALUES ('proj_1', 'run_x', 'myco-agent', ?, 'queued', ?, 'worker', ?, ?, 'read the prompts')`,
      [EXTRACTION_TASK, NOW, JSON.stringify({ serverUrl: ORIGIN, actor: 'deployment', timeoutSeconds: 900 }), JSON.stringify({ timeoutSeconds: 900, input_hash: 'a'.repeat(64), counts: { page: 20 } })],
    );
    const claimed = await claimNextRun(r.e.serverEnv, { tokenId: r.workerToken, machineId: 'm1', harnesses: OFFERED, now: NOW + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;

    // What the dispatch decided survives the claim: the run's own budget, and a
    // hash the SERVER filed the ask under rather than one a harness reports.
    const context = JSON.parse(r.e.sqlite.query(`SELECT run_context AS c FROM agent_runs WHERE id = 'run_x'`).get<{ c: string }>()!.c) as Record<string, unknown>;
    expect(context.timeoutSeconds).toBe(900);
    expect(typeof context.input_hash).toBe('string');
    expect((context.input_hash as string).length).toBe(64);
    expect(context.counts).toEqual(expect.any(Object));
  });
});

/**
 * A worker sees a harness end its turn. That is a fact about the harness, not
 * about the task: a harness that never called the Deployment at all ends its
 * turn exactly as one that did the work does, and taking the worker's word for
 * it records a green run that did nothing.
 */
describe('what a worker reporting `completed` actually closes', () => {
  it('records a titling run whose session has no title as failed, naming what it owed', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);

    // The harness ended its turn without ever calling back.
    expect(r.calls(run.id)).toEqual([]);
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'failed' });
    expect(r.outcome(run.id)).toEqual({ status: 'failed', error: RUN_CLOSE_ERROR });
  });

  it('records a titling run that reported but wrote no title as failed on the row it owed', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);

    expect(await r.asRun(run.runToken, 'myco_run', { op: 'report', action: 'summary', summary: 'nothing to do' }))
      .toMatchObject({ recorded: true });
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'failed' });
    expect(r.outcome(run.id)).toEqual({ status: 'failed', error: RUN_CLOSE_ARTIFACT_ERROR });
  });

  it('completes a titling run that wrote the title under its own credential', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);

    await r.asRun(run.runToken, 'myco_run_sessions', { op: 'title', title: 'Add a retry to the runner', summary: 'The runner gained a retry around its one flaky call.' });
    await r.asRun(run.runToken, 'myco_run', { op: 'report', action: 'summary', summary: 'titled one session' });
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'completed' });
    expect(r.outcome(run.id)).toEqual({ status: 'completed', error: null });
  });

  it('refuses a report under an action the task\'s close rule cannot hear, naming the ones it can, and records nothing', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);
    const refused = await r.asRun(run.runToken, 'myco_run', { op: 'report', action: 'title', summary: 'wrote the title' });
    expect(refused).toEqual({ ok: false, error: `a title-summary run closes with action "${TITLING_REPORT_ACTION}" or "${RUN_SKIP_ACTION}"` });
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_reports WHERE run_id = ?`).get(run.id)).toEqual({ n: 0 });
    // A retry under an accepted action lands, and the run then closes on it.
    expect(await r.asRun(run.runToken, 'myco_run', { op: 'report', action: RUN_SKIP_ACTION, summary: 'nothing to do' })).toEqual({ recorded: true, action: RUN_SKIP_ACTION });
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'completed' });
  });

  it('holds an extraction pass to the prompt it marked read: a report alone fails, a mark under its own credential completes', async () => {
    const r = await rig();
    r.e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'vault_evolution', 1, ?, 'test')`, [NOW]);
    r.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', 's3', 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [NOW - 10_000, NOW, NOW - 10_000, NOW]);
    r.e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', 's3', 'p3', 'e3', 'why does the runner retry the claim twice', 'user', 'h3', ?, ?, 'tok_1', ?)`, [NOW - 5000, NOW - 5000, NOW - 5000]);
    r.e.sqlite.run(`INSERT INTO responses (project_id, response_id, session_id, prompt_id, event_id, text, content_hash, created_at, token_id, received_at) VALUES ('proj_1', 'resp3', 's3', 'p3', 'e3r', 'The lease renewal re-claims it; wrap only the claim call.', 'hr3', ?, 'tok_1', ?)`, [NOW - 4000, NOW - 4000]);
    const asked = await dispatchTask(r.e.serverEnv, EXTRACTION_TASK, 'proj_1', { serverUrl: ORIGIN, actor: 'mem_worker' }, NOW);
    expect(asked).toMatchObject({ dispatched: true, queued: true });
    const claimed = await claimNextRun(r.e.serverEnv, { tokenId: r.workerToken, machineId: 'm1', harnesses: OFFERED, now: NOW + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    const run = claimed.run;
    expect(run.task).toBe(EXTRACTION_TASK);
    expect(run.instructions).toContain('Search before every write');

    // The page carries the prompt and the opening of its response, which is the
    // material an observation is read from.
    const page = await r.asRun(run.runToken, 'myco_run_prompts', { op: 'unprocessed', include_text: true, limit: 20 });
    expect((page.prompts as Array<Record<string, unknown>>)[0]).toMatchObject({ prompt_id: 'p3', text: 'why does the runner retry the claim twice', response: 'The lease renewal re-claims it; wrap only the claim call.' });

    // The report alone is the model's word; the run owed the mark.
    expect(await r.asRun(run.runToken, 'myco_run', { op: 'report', action: EXTRACTION_REPORT_ACTION, summary: 'read one prompt', details: '{"prompts":1,"created":0}' })).toMatchObject({ recorded: true });
    expect(await runCloseRefusal(r.e.db, { projectId: 'proj_1' }, (await getRun(r.e.db, { projectId: 'proj_1' }, run.id))!)).toBe(RUN_CLOSE_ARTIFACT_ERROR);

    // A spore written under the run's credential names the run as its author.
    const line = 'Wrap only the claim call in the retry: the lease renewal re-claims a run another worker holds (runner/loop.ts).';
    const saved = await r.asRun(run.runToken, 'myco_spores', { op: 'save', type: 'gotcha', content: `${line}\n\nThe renewal path is idempotent on the worker that holds the lease and a re-claim on any other.`, tags: ['runner', 'lease'], agent_line: `  ${line}  ` });
    expect(saved.id).toEqual(expect.any(String));
    // The spore names the run as its author, and carries the agent line the run gave it, as one line.
    expect(r.e.sqlite.query(`SELECT author, agent_line AS agentLine FROM spores WHERE id = ?`).get(saved.id as string)).toEqual({ author: run.id, agentLine: line });
    // A line past the bound the injection renders is refused whole, and no spore lands.
    expect(await r.asRun(run.runToken, 'myco_spores', { op: 'save', type: 'gotcha', content: 'x', agent_line: 'y'.repeat(AGENT_LINE_MAX_CHARS + 1) })).toMatchObject({ ok: false });
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM spores WHERE author = ?`).get(run.id)).toEqual({ n: 1 });

    // The mark is the landed write the close rule reads, and the cursor moves.
    expect(await r.asRun(run.runToken, 'myco_run_prompts', { op: 'mark_processed', prompt_id: 'p3' })).toEqual({ prompt_id: 'p3', marked: true });
    expect((await r.asRun(run.runToken, 'myco_run_prompts', { op: 'unprocessed' })).prompts).toEqual([]);
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'completed' });
    expect(r.outcome(run.id)).toEqual({ status: 'completed', error: null });
  });

  it('hands a seeding run the managed block as one write the Deployment holds, bounded, and holds the run to a spore it authored', async () => {
    const r = await rig();
    r.e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'vault_evolution', 1, ?, 'test')`, [NOW]);
    r.e.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`, [NOW]);
    r.e.sqlite.run(`INSERT OR REPLACE INTO project_repositories (project_id, revision, url, branch, username, secret_slot, updated_at, updated_by) VALUES ('proj_1', 'rev_1', 'https://github.com/goondocks-co/myco', 'main', NULL, NULL, ?, 'mem_x')`, [NOW]);
    expect(await dispatchTask(r.e.serverEnv, SEEDING_TASK, 'proj_1', { serverUrl: ORIGIN, actor: 'mem_worker' }, NOW)).toMatchObject({ dispatched: true, queued: true });
    const claimed = await claimNextRun(r.e.serverEnv, { tokenId: r.workerToken, machineId: 'm1', harnesses: OFFERED, now: NOW + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    const run = claimed.run;
    expect(run.repository).toEqual({ url: 'https://github.com/goondocks-co/myco', branch: 'main' });
    expect(run.instruction).toContain('`myco_run` op "agents_block"');

    // The block lands whole, under the bound, and is recorded as the run's write; past the bound nothing lands.
    const block = '## Myco\nSearch `myco_search` before a design decision.';
    expect(await r.asRun(run.runToken, 'myco_run', { op: 'agents_block', block })).toEqual({ written: true, chars: block.length });
    expect(r.e.sqlite.query(`SELECT value FROM agent_state WHERE project_id = 'proj_1' AND key = ?`).get(AGENTS_BLOCK_STATE_KEY)).toEqual({ value: block });
    expect(await r.asRun(run.runToken, 'myco_run', { op: 'agents_block', block: 'x'.repeat(AGENTS_BLOCK_MAX_CHARS + 1) })).toMatchObject({ ok: false });
    expect(r.e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_run_events WHERE run_id = ? AND event_type = 'run_write'`).get(run.id)).toEqual({ n: 1 });

    // The report alone closes nothing: the run owed a spore of its own.
    await r.asRun(run.runToken, 'myco_run', { op: 'report', action: SEEDING_REPORT_ACTION, summary: 'seeded', details: '{"spores":0}' });
    expect(await runCloseRefusal(r.e.db, { projectId: 'proj_1' }, (await getRun(r.e.db, { projectId: 'proj_1' }, run.id))!)).toBe(RUN_CLOSE_ARTIFACT_ERROR);
    await r.asRun(run.runToken, 'myco_spores', { op: 'save', type: 'architecture', content: 'One server product, two front doors.', agent_line: 'Both front doors share one core: change core/, never a platform adapter alone.' });
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'completed' });
  });

  it('completes an extraction pass that found nothing to read on its skip alone', async () => {
    const r = await rig();
    r.e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'vault_evolution', 1, ?, 'test')`, [NOW]);
    await dispatchTask(r.e.serverEnv, EXTRACTION_TASK, 'proj_1', { serverUrl: ORIGIN, actor: 'mem_worker' }, NOW);
    const claimed = await claimNextRun(r.e.serverEnv, { tokenId: r.workerToken, machineId: 'm1', harnesses: OFFERED, now: NOW + 1 });
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect((await r.asRun(claimed.run.runToken, 'myco_run_prompts', { op: 'unprocessed', include_text: true })).prompts).toEqual([]);
    await r.asRun(claimed.run.runToken, 'myco_run', { op: 'report', action: RUN_SKIP_ACTION, summary: 'nothing to read' });
    expect(await r.workerEnds(claimed.run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'completed' });
  });

  it('keeps a worker\'s own failure as the failure it reported', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);
    expect(await endLeasedRun(r.e.serverEnv, { tokenId: r.workerToken, now: NOW + 3 }, { projectId: 'proj_1', runId: run.id, status: 'failed', error: 'the harness answered 401' }))
      .toEqual({ ended: true, status: 'failed' });
    expect(r.outcome(run.id)).toEqual({ status: 'failed', error: 'the harness answered 401' });
  });
});

/**
 * The only part of a run the Deployment observes directly is the calls the run
 * makes back to it. A run that made none is the case worth being able to read.
 */
describe('the record of what a run called', () => {
  it('names every call a run made under its own credential, and records nothing for a refused one', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);

    await r.asRun(run.runToken, 'myco_run_sessions', { op: 'material' });
    await r.asRun(run.runToken, 'myco_run', { op: 'report', action: 'summary', summary: 'read it' });
    // A tool this task never declared is off the run's surface, and a credential
    // may not turn a call it is not admitted to make into a row.
    await r.asRun(run.runToken, 'myco_spores', { op: 'save', title: 'x', content: 'y' });

    expect(r.calls(run.id).map((c) => `${c.tool} ${c.outcome}`))
      .toEqual(['myco_run_sessions success', 'myco_run success']);

    // The same record is what a person opening the run reads.
    const detail = await getRunDetail(r.e.db, { projectId: 'proj_1' }, run.id);
    expect(detail?.toolCalls.map((c) => `${c.tool} ${c.op ?? ''}`))
      .toEqual(['myco_run_sessions material', 'myco_run report']);
  });

  it('reads a run whose harness never called the Deployment as having called nothing', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);
    await r.workerEnds(run.id, 'completed', NOW + 3);

    const detail = await getRunDetail(r.e.db, { projectId: 'proj_1' }, run.id);
    expect({ status: detail?.run.status, calls: detail?.toolCalls, error: detail?.run.error })
      .toEqual({ status: 'failed', calls: [], error: RUN_CLOSE_ERROR });
  });
});

/**
 * A title standing on a session is not proof THIS run wrote it.
 *
 * An owner may re-title any session, titled or not, and that write goes over
 * whatever is there; a session may also carry a title with no claim stamp at
 * all. A rule that asked only whether the session has a title would pass a run
 * that filed its report, called nothing, and left an earlier run's title
 * standing — the same defect one re-title later.
 */
describe('whose title a titling run is held to', () => {
  it('fails an owner\'s re-title that reported over a titled session and wrote nothing', async () => {
    const r = await rig();
    const run = await r.claimedRetitle(NOW + 1);

    await r.asRun(run.runToken, 'myco_run', { op: 'report', action: 'summary', summary: 'looked at it' });
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'failed' });
    expect(r.outcome(run.id)).toEqual({ status: 'failed', error: RUN_CLOSE_ARTIFACT_ERROR });
    // The title the earlier run wrote is untouched, which is the whole point:
    // the row looks titled and the run still did nothing.
    expect(r.e.sqlite.query(`SELECT title FROM sessions WHERE session_id = 's2'`).get())
      .toEqual({ title: 'A title an earlier run wrote' });
  });

  it('completes an owner\'s re-title that actually wrote over the title that stood', async () => {
    const r = await rig();
    const run = await r.claimedRetitle(NOW + 1);

    await r.asRun(run.runToken, 'myco_run_sessions', { op: 'title', title: 'What the session really did', summary: 'A truer summary of the same work.' });
    await r.asRun(run.runToken, 'myco_run', { op: 'report', action: 'summary', summary: 're-titled it' });
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'completed' });
    expect(r.e.sqlite.query(`SELECT title FROM sessions WHERE session_id = 's2'`).get())
      .toEqual({ title: 'What the session really did' });
  });

  it('fails a claim-mode run whose write took nothing because a title already stood', async () => {
    const r = await rig();
    const run = await r.claimedTitling(NOW + 1);
    // A title lands between the dispatch and the run's own write, so the run's
    // `claim` write takes nothing while answering that it ran.
    r.e.sqlite.run(`UPDATE sessions SET title = 'A title that arrived first', summary = 's' WHERE session_id = 's1'`);

    expect(await r.asRun(run.runToken, 'myco_run_sessions', { op: 'title', title: 'What this run would have written', summary: 'Its own summary of the work.' }))
      .toEqual({ session_id: 's1', written: false });
    await r.asRun(run.runToken, 'myco_run', { op: 'report', action: 'summary', summary: 'tried' });
    expect(await r.workerEnds(run.id, 'completed', NOW + 3)).toEqual({ ended: true, status: 'failed' });
    expect(r.outcome(run.id)).toEqual({ status: 'failed', error: RUN_CLOSE_ARTIFACT_ERROR });
  });
});
