import { REPOSITORY_CHECKOUT_CAPABILITY, MAX_REPOSITORY_HISTORY_DEPTH } from '@goondocks/myco-shared/repository';
/**
 * What a run is told, and what happens to one nobody can instruct.
 *
 * A worker hands its harness the instruction the claim answers, verbatim, and
 * writes the standing rules the claim hands beside it as the run's
 * instructions file. A harness given an empty prompt ends its turn at once,
 * having called nothing, and the worker then reports a run that did nothing as
 * one that finished. So: the Deployment writes the instruction for every task a
 * worker serves, in the vocabulary of the tools the run's MCP surface actually
 * serves; a task it builds none for is refused at dispatch; and a queued run
 * whose build answers nothing and whose dispatch carried no instruction is
 * ended at the claim, named, and never handed out.
 */
import { describe, expect, it } from 'bun:test';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimNextRun, DISPATCH_REFUSAL_MESSAGE, dispatchTask, HARNESS_MEMBER_ID, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { buildTaskInput, INPUT_BUILDERS, instructionFor, instructionsFileFor, uninstructedError } from '@myco-server-worker/core/task-inputs.js';
import { buildTitlingInput } from '@myco-server-worker/core/titling-input.js';
import { buildExtractionInput, EXTRACTION_PAGE, EXTRACTION_RULES } from '@myco-server-worker/core/extraction-input.js';
import { buildSeedingInput, SEEDING_CHECKOUT_DIR, SEEDING_RULES } from '@myco-server-worker/core/seeding-input.js';
import { EXTRACTION_TASK, OUTCOME_TASKS, SEEDING_TASK, taskTools, TITLING_TASK } from '@myco-server-worker/core/task-catalogue.js';
import { acceptedActions, EXTRACTION_REPORT_ACTION, RUN_SKIP_ACTION, SEEDING_REPORT_ACTION, TITLING_REPORT_ACTION } from '@myco-server-worker/core/run-postconditions.js';
import { runAllowlist, runDefinitions } from '@myco-server-worker/mcp/run-surface.js';
import { titleSession } from '@myco-server-worker/core/titling.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;
const ORIGIN = 'https://s';
const OFFERED = [{ id: 'codex', authenticated: true }];

