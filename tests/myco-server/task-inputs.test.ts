/**
 * What a run is told, and what happens to one nobody can instruct.
 *
 * A worker hands its harness the instruction the claim answers, verbatim. A
 * harness given an empty prompt ends its turn at once, having called nothing,
 * and the worker then reports a run that did nothing as one that finished. So:
 * the Deployment writes the instruction for the tasks a worker serves, in the
 * vocabulary of the tools the run's MCP surface actually serves; a queued run
 * that has neither a built instruction nor one its dispatch carries is ended
 * at the claim, named, and never handed out.
 */
import { describe, expect, it } from 'bun:test';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { buildTaskInput, INPUT_BUILDERS, instructionFor, uninstructedError } from '@myco-server-worker/core/task-inputs.js';
import { buildTitlingInput } from '@myco-server-worker/core/titling-input.js';
import { taskTools, TITLING_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { acceptedActions, RUN_SKIP_ACTION, TITLING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { runAllowlist, runDefinitions } from '@myco-server-worker/mcp/run-surface.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://s';
const OFFERED = [{ id: 'codex', authenticated: true }];
/** A task a worker serves, declared and switched off, with no builder of its own. */
const UNBUILT_TASK = 'skill-survey';

async function rig() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'a worker');
  const workerToken = (await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId;
  const queued = (id: string, task: string, instruction: string | null) => {
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES ('proj_1', ?, 'myco-agent', ?, 'queued', ?, 'worker', ?, ?, ?)`,
      [id, task, NOW, JSON.stringify({ serverUrl: ORIGIN, actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 }), instruction],
    );
  };
  const row = (id: string) => e.sqlite.query(`SELECT status, error, instruction FROM agent_runs WHERE id = ?`).get(id) as { status: string; error: string | null; instruction: string | null };
  const credentials = () => (e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get() as { n: number }).n;
  const claim = (now: number) => claimNextRun(e.serverEnv, { tokenId: workerToken, machineId: 'm1', harnesses: OFFERED, now });
  const endedSession = (sessionId: string) => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [sessionId, NOW - 10_000, NOW, NOW - 10_000, NOW]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', ?, ?, ?, 'add a retry to the runner', 'user', ?, ?, ?, 'tok_1', ?)`, [sessionId, `p_${sessionId}`, `e_${sessionId}`, `h_${sessionId}`, NOW - 5000, NOW - 5000, NOW - 5000]);
  };
  return { e, queued, row, credentials, claim, endedSession };
}

/** Every tool name an instruction cites in backticks, in either vocabulary a prompt has ever been written in. */
const citedTools = (instruction: string): string[] => [...instruction.matchAll(/`((?:myco|vault)_[a-z_]+)`/g)].map((m) => m[1]!);
/** Every report action an instruction tells the run to close with. */
const citedActions = (instruction: string): string[] => [...instruction.matchAll(/\baction "([a-z_]+)"/g)].map((m) => m[1]!);

describe('the instruction a titling run receives', () => {
  it('names the session, the mode, and the three calls in the words the run surface serves', async () => {
    const owner = await buildTitlingInput({ session_id: 'sess_9', mode: 'owner', by: 'mem_x' });
    expect(owner).not.toBeNull();
    expect(owner!.instruction).toContain('Target session: sess_9');
    expect(owner!.instruction).toContain('Write over whatever title stands');
    expect(owner!.instruction).toContain('`myco_run_sessions` op "material"');
    expect(owner!.instruction).toContain('`myco_run_sessions` op "title"');
    expect(owner!.instruction).toContain(`action "${TITLING_REPORT_ACTION}"`);
    expect(owner!.instruction).toContain(`action "${RUN_SKIP_ACTION}"`);
    expect(owner!.instruction).toContain('serialized JSON object string');
    expect(owner!.inputHash).toHaveLength(64);
    expect(owner!.counts).toEqual({ owner: true });

    const claim = await buildTitlingInput({ session_id: 'sess_9', mode: 'claim' });
    expect(claim!.instruction).toContain('A title already standing is kept');
    expect(claim!.counts).toEqual({ owner: false });
  });

  it('is nothing for a dispatch that names no session, rather than a prompt about no session', async () => {
    expect(await buildTitlingInput({})).toBeNull();
    expect(await buildTitlingInput({ session_id: 's', mode: 'later' })).toBeNull();
    expect(await buildTaskInput((await rig()).e.serverEnv, TITLING_TASK, 'proj_1', NOW, { params: {} })).toBeNull();
  });
});

