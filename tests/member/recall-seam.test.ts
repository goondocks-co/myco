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
import { setBufferedStdin } from '@myco/hooks/read-stdin.js';
import { _resetManifestCache } from '@myco/hooks/normalize.js';
import { writeHookResponse } from '@myco/hooks/response.js';
import { RECALL_CAP_MS } from '@myco/hooks/user-prompt-submit.js';
import { runMemberHook, type HookOutcome, type HookRun } from '@myco/member/capture.js';
import { resolveHookBudget, subRequestBudget } from '@myco/member/budget.js';
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
  it('runs after the append: a seam that throws leaves the events, the receipts and the `Session::` line intact', async () => {
    const answered = await drive(
      { prompt: 'a typed prompt', transcript_path: transcript() },
      (run) => outcomeFor(run, async () => { throw new Error('the deployment went dark'); }),
      rig.fetch,
    );

    expect(answered.stderr).toContain('[myco] user-prompt-submit: recall skipped (the deployment went dark)');
    expect(answered.stdout).toBe(`Session:: \`${SESSION}\``);
    // The prompt reached the server through the drain that followed the throw,
    // and its receipt is on disk.
    expect(rig.rows('prompt_batches')).toBe(1);
    expect(readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, SESSION).prompts.typed).toBeDefined();
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

  it('writes one line and keeps the `Session::` line when the Deployment refuses the call', async () => {
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
    expect(rig.rows('prompt_batches')).toBe(1);
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
