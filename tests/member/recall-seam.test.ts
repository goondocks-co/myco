/**
 * The post-append recall seam: it runs after the spool holds the events and
 * their receipts, its answer replaces the hook response, a throw inside it
 * costs the served block alone, and the budget it spends leaves the drain room
 * to ship. The served block is then written in each symbiont's own shape.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { runGit } from '@myco/utils/git.js';
import { setBufferedStdin } from '@myco/hooks/read-stdin.js';
import { _resetManifestCache } from '@myco/hooks/normalize.js';
import { writeHookResponse } from '@myco/hooks/response.js';
import { runMemberHook, type HookOutcome, type HookRun } from '@myco/member/capture.js';
import { resolveHookBudget, subRequestBudget } from '@myco/member/budget.js';
import { recallKind, RECALL_CAP_MS } from '@myco/member/recall.js';
import { mintId, promptEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember, recordingFetch, runHook } from './helpers/hooks.js';

let mycoHome: string;
let rig: MemberRig;
const savedHome = process.env.MYCO_HOME;

beforeEach(async () => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  resetMachineIdCache();
  rig = await memberRig();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

const SESSION = 'sess-recall-1';

const transcript = (): string => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recall-tx-')), `${SESSION}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, uuid: 'u1', timestamp: '2026-01-01T00:00:00Z' }) + '\n');
  return file;
};

/** `runMemberHook` with a handler this test writes, so the seam is driven directly. */
async function drive(
  raw: Record<string, unknown>,
  handle: (run: HookRun) => HookOutcome,
  fetchImpl: FetchLike,
): Promise<{ stdout: string; stderr: string }> {
  const originalArgv = process.argv;
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.argv = [originalArgv[0], 'myco', 'hook', 'user-prompt-submit', '--symbiont', 'claude-code'];
  _resetManifestCache();
  setBufferedStdin(Buffer.from(JSON.stringify({ session_id: SESSION, hook_event_name: 'UserPromptSubmit', ...raw })));
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { out.push(String(c)); return true; }) as never;
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { err.push(String(c)); return true; }) as never;
  try {
    await runMemberHook('user-prompt-submit', { credential: 'registry', fetch: fetchImpl, argv: process.argv, startedAt: Date.now() }, handle);
  } finally {
    (process.stdout as unknown as { write: unknown }).write = origOut;
    (process.stderr as unknown as { write: unknown }).write = origErr;
    process.argv = originalArgv;
    setBufferedStdin(null);
    _resetManifestCache();
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

const outcomeFor = (run: HookRun, context: HookOutcome['context']): HookOutcome => {
  const promptId = mintId();
  return {
    events: [promptEvent(run.ctx, { promptId, text: 'a typed prompt', origin: 'user' })],
    record: (state) => { state.promptId = promptId; state.prompts.typed = promptId; },
    response: { additionalContext: `Session:: \`${run.sessionId}\`` },
    context,
  };
};

describe('the recall seam', () => {
  it('runs after the append: the spool already holds the event and its receipt when the seam is called', async () => {
    const seen: Array<{ depth: number; receipted: boolean }> = [];
    const answered = await drive(
      { prompt: 'a typed prompt', transcript_path: transcript() },
      (run) => outcomeFor(run, async () => {
        // Read the spool from INSIDE the seam: a seam moved above the append
        // sees an empty spool and no receipt, and these assertions fail.
        seen.push({ depth: run.spool.depth(run.sessionId), receipted: readSessionState(run.spool.dir, run.sessionId).prompts.typed !== undefined });
        throw new Error('the deployment went dark');
      }),
      rig.fetch,
    );

    expect(seen).toEqual([{ depth: 1, receipted: true }]);
    expect(answered.stderr).toContain('[myco] user-prompt-submit: context skipped (the deployment went dark)');
    expect(answered.stdout).toBe(`Session:: \`${SESSION}\``);
    // A throw in the seam costs the served block alone: the drain that follows
    // still ships the event, and its receipt stays on disk.
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, SESSION).prompts.typed).toBeDefined();
  });

  it('is not called at all while the offline latch holds', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.markOffline(Date.now());
    let called = 0;
    const answered = await drive(
      { prompt: 'a typed prompt', transcript_path: transcript() },
      (run) => outcomeFor(run, async () => { called += 1; return { additionalContext: 'served' }; }),
      rig.fetch,
    );
    expect(called).toBe(0);
    expect(answered.stdout).toBe(`Session:: \`${SESSION}\``);
    // The latch holds the drain too, so the event stays spooled for the next probe.
    expect(spool.depth(SESSION)).toBe(1);
  });

  it('replaces the response with what the seam answers', async () => {
    const answered = await drive(
      { prompt: 'a typed prompt', transcript_path: transcript() },
      (run) => outcomeFor(run, async () => ({ additionalContext: `Session:: \`${run.sessionId}\`\n\nRelevant vault observations:\n- (decision) recency` })),
      rig.fetch,
    );
    expect(answered.stdout).toBe(`Session:: \`${SESSION}\`\n\nRelevant vault observations:\n- (decision) recency`);
    expect(rig.rows('prompt_batches')).toBe(1);
  });

  it('answers `undefined` and keeps the response the handler built', async () => {
    const answered = await drive(
      { prompt: 'a typed prompt', transcript_path: transcript() },
      (run) => outcomeFor(run, async () => undefined),
      rig.fetch,
    );
    expect(answered.stderr).toBe('');
    expect(answered.stdout).toBe(`Session:: \`${SESSION}\``);
  });
});