describe('every instruction the Deployment builds', () => {
  it('cites only tools the run\'s own MCP surface serves under that name', async () => {
    const r = await rig();
    const params = { session_id: 's1', mode: 'claim' };
    for (const task of Object.keys(INPUT_BUILDERS)) {
      const built = await buildTaskInput(r.e.serverEnv, task, 'proj_1', NOW, { params });
      expect({ task, built: built !== null && !built.unchanged }).toEqual({ task, built: true });
      if (built === null || built.unchanged) continue;
      const served = new Set(runDefinitions(runAllowlist(taskTools(task), { dryRun: false })).map((d) => d.name));
      const cited = citedTools(built.input.instruction);
      // A prompt that names no tool at all instructs nothing; one that names a tool
      // the surface does not serve sends the harness after a call that will fail.
      expect({ task, cited: cited.length > 0, unserved: cited.filter((name) => !served.has(name)) }).toEqual({ task, cited: true, unserved: [] });
    }
  });

  it('tells the run to close only with actions its task\'s close rule accepts, and names at least one', async () => {
    const r = await rig();
    for (const task of Object.keys(INPUT_BUILDERS)) {
      const built = await buildTaskInput(r.e.serverEnv, task, 'proj_1', NOW, { params: { session_id: 's1', mode: 'claim' } });
      if (built === null || built.unchanged) throw new Error(`${task} built nothing`);
      const accepted = acceptedActions(task);
      if (accepted === null) continue;
      const actions = citedActions(built.input.instruction);
      // A run that closes with an action the rule does not accept is recorded as
      // having ended without its report, however faithfully it followed the prompt.
      expect({ task, named: actions.length > 0, unaccepted: actions.filter((a) => !accepted.includes(a)) }).toEqual({ task, named: true, unaccepted: [] });
    }
  });
});

describe('what a claim hands out', () => {
  it('a titling run the Deployment asked for, under the instruction it built for that session', async () => {
    const r = await rig();
    r.endedSession('s1');
    const asked = await titleSession(r.e.serverEnv, { projectId: 'proj_1', sessionId: 's1', now: NOW, origin: ORIGIN });
    expect(asked.outcome).toBe('queued');
    const claimed = await r.claim(NOW + 1);
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect(claimed.run.instruction).toContain('Target session: s1');
    expect(claimed.run.instruction).toContain('`myco_run_sessions` op "material"');
    // The row carries what the worker is told, so the runs page shows it and a re-claim reads the same.
    expect(r.row(claimed.run.id).instruction).toBe(claimed.run.instruction);
  });

  it('a run dispatched with its own instruction, when its task has no builder', async () => {
    const r = await rig();
    r.queued('run_told', UNBUILT_TASK, 'survey the skills this project uses');
    const claimed = await r.claim(NOW + 1);
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect(claimed.run.instruction).toBe('survey the skills this project uses');
  });

  it('never a run nobody can instruct: it is ended failed, named, and nothing is minted for it', async () => {
    const r = await rig();
    r.queued('run_bare', UNBUILT_TASK, null);
    r.queued('run_blank', UNBUILT_TASK, '   ');
    const before = r.credentials();
    // One claim ends every such row it meets and answers from what is left; a
    // queue of them drains in one poll rather than one row per poll interval.
    expect(await r.claim(NOW + 1)).toEqual({ claimed: false, reason: 'no_work' });
    expect(r.row('run_bare')).toEqual({ status: 'failed', error: uninstructedError(UNBUILT_TASK), instruction: null });
    expect(r.row('run_blank').status).toBe('failed');
    expect(r.credentials()).toBe(before);
  });
});

describe('the instruction a claim settles on', () => {
  it('is the one built now over the one dispatched, and nothing over blank', () => {
    const built = { unchanged: false as const, input: { instruction: 'built now', inputHash: 'h', counts: {} } };
    expect(instructionFor(built, 'dispatched')).toBe('built now');
    expect(instructionFor(null, 'dispatched')).toBe('dispatched');
    expect(instructionFor({ unchanged: true }, 'dispatched')).toBe('dispatched');
    expect(instructionFor(null, '  ')).toBeNull();
    expect(instructionFor(null, null)).toBeNull();
  });
});