async function rig() {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`, [NOW]);
  e.sqlite.run(`INSERT OR REPLACE INTO project_repositories (project_id, revision, url, branch, username, secret_slot, updated_at, updated_by) VALUES ('proj_1', 'rev_1', 'https://github.com/goondocks-co/myco', 'main', NULL, NULL, ?, 'mem_x')`, [NOW]);
  await ensureMember(e.db, 'mem_worker', NOW, 'admin', 'a worker');
  const workerToken = (await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, NOW)).tokenId;
  const queued = (id: string, task: string, instruction: string | null, context: Record<string, unknown> = {}) => {
    e.sqlite.run(
      `INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
       VALUES ('proj_1', ?, 'myco-agent', ?, 'queued', ?, 'worker', ?, ?, ?)`,
      [id, task, NOW, JSON.stringify({ serverUrl: ORIGIN, actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300, ...context }), instruction],
    );
  };
  const row = (id: string) => e.sqlite.query(`SELECT status, error, instruction FROM agent_runs WHERE id = ?`).get(id) as { status: string; error: string | null; instruction: string | null };
  const credentials = () => (e.sqlite.query(`SELECT COUNT(*) AS n FROM member_credentials`).get() as { n: number }).n;
  const claim = (now: number) => claimNextRun(e.serverEnv, { tokenId: workerToken, machineId: 'm1', harnesses: OFFERED, capabilities: [REPOSITORY_CHECKOUT_CAPABILITY], now });
  const endedSession = (sessionId: string) => {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at) VALUES ('proj_1', ?, 'm1', 'tok_1', ?, ?, 'claude-code', 'main', ?, ?)`, [sessionId, NOW - 10_000, NOW, NOW - 10_000, NOW]);
    e.sqlite.run(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at) VALUES ('proj_1', ?, ?, ?, 'add a retry to the runner', 'user', ?, ?, ?, 'tok_1', ?)`, [sessionId, `p_${sessionId}`, `e_${sessionId}`, `h_${sessionId}`, NOW - 5000, NOW - 5000, NOW - 5000]);
  };
  return { e, queued, row, credentials, claim, endedSession };
}

/** Every tool name a text cites in backticks, in either vocabulary a prompt has ever been written in. */
const citedTools = (text: string): string[] => [...text.matchAll(/`((?:myco|vault)_[a-z_]+)`/g)].map((m) => m[1]!);
/** Every `(tool, op)` a text cites as a call. */
const citedOps = (text: string): Array<{ tool: string; op: string }> => [...text.matchAll(/`(myco_[a-z_]+)` op "([a-z_]+)"/g)].map((m) => ({ tool: m[1]!, op: m[2]! }));
/** Every report action a text tells the run to close with. */
const citedActions = (text: string): string[] => [...text.matchAll(/\baction "([a-z_]+)"/g)].map((m) => m[1]!);
/** The ops one run may call, as `tool op`. */
const servedOps = (task: string): Set<string> => {
  const allow = runAllowlist(taskTools(task), { dryRun: false });
  return new Set([...allow.entries()].flatMap(([tool, ops]) => [...ops].map((op) => `${tool} ${op}`)));
};
const PARAMS = { session_id: 's1', mode: 'claim' };

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

describe('the instruction an extraction run receives', () => {
  it('asks for one page, every mark, and the close, and hands the standing rules as the instructions file', async () => {
    const built = await buildExtractionInput();
    expect(built.instruction).toContain(`\`limit\` ${EXTRACTION_PAGE}`);
    expect(built.instruction).toContain('`myco_run_prompts` op "unprocessed"');
    expect(built.instruction).toContain('`myco_run_prompts` op "mark_processed"');
    expect(built.instruction).toContain('EVERY prompt on the page');
    expect(built.instruction).toContain(`action "${EXTRACTION_REPORT_ACTION}"`);
    expect(built.instruction).toContain(`action "${RUN_SKIP_ACTION}"`);
    expect(built.instruction).toContain('AGENTS.md');
    expect(built.instructions).toBe(EXTRACTION_RULES);
    expect(EXTRACTION_RULES).toContain('Search before every write');
    expect(EXTRACTION_RULES).toContain('Do not pass `session_id`');
    expect(built.inputHash).toHaveLength(64);
  });
});

describe('the instruction a seeding run receives', () => {
  it('names the connected repository and where the worker checks it out, and hands the standing rules as the instructions file', async () => {
    const r = await rig();
    const built = await buildSeedingInput(r.e.serverEnv, 'proj_1');
    expect(built).not.toBeNull();
    expect(built!.instruction).toContain('https://github.com/goondocks-co/myco');
    expect(built!.instruction).toContain('branch main');
    expect(built!.instruction).toContain(`./${SEEDING_CHECKOUT_DIR}`);
    expect(built!.instruction).toContain('`myco_run_spores` op "list"');
    expect(built!.instruction).toContain('`myco_spores` op "save"');
    expect(built!.instruction).toContain(`action "${SEEDING_REPORT_ACTION}"`);
    expect(built!.instruction).toContain(`action "${RUN_SKIP_ACTION}"`);
    expect(built!.instructions).toBe(SEEDING_RULES);
    expect(SEEDING_RULES).toContain('Change nothing in the checkout and push nothing');
  });

  it('is nothing for a Project that has connected no repository', async () => {
    const r = await rig();
    r.e.sqlite.run(`DELETE FROM project_repositories WHERE project_id = 'proj_1'`);
    expect(await buildSeedingInput(r.e.serverEnv, 'proj_1')).toBeNull();
  });
});