describe('the sub-budget', () => {
  it('takes a third of what a 5 s hook has left, capped, so the drain still ships', () => {
    const start = 1_000_000;
    // Claude Code declares 5 s for UserPromptSubmit: a 4 000 ms hook budget, connect 1 333.
    const budget = resolveHookBudget('claude-code', 'user-prompt-submit', { startedAt: start });
    expect([budget.hookBudgetMs, budget.connectTimeoutMs]).toEqual([4_000, 1_333]);

    const atStart = subRequestBudget(budget, RECALL_CAP_MS, start);
    expect(atStart).toEqual({ connectTimeoutMs: 444, requestTimeoutMs: 1_333 });
    expect(atStart.requestTimeoutMs).toBeLessThanOrEqual(RECALL_CAP_MS);

    // A longer hook budget is held to the cap rather than to its own third.
    const long = resolveHookBudget('claude-code', 'stop', { startedAt: start });
    expect(subRequestBudget(long, RECALL_CAP_MS, start).requestTimeoutMs).toBe(RECALL_CAP_MS);
  });

  it('leaves the drain enough to ship a record and spool the rest', async () => {
    const spool = new MemberSpool('proj_1', { mycoHome });
    const ctx: EnvelopeContext = { agent: 'claude-code', sessionId: 'sess-budget', stage: spool.stagerFor('sess-budget'), version: '2.0.0-test' };
    for (let i = 0; i < 2; i += 1) spool.append('sess-budget', promptEvent(ctx, { promptId: mintId(), text: `p${i}` }));

    const start = 1_000_000;
    let clock = start;
    const budget = resolveHookBudget('claude-code', 'user-prompt-submit', { startedAt: start });
    // Recall spends its whole sub-budget, then each event post spends its clipped one.
    clock += subRequestBudget(budget, RECALL_CAP_MS, clock).requestTimeoutMs;
    const ticking: FetchLike = async (input, init) => { clock += 2_000; return rig.fetch(input, init); };
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, ticking);

    const drained = await spool.drainSession('sess-budget', client, budget, { now: () => clock });
    expect(drained.endedBy).toBe('budget');
    expect([drained.acked, drained.remaining]).toEqual([1, 1]);
  });
});