describe('every instruction the Deployment builds', () => {
  it('cites only tools the run\'s own MCP surface serves under that name, in the prompt and in the instructions file alike', async () => {
    const r = await rig();
    for (const task of Object.keys(INPUT_BUILDERS)) {
      const built = await buildTaskInput(r.e.serverEnv, task, 'proj_1', NOW, { params: PARAMS });
      expect({ task, built: built !== null && !built.unchanged }).toEqual({ task, built: true });
      if (built === null || built.unchanged) continue;
      const served = new Set(runDefinitions(runAllowlist(taskTools(task), { dryRun: false })).map((d) => d.name));
      for (const [where, text] of [['prompt', built.input.instruction], ['file', built.input.instructions ?? '']] as const) {
        const cited = citedTools(text);
        // A prompt that names no tool at all instructs nothing; a text that names a
        // tool the surface does not serve sends the harness after a call that will fail.
        expect({ task, where, cited: where === 'file' || cited.length > 0, unserved: cited.filter((name) => !served.has(name)) })
          .toEqual({ task, where, cited: true, unserved: [] });
        const ops = servedOps(task);
        expect({ task, where, unservedOps: citedOps(text).filter(({ tool, op }) => !ops.has(`${tool} ${op}`)) }).toEqual({ task, where, unservedOps: [] });
      }
    }
  });

  it('tells the run to close only with actions its task\'s close rule accepts, and names at least one', async () => {
    const r = await rig();
    for (const task of Object.keys(INPUT_BUILDERS)) {
      const built = await buildTaskInput(r.e.serverEnv, task, 'proj_1', NOW, { params: PARAMS });
      if (built === null || built.unchanged) throw new Error(`${task} built nothing`);
      const accepted = acceptedActions(task);
      if (accepted === null) continue;
      const actions = citedActions(built.input.instruction);
      // A run that closes with an action the rule does not accept is recorded as
      // having ended without its report, however faithfully it followed the prompt.
      expect({ task, named: actions.length > 0, unaccepted: actions.filter((a) => !accepted.includes(a)) }).toEqual({ task, named: true, unaccepted: [] });
    }
  });

  it('is built for exactly the three outcomes', () => {
    expect(Object.keys(INPUT_BUILDERS).sort()).toEqual([...OUTCOME_TASKS].sort());
  });
});