describe('the served block, per symbiont', () => {
  const served = `Session:: \`${SESSION}\`\n\nMyco is where plans live.\n\nRelevant vault observations:\n- (decision) recency`;
  const capture = (write: () => void): string => {
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { out.push(String(c)); return true; }) as never;
    try { write(); } finally { (process.stdout as unknown as { write: unknown }).write = orig; }
    return out.join('');
  };

  it('carries every paragraph through each symbiont\'s own response shape', () => {
    // Claude Code takes the prompt-submit block as plain text.
    const claude = capture(() => writeHookResponse('claude-code', 'user-prompt-submit', { additionalContext: served }));
    expect(claude).toBe(served);

    const cursor = capture(() => writeHookResponse('cursor', 'user-prompt-submit', { additionalContext: served }));
    expect(JSON.parse(cursor)).toEqual({ additional_context: served });

    // A symbiont declaring no response shape takes plain text: the block itself.
    const plain = capture(() => writeHookResponse('not-a-symbiont', 'user-prompt-submit', { additionalContext: served }));
    expect(plain).toBe(served);
  });
});

describe('the prompt hook', () => {
  it('dials recall once per prompt, after the events are spooled, and keeps the `Session::` line when nothing is served', async () => {
    const spy = recordingFetch(rig.fetch);
    const out = await runHook(
      'user-prompt-submit',
      { session_id: SESSION, hook_event_name: 'UserPromptSubmit', transcript_path: transcript(), prompt: 'let us write the implementation plan' },
      { fetch: spy.fetch },
    );

    const paths = spy.requests.map((r) => r.path);
    expect(paths.filter((p) => p === '/context/prompt')).toHaveLength(1);
    // The prompt event is on the wire before recall is asked for anything.
    expect(paths.indexOf('/context/prompt')).toBeLessThan(paths.indexOf('/events'));
    const body = JSON.parse(spy.requests.find((r) => r.path === '/context/prompt')!.body!);
    expect(body.sessionId).toBe(SESSION);
    expect(body.text).toBe('let us write the implementation plan');
    expect(typeof body.promptId).toBe('string');

    // The Project is not admitted to `cortex`, so the answer is an empty block.
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe(`Session:: \`${SESSION}\``);
    expect(rig.rows('prompt_batches')).toBe(1);
  });

  it('serves the composed block into the response once the Project is admitted', async () => {
    rig.env.sqlite.query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`).run(Date.now());
    const out = await runHook(
      'user-prompt-submit',
      { session_id: SESSION, hook_event_name: 'UserPromptSubmit', transcript_path: transcript(), prompt: 'let us write the implementation plan' },
      { fetch: rig.fetch },
    );
    const answered = out.stdout;
    expect(answered.startsWith(`Session:: \`${SESSION}\`\n\n`)).toBe(true);
    expect(answered).toContain('Myco is where plans live');
    expect(rig.env.sqlite.query(`SELECT kind FROM session_injections`).all()).toEqual([{ kind: 'plan-nudge' }]);
  });

  it('latches the dark Deployment, keeps the `Session::` line, and leaves the event for the next probe', async () => {
    const failing: FetchLike = async (input, init) => {
      const req = new Request(input, init);
      if (new URL(req.url).pathname === '/context/prompt') throw new Error('connection refused');
      return rig.fetch(req);
    };
    const out = await runHook(
      'user-prompt-submit',
      { session_id: SESSION, hook_event_name: 'UserPromptSubmit', transcript_path: transcript(), prompt: 'a typed prompt' },
      { fetch: failing },
    );
    expect(out.stderr).toContain('[myco] user-prompt-submit: recall skipped (retry)');
    expect(out.stdout).toBe(`Session:: \`${SESSION}\``);

    // A transport failure on recall is a failure of the whole Deployment: the
    // latch is set and the drain behind it is skipped rather than spending a
    // second connect timeout on the same dark server.
    const spool = new MemberSpool('proj_1', { mycoHome });
    expect(spool.readLatch()).not.toBeNull();
    expect(spool.depth(SESSION)).toBe(1);
    expect(rig.rows('prompt_batches')).toBe(0);

    // The next hook past the latch delivers what was held, and a served answer clears it.
    spool.clearLatch();
    await runHook(
      'user-prompt-submit',
      { session_id: SESSION, hook_event_name: 'UserPromptSubmit', transcript_path: transcript(), prompt: 'a second prompt' },
      { fetch: rig.fetch },
    );
    expect(rig.rows('prompt_batches')).toBe(2);
    expect(spool.readLatch()).toBeNull();
  });

  it('asks for nothing when the prompt was dropped', async () => {
    const spy = recordingFetch(rig.fetch);
    const out = await runHook(
      'user-prompt-submit',
      { session_id: SESSION, hook_event_name: 'UserPromptSubmit', transcript_path: transcript(), prompt: '<local-command-stdout>ls</local-command-stdout>' },
      { fetch: spy.fetch },
    );
    expect(out.stdout).toContain('Session::');
    expect(spy.requests.map((r) => r.path)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The two start hooks
// ---------------------------------------------------------------------------

const admit = () => rig.env.sqlite
  .query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, ?, 'test')`)
  .run(Date.now());
const guidance = (content = 'Keep the plan current.') => rig.env.sqlite
  .query(`INSERT INTO cortex_instructions (project_id, id, agent_id, content, input_hash, source_run_id, generated_at) VALUES ('proj_1', ?, 'agent_1', ?, 'h', NULL, ?)`)
  .run(`ci_${content.length}`, content, Date.now());
const delivered = () => readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, SESSION).delivered;
const darkTo = (path: string): FetchLike => async (input, init) => {
  const req = new Request(input, init);
  if (new URL(req.url).pathname === path) throw new Error('connection refused');
  return rig.fetch(req);
};

describe('the session-start hook', () => {
  const start = (fetchImpl: FetchLike) => runHook(
    'session-start',
    { session_id: SESSION, hook_event_name: 'SessionStart', transcript_path: transcript(), cwd: '/work/repo' },
    { fetch: fetchImpl },
  );

  it('asks for the session block and writes the branch and the session under it', async () => {
    admit();
    guidance();
    const spy = recordingFetch(rig.fetch);
    const out = await start(spy.fetch);

    const asked = spy.requests.filter((r) => r.path === '/context/session');
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0].body!)).toEqual({ sessionId: SESSION, kind: 'start' });
    // The session event is on the wire before the block is asked for.
    expect(spy.requests.map((r) => r.path).indexOf('/context/session'))
      .toBeLessThan(spy.requests.map((r) => r.path).indexOf('/events'));

    // The block, then the branch this checkout is on, then the session — each
    // its own paragraph, in the order the harness has received them in.
    expect(out.stdout).toBe([
      'Keep the plan current.',
      `Branch:: \`${runGit(['rev-parse', '--abbrev-ref', 'HEAD'], process.cwd())}\``,
      `Session:: \`${SESSION}\``,
    ].join('\n\n'));
    expect(rig.rows('sessions')).toBe(1);
  });

  it('marks the kind the Deployment named and asks once per session', async () => {
    admit();
    guidance();
    await start(rig.fetch);
    expect(delivered()).toEqual(['cortex']);

    const spy = recordingFetch(rig.fetch);
    const again = await start(spy.fetch);
    expect(spy.requests.map((r) => r.path).filter((p) => p === '/context/session')).toEqual([]);
    expect(again.stdout).toBe('');
  });

  it('remembers a Project that is not admitted, and asks it nothing again', async () => {
    const spy = recordingFetch(rig.fetch);
    const out = await start(spy.fetch);
    expect(spy.requests.map((r) => r.path)).toContain('/context/session');
    expect(out.stdout).toBe('');
    // `capability` is settled for the life of the session, so the kind is marked.
    expect(delivered()).toEqual(['cortex']);

    const again = recordingFetch(rig.fetch);
    await start(again.fetch);
    expect(again.requests.map((r) => r.path).filter((p) => p === '/context/session')).toEqual([]);
  });

  it('asks again while the admitted Project simply holds nothing yet', async () => {
    admit();
    const first = recordingFetch(rig.fetch);
    const out = await start(first.fetch);
    expect(out.stdout).toBe('');
    // Nothing settled: an artifact written later still reaches this session.
    expect(delivered()).toEqual([]);

    guidance();
    const second = recordingFetch(rig.fetch);
    const later = await start(second.fetch);
    expect(second.requests.map((r) => r.path).filter((p) => p === '/context/session')).toHaveLength(1);
    expect(later.stdout.startsWith('Keep the plan current.')).toBe(true);
    expect(delivered()).toEqual(['cortex']);
  });

  it('is not called at all while the offline latch holds', async () => {
    admit();
    guidance();
    const spool = new MemberSpool('proj_1', { mycoHome });
    spool.markOffline(Date.now());
    const spy = recordingFetch(rig.fetch);
    const out = await start(spy.fetch);
    expect(spy.requests.map((r) => r.path)).toEqual([]);
    expect(out.stdout).toBe('');
    expect(delivered()).toEqual([]);
  });

  it('latches the dark Deployment, writes one line, and marks nothing', async () => {
    admit();
    guidance();
    const out = await start(darkTo('/context/session'));
    expect(out.stderr).toContain('[myco] session-start: recall skipped (retry)');
    expect(out.stdout).toBe('');
    expect(delivered()).toEqual([]);
    expect(new MemberSpool('proj_1', { mycoHome }).shouldDial(Date.now())).toBe(false);
  });

  it('asks for nothing when the session was dropped', async () => {
    admit();
    guidance();
    const dropped = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-recall-drop-')), `${SESSION}.jsonl`);
    fs.writeFileSync(dropped, JSON.stringify({ type: 'user', entrypoint: 'sdk-py', message: { role: 'user', content: 'x' } }) + '\n');
    const spy = recordingFetch(rig.fetch);
    const out = await runHook('session-start', { session_id: SESSION, hook_event_name: 'SessionStart', transcript_path: dropped }, { fetch: spy.fetch });
    expect(out.stderr).toContain('session-start: dropped');
    expect(spy.requests.map((r) => r.path)).toEqual([]);
  });

  it('asks for nothing on behalf of a symbiont whose harness discards the answer', async () => {
    admit();
    guidance();
    expect(HOOK_CONFIG['claude-code'].capabilities.sessionStartInjection).toBe(true);
    expect(HOOK_CONFIG.windsurf.capabilities.sessionStartInjection).toBe(false);
    const spy = recordingFetch(rig.fetch);
    // Windsurf names its session on its own field, so the hook runs and the
    // capability alone is what holds the call back.
    await runHook(
      'session-start',
      { trajectory_id: SESSION, hook_event_name: 'SessionStart', transcript_path: transcript(), cwd: '/work/repo' },
      { fetch: spy.fetch, symbiont: 'windsurf' },
    );
    expect(spy.requests.map((r) => r.path).filter((p) => p === '/context/session')).toEqual([]);
    // The event itself still travels.
    expect(spy.requests.map((r) => r.path)).toContain('/events');
  });
});

describe('the subagent-start hook', () => {
  const delegate = (fetchImpl: FetchLike, over: Record<string, unknown> = {}, symbiont = 'claude-code') => runHook(
    'subagent-start',
    { session_id: SESSION, hook_event_name: 'SubagentStart', transcript_path: transcript(), agent_id: 'a1', agent_type: 'code-reviewer', ...over },
    { fetch: fetchImpl, symbiont },
  );

  it('serves the delegated agent the guidance block, and serves the next delegation of the same type too', async () => {
    admit();
    guidance();
    const spy = recordingFetch(rig.fetch);
    const out = await delegate(spy.fetch);

    const asked = spy.requests.filter((r) => r.path === '/context/session');
    expect(asked).toHaveLength(1);
    expect(JSON.parse(asked[0].body!)).toEqual({ sessionId: SESSION, kind: 'subagent', agentId: 'a1', agentType: 'code-reviewer' });
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SubagentStart',
        additionalContext: 'You are a delegated subagent working inside a Myco-connected project.\n'
          + 'Follow these managed Cortex instructions as current project guidance.\n'
          + 'Apply them to your assigned task, and defer broad orchestration decisions back to the parent agent.\n\n'
          + 'Keep the plan current.',
      },
    });
    expect(delivered()).toEqual(['cortex:a1']);

    // A second delegation of the same type is a second subagent, and is served.
    const second = recordingFetch(rig.fetch);
    const other = await delegate(second.fetch, { agent_id: 'a2' });
    expect(second.requests.map((r) => r.path).filter((p) => p === '/context/session')).toHaveLength(1);
    expect(JSON.parse(other.stdout).hookSpecificOutput.additionalContext).toContain('Keep the plan current.');
    expect(delivered()).toEqual(['cortex:a1', 'cortex:a2']);

    // The same delegation twice is one subagent.
    const repeated = recordingFetch(rig.fetch);
    await delegate(repeated.fetch, { agent_id: 'a1' });
    expect(repeated.requests.map((r) => r.path).filter((p) => p === '/context/session')).toEqual([]);
  });

  it('names the delegation the way the Deployment records it', async () => {
    admit();
    guidance();
    // A harness naming no id falls to the type; one naming neither to a single name.
    await delegate(rig.fetch, { agent_id: undefined, agent_type: 'explorer' });
    expect(delivered()).toEqual(['cortex:explorer']);
    await delegate(rig.fetch, { agent_id: undefined, agent_type: undefined });
    expect(delivered()).toEqual(['cortex:explorer', 'cortex:unknown']);
    // The member's own key and the kind the Deployment answers are the same name.
    expect([
      recallKind({ sessionId: SESSION, kind: 'start' }),
      recallKind({ sessionId: SESSION, kind: 'subagent', agentId: ' a1 ', agentType: 'code-reviewer' }),
      recallKind({ sessionId: SESSION, kind: 'subagent', agentType: 'explorer' }),
      recallKind({ sessionId: SESSION, kind: 'subagent' }),
    ]).toEqual(['cortex', 'cortex:a1', 'cortex:explorer', 'cortex:unknown']);
  });

  it('asks for nothing on behalf of a symbiont whose harness discards the answer', async () => {
    admit();
    guidance();
    expect(HOOK_CONFIG.cursor.capabilities.subagentStartInjection).toBe(false);
    const spy = recordingFetch(rig.fetch);
    const out = await delegate(spy.fetch, {}, 'cursor');
    expect(spy.requests.map((r) => r.path).filter((p) => p === '/context/session')).toEqual([]);
    expect(out.stdout).toBe('');
    // The event itself still travels.
    expect(spy.requests.map((r) => r.path)).toContain('/events');
  });

  it('is not called at all while the offline latch holds', async () => {
    admit();
    guidance();
    new MemberSpool('proj_1', { mycoHome }).markOffline(Date.now());
    const spy = recordingFetch(rig.fetch);
    const out = await delegate(spy.fetch);
    expect(spy.requests.map((r) => r.path)).toEqual([]);
    expect(out.stdout).toBe('');
    expect(delivered()).toEqual([]);
  });

  it('latches the dark Deployment, writes one line, and keeps the event', async () => {
    admit();
    guidance();
    const out = await delegate(darkTo('/context/session'));
    expect(out.stderr).toContain('[myco] subagent-start: recall skipped (retry)');
    expect(out.stdout).toBe('');
    expect(delivered()).toEqual([]);
  });
});