describe('a task the Deployment cannot instruct', () => {
  it('is refused at dispatch by name, with copy an owner reads, rather than queued for a claim that would end it', async () => {
    const r = await rig();
    const builders = INPUT_BUILDERS as Record<string, unknown>;
    const kept = builders[EXTRACTION_TASK];
    delete builders[EXTRACTION_TASK];
    try {
      expect(await prepareDispatch(r.e.serverEnv, EXTRACTION_TASK, 'proj_1')).toEqual({ ok: false, refusal: 'no_instruction' });
      expect(await dispatchTask(r.e.serverEnv, EXTRACTION_TASK, 'proj_1', { serverUrl: ORIGIN, actor: 'mem_x' }, NOW)).toEqual({ dispatched: false, refusal: 'no_instruction' });
      expect((r.e.sqlite.query(`SELECT COUNT(*) AS n FROM agent_runs`).get() as { n: number }).n).toBe(0);
      expect(DISPATCH_REFUSAL_MESSAGE.no_instruction).toContain('no instruction');
    } finally {
      builders[EXTRACTION_TASK] = kept;
    }
    // With its builder back, the same ask queues.
    expect(await prepareDispatch(r.e.serverEnv, EXTRACTION_TASK, 'proj_1')).toMatchObject({ ok: true, prepared: { servedBy: 'worker' } });
  });

  it('admits seeding through a worker only when the Project has connected source', async () => {
    const r = await rig();
    expect(await prepareDispatch(r.e.serverEnv, SEEDING_TASK, 'proj_1')).toMatchObject({ ok: true, prepared: { servedBy: 'worker' } });
    r.e.sqlite.run(`DELETE FROM project_repositories WHERE project_id = 'proj_1'`);
    expect(await prepareDispatch(r.e.serverEnv, SEEDING_TASK, 'proj_1')).toEqual({ ok: false, refusal: 'repository_missing' });
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
    // A titling run's whole instruction is its prompt.
    expect(claimed.run.instructions).toBeNull();
    // The row carries what the worker is told, so the runs page shows it and a re-claim reads the same.
    expect(r.row(claimed.run.id).instruction).toBe(claimed.run.instruction);
  });

  it('an extraction run with its prompt and its standing rules, built at the claim over whatever the dispatch carried', async () => {
    const r = await rig();
    r.queued('run_x', EXTRACTION_TASK, 'a prompt from the dispatch');
    const claimed = await r.claim(NOW + 1);
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect(claimed.run.instruction).toContain('Read the prompts nobody has read yet');
    expect(claimed.run.instructions).toBe(EXTRACTION_RULES);
  });

  it('a seeding run under the prompt built from the repository the Project connected, and no credential on the claim', async () => {
    const r = await rig();
    r.queued('run_seed', SEEDING_TASK, null);
    const claimed = await r.claim(NOW + 1);
    expect(claimed.claimed).toBe(true);
    if (!claimed.claimed) return;
    expect(claimed.run.instructions).toBe(SEEDING_RULES);
    expect(claimed.run.instruction).toContain('https://github.com/goondocks-co/myco');
    expect(claimed.run.repository).toMatchObject({ historyDepth: MAX_REPOSITORY_HISTORY_DEPTH });
    expect(claimed.run.repository).not.toHaveProperty('credential');
  });

  it('never a stale instruction for a task whose build now answers nothing: the run is ended, not driven about a thing that is gone', async () => {
    const r = await rig();
    // The dispatch's prompt describes a repository the Project no longer connects.
    r.queued('run_seed_stale', SEEDING_TASK, 'Seed from the repository checked out at ./repo');
    r.e.sqlite.run(`DELETE FROM project_repositories WHERE project_id = 'proj_1'`);
    expect(await r.claim(NOW + 1)).toEqual({ claimed: false, reason: 'no_work' });
    expect(r.row('run_seed_stale')).toMatchObject({ status: 'failed', error: uninstructedError(SEEDING_TASK) });
  });

  it('never a run nobody can instruct: it is ended failed, named, and nothing is minted for it', async () => {
    const r = await rig();
    // A titling dispatch naming no session builds nothing; what its row carries does not stand in.
    r.queued('run_bare', TITLING_TASK, null);
    r.queued('run_blank', TITLING_TASK, '   ');
    r.queued('run_told', TITLING_TASK, 'title session s1');
    const before = r.credentials();
    // One claim ends every such row it meets and answers from what is left; a
    // queue of them drains in one poll rather than one row per poll interval.
    expect(await r.claim(NOW + 1)).toEqual({ claimed: false, reason: 'no_work' });
    expect(r.row('run_bare')).toEqual({ status: 'failed', error: uninstructedError(TITLING_TASK), instruction: null });
    expect(r.row('run_blank').status).toBe('failed');
    expect(r.row('run_told')).toMatchObject({ status: 'failed', error: uninstructedError(TITLING_TASK) });
    expect(r.credentials()).toBe(before);
  });
});

describe('the instruction a claim settles on', () => {
  it('is the build for a task that has a builder, the dispatch\'s own only for a task that has none, and nothing over blank', () => {
    const built = { unchanged: false as const, input: { instruction: 'built now', instructions: 'the rules', inputHash: 'h', counts: {} } };
    expect(instructionFor(built, 'dispatched', true)).toBe('built now');
    // A builder that answered nothing ends the run rather than handing out what the dispatch stored.
    expect(instructionFor(null, 'dispatched', true)).toBeNull();
    expect(instructionFor({ unchanged: true }, 'dispatched', true)).toBeNull();
    expect(instructionFor(null, 'dispatched', false)).toBe('dispatched');
    expect(instructionFor(null, '  ', false)).toBeNull();
    expect(instructionFor(null, null, false)).toBeNull();
    expect(instructionsFileFor(built)).toBe('the rules');
    expect(instructionsFileFor({ unchanged: false, input: { instruction: 'x', inputHash: 'h', counts: {} } })).toBeNull();
    expect(instructionsFileFor(null)).toBeNull();
  });
});
