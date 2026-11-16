import { helperPass } from '@myco/member/helper-pass.js';
import { PROMPT_CONTEXT_INLINE_CAP_MS, PROMPT_CONTEXT_TOOL_CAP_MS } from '@myco/member/prompt-context.js';
import { publishFixture, readFixtureRecords } from '../myco-server/helpers/fixtures.js';
/**
 * Prompt recall belongs to its submission; session blocks remain cached for later session hooks.
 * - A session start renders the Project's start block once per session; a block the Project withdraws stops being
 *   served.
 * - A delegated agent renders the subagent block once per delegation.
 * - The features the Deployment advertises are read from every answer: a hook emits `turn` events while they are
 *   named, and stops the moment an answer no longer names them; the session's transcripts keep shipping.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FEATURES_HEADER, PROTOCOL_HEADER } from '@goondocks/myco-shared/member-protocol';
import { cacheDeploymentFeatures, readDeploymentFeatures, readProjectContext, updateProjectContext } from '@myco/member/context-cache.js';
import { projectLine } from '@goondocks/myco-shared/recall';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';
import { featureCacheDiagnostic, projectContextPath } from '@myco/member/context-cache.js';
import { deploymentFeaturesPath } from '@myco/member/registry.js';
import { prefetchContext, watchingFeatures } from '@myco/member/prefetch.js';
import { promptContextLogPrefix } from '@myco/member/context-diagnostics.js';
import { helperLogPath, routeStderrToHelperLog } from '@myco/member/helper.js';
import { drainBacklog, holdsTranscriptTail } from '@myco/member/backlog.js';
import { ENV_JOIN_CODE } from '@myco/member/constants.js';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { readSessionState } from '@myco/member/session-state.js';
import { transcriptPointerFor } from '@myco/member/transcript.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from './helpers/env-client.js';
import { deadlineBudget } from '@myco/member/budget.js';
import type { FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from './helpers/hooks.js';

let mycoHome: string;
let rig: MemberRig;
const savedHome = process.env.MYCO_HOME;
beforeEach(async () => {
  mycoHome = tempMycoHome();
  scratch.push(mycoHome);
  process.env.MYCO_HOME = mycoHome;
  rig = await memberRig();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
});
/**
 * The filesystem refusing one call: `fs[call]` throws EACCES whenever `when` matches its path arguments, and behaves
 * normally otherwise.
 */
function failing(call: 'renameSync', when: (first: string, second: string) => boolean): { mockRestore(): void } {
  const real = fs[call] as (...args: unknown[]) => unknown;
  return spyOn(fs, call).mockImplementation(((...args: unknown[]) => {
    if (when(String(args[0]), String(args[1]))) throw Object.assign(new Error(`fixture ${call} refused`), { code: 'EACCES' });
    return real(...args);
  }) as never);
}
/** Directories a test made, removed after it. */
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.env.MYCO_HOME = savedHome;
});

const transcript = (id: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-render-tx-'));
  scratch.push(dir);
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  return file;
};
const spool = () => new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://member-test.invalid' }, { mycoHome });
/** The context a hook answered, whether its harness takes JSON or plain text. */
const contextOf = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string }; additionalContext?: string; additional_context?: string };
    return parsed.hookSpecificOutput?.additionalContext ?? parsed.additionalContext ?? parsed.additional_context ?? stdout;
  } catch {
    return stdout.trim();
  }
};

/** The rig, with the prompt route answered by `serve`: what the Deployment would compose for a prompt. */
function servingPrompts(serve: (body: { promptId: string; text: string }) => string): { fetch: FetchLike; asked: Array<{ promptId: string; text: string; rendered?: string[] }> } {
  const asked: Array<{ promptId: string; text: string; rendered?: string[] }> = [];
  const fetch: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname === '/context/prompt') {
      const body = JSON.parse(await req.clone().text()) as { promptId: string; text: string };
      asked.push(body);
      return Response.json({ persisted: true, context: serve(body), receiptId: crypto.randomUUID(), skipped: [] }, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: 'turn,prompt-identity,prompt-scheme' } });
    }
    return rig.fetch(req);
  };
  return { fetch, asked };
}

describe('a prompt', () => {
  it('renders the answer selected for this submission, including a single-prompt session', async () => {
    const served = servingPrompts(body => `Recalled for: ${body.text}`);
    const tx = transcript('sess-p');
    cacheDeploymentFeatures('https://member-test.invalid', ['prompt-identity', 'prompt-scheme'], mycoHome);
    const fetch: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/events' && (await request.clone().json() as { kind: string }).kind === 'context.delivered') {
        return Response.json({ persisted: false, code: 'refused' }, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: 'prompt-identity,prompt-scheme,turn' } });
      }
      return served.fetch(request);
    };
    for (const prompt of ['how do we rotate tokens?', 'and the window?']) {
      const ran = await runHook('user-prompt-submit', { session_id: 'sess-p', prompt, transcript_path: tx }, { helpers: 'run', fetch, symbiont: 'pi' });
      expect(contextOf(ran.stdout)).toBe(`Session:: \`sess-p\`\n\nRecalled for: ${prompt}`);
      expect(served.asked.at(-1)?.promptId).toBe(readSessionState(spool().dir, 'sess-p').promptId!);
      expect(ran.stderr).toContain('wait_ms=');
    }
    expect(served.asked[1]?.rendered).toHaveLength(1);
    expect(Object.values(readSessionState(spool().dir, 'sess-p').promptRecall!.asks).every(held => held.request.text === '')).toBe(true);
    await spool().drainSession('sess-p', new ServerClient({ serverUrl: 'https://member-test.invalid', token: rig.token, projectId: 'proj_1' }, async () => Response.json({ persisted: true })), deadlineBudget(Date.now() + 10_000));
    await runHook('user-prompt-submit', { session_id: 'sess-p', prompt: 'after acknowledgment', transcript_path: tx }, { helpers: 'run', fetch, symbiont: 'pi' });
    expect(served.asked.at(-1)?.rendered).toEqual([]);
    expect(readSessionState(spool().dir, 'sess-p').contextAsks).toBeUndefined();
    const refused = new ServerClient({ serverUrl: 'https://member-test.invalid', token: rig.token, projectId: 'proj_1' }, async (input, init) => {
      const record = await new Request(input, init).json() as { kind: string };
      return Response.json(record.kind === 'context.delivered' ? { persisted: false, code: 'session_tombstoned' } : { persisted: true });
    });
    await spool().drainSession('sess-p', refused, deadlineBudget(Date.now() + 10_000));
    expect(readSessionState(spool().dir, 'sess-p').promptRecall?.asks).toEqual({});
    cacheDeploymentFeatures('https://member-test.invalid', [], mycoHome);
    const legacy = await runHook('user-prompt-submit', { session_id: 'sess-legacy', prompt: 'older Deployment', transcript_path: transcript('sess-legacy') }, { helpers: 'run', fetch: served.fetch, symbiont: 'pi' });
    expect(contextOf(legacy.stdout)).toContain('Recalled for: older Deployment');
    expect(readSessionState(spool().dir, 'sess-legacy').promptRecall?.asks).toEqual({});
  });

  it('does not ask for or render memory on a task notification', async () => {
    const served = servingPrompts(() => 'private recalled context');
    const notice = '<task-notification>\n<task-id>tid-1</task-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>';
    const ran = await runHook('user-prompt-submit', { session_id: 'sess-note', prompt: notice, transcript_path: transcript('sess-note') }, { fetch: served.fetch });
    expect(contextOf(ran.stdout)).toBe('Session:: `sess-note`');
    expect(served.asked).toEqual([]);
  });

  async function latePrompt(agent: string, sessionId: string, capMs: number, discardReply: Record<string, unknown> = { persisted: true }) {
    cacheDeploymentFeatures('https://member-test.invalid', ['prompt-identity', 'prompt-scheme'], mycoHome);
    let resolve: ((answer: Response) => void) | undefined;
    let background: Promise<unknown> | undefined;
    let asking: { promptId?: string; text: string } | undefined;
    const discarded: string[] = [];
    const receiptId = crypto.randomUUID();
    const fetch: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/context/discard') {
        discarded.push((await request.json() as { receiptId: string }).receiptId);
        return Response.json(discardReply);
      }
      asking = await request.json() as { promptId?: string; text: string };
      return new Promise<Response>(done => { resolve = done; });
    };
    const spawn = () => {
      background ??= prefetchContext({ spool: spool(), client: new ServerClient({ serverUrl: 'https://member-test.invalid', token: rig.token, projectId: 'proj_1' }, fetch),
        serverUrl: 'https://member-test.invalid', mycoHome, budget: deadlineBudget(Date.now() + 10_000), now: Date.now });
      return { started: true, pid: process.pid };
    };
    const tx = transcript(sessionId);
    const started = Date.now();
    const first = await runHook('user-prompt-submit', { session_id: sessionId, conversationId: sessionId, trajectory_id: sessionId, tool_info: { user_prompt: 'late recall', transcript_path: tx }, prompt: 'late recall', turn_id: 'turn-one', transcript_path: tx }, { fetch, symbiont: agent, helperSpawn: spawn });
    expect(Date.now() - started).toBeLessThan(capMs + 500);
    if (agent === 'copilot') expect(first.stdout).toBe('');
    else {
      expect(first.stderr).toContain(`cap_ms=${capMs}`);
      expect(contextOf(first.stdout)).toBe(`Session:: \`${sessionId}\``);
    }
    const finish = async () => { resolve!(Response.json({ persisted: true, context: 'held memory', receiptId })); await background; };
    const tool = () => runHook('post-tool-use', { session_id: sessionId, conversationId: sessionId, trajectory_id: sessionId, agent_action_name: 'post_run_command', tool_info: { transcript_path: tx }, tool_name: 'Read', tool_input: {}, turn_id: 'turn-one', transcript_path: tx }, { fetch, symbiont: agent, helperSpawn: spawn });
    return { first, finish, tool, spawn, fetch, tx, asking: () => asking, discarded, receiptId };
  }

  it.each(['codex', 'copilot'])('%s delivers memory on the first tool hook once, retaining its known prompt scope', async agent => {
    const held = await latePrompt(agent, 'sess-tool', PROMPT_CONTEXT_TOOL_CAP_MS);
    updateProjectContext(spool().dir, mycoHome, cache => { cache.blocks.start = { context: 'session-start block', at: Date.now() }; });
    await held.finish();
    const tool = await held.tool();
    expect(contextOf(tool.stdout)).toContain('held memory');
    expect(contextOf(tool.stdout)).not.toContain('session-start block');
    expect(tool.stderr).toContain('delivery=tool');
    expect(contextOf((await held.tool()).stdout)).not.toContain('held memory');
    const delivery = spool().readRecords('sess-tool').find(record => record?.kind === 'context.delivered');
    const promptId = held.asking()?.promptId;
    expect(delivery?.payload).toMatchObject(promptId === undefined ? { renderedScopeReason: 'transcript_only' } : { renderedIn: promptId });
  });

  it('keeps native tool callbacks eligible while recall is still in flight', async () => {
    const held = await latePrompt('opencode', 'sess-native-pending', PROMPT_CONTEXT_TOOL_CAP_MS);
    try {
      expect(JSON.parse(held.first.stdout).recallPending).toBe(true);
      const check = await runHook('prompt-recall', { session_id: 'sess-native-pending' }, { fetch: held.fetch, symbiont: 'opencode' });
      expect(JSON.parse(check.stdout)).toEqual({ recallPending: true });
    } finally { await held.finish(); }
  });

  it('starts Claude recall beside delivery and renders it once without capturing the tool again', async () => {
    const sessionId = 'sess-claude-late';
    const tx = transcript(sessionId);
    cacheDeploymentFeatures('https://member-test.invalid', ['prompt-identity', 'prompt-scheme'], mycoHome);
    await runHook('session-start', { session_id: sessionId, transcript_path: tx }, { fetch: rig.fetch });
    let releaseEvents!: () => void;
    let releaseAnswer!: (response: Response) => void;
    const events = new Promise<void>(done => { releaseEvents = done; });
    const answer = new Promise<Response>(done => { releaseAnswer = done; });
    let asking: { promptId: string } | undefined;
    const fetch: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/context/prompt') {
        asking = await request.json() as { promptId: string };
        releaseEvents();
        return answer;
      }
      if (new URL(request.url).pathname === '/events') await events;
      return rig.fetch(request);
    };
    let background: Promise<unknown> | undefined;
    const spawn = () => {
      background ??= helperPass({ projectId: 'proj_1', serverUrl: 'https://member-test.invalid' }, mycoHome, { fetch })(Date.now() + 10_000, { force: true });
      return { started: true, pid: process.pid };
    };
    try {
      const prompt = await runHook('user-prompt-submit', { session_id: sessionId, prompt_id: 'claude-turn', prompt: 'late Claude memory', transcript_path: tx }, { fetch, helperSpawn: spawn });
      const startedBeforeDeliveryFinished = asking !== undefined;
      const drainedBeforeAnswer = spool().depth(sessionId) === 0;
      releaseEvents();
      releaseAnswer(Response.json({ persisted: true, context: 'late Claude context', receiptId: crypto.randomUUID() }));
      await background;
      expect(startedBeforeDeliveryFinished).toBe(true);
      expect(drainedBeforeAnswer).toBe(true);
      expect(prompt.stderr).toContain(`cap_ms=${PROMPT_CONTEXT_TOOL_CAP_MS} delivery=pending`);
      const input = { session_id: sessionId, prompt_id: 'claude-turn', tool_name: 'Write', tool_input: {}, transcript_path: tx };
      expect((await runHook('prompt-recall', { ...input, agent_id: 'child-explore', agent_type: 'Explore' }, { fetch })).stdout).toBe('');
      expect(Object.values(readSessionState(spool().dir, sessionId).promptRecall!.asks).map(ask => ask.stage)).toEqual(['ready']);
      const tool = await runHook('prompt-recall', input, { fetch });
      expect(JSON.parse(tool.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'late Claude context' } });
      expect((await runHook('prompt-recall', input, { fetch })).stdout).toBe('');
      const records = spool().readRecords(sessionId).filter(record => record !== null);
      expect(records.filter(record => record.kind === 'context.delivered').map(record => record.payload.renderedIn)).toEqual([asking!.promptId]);
      expect(records.some(record => record.kind === 'tool.use' || record.kind === 'plan')).toBe(false);
    } finally { releaseEvents(); releaseAnswer(Response.json({ persisted: true, context: '' })); await background; }
  });

  it('discards a late answer when the next prompt arrives before it', async () => {
    const held = await latePrompt('copilot', 'sess-replaced', PROMPT_CONTEXT_TOOL_CAP_MS);
    await runHook('user-prompt-submit', { session_id: 'sess-replaced', prompt: 'next prompt', transcript_path: held.tx }, { fetch: held.fetch, symbiont: 'copilot', helperSpawn: held.spawn });
    await held.finish();
    expect(contextOf((await held.tool()).stdout)).not.toContain('held memory');
    expect(held.discarded).toEqual([held.receiptId]);
  });

  it('captures Windsurf prompts without requesting memory that its hooks cannot deliver', async () => {
    const served = servingPrompts(() => 'unreadable memory');
    const ran = await runHook('user-prompt-submit', { trajectory_id: 'sess-unsupported', tool_info: { user_prompt: 'capture me' } },
      { helpers: 'run', fetch: served.fetch, symbiont: 'windsurf' });
    expect(ran.stdout).toBe('');
    expect(served.asked).toEqual([]);
    expect(readSessionState(spool().dir, 'sess-unsupported').promptRecall).toBeUndefined();
  });

  it('discards a late answer when the harness tool hook cannot add context', async () => {
    const held = await latePrompt('cursor', 'sess-unsupported', PROMPT_CONTEXT_INLINE_CAP_MS, { persisted: false, code: 'session_tombstoned' });
    expect(Number(/wait_ms=(\d+)/.exec(held.first.stderr)?.[1])).toBeGreaterThan((PROMPT_CONTEXT_TOOL_CAP_MS + PROMPT_CONTEXT_INLINE_CAP_MS) / 2);
    await held.finish();
    expect(contextOf((await held.tool()).stdout)).not.toContain('held memory');
    expect(held.discarded).toEqual([held.receiptId]);
    await prefetchContext({ spool: spool(), client: new ServerClient({ serverUrl: 'https://member-test.invalid', token: rig.token, projectId: 'proj_1' }, held.fetch), serverUrl: 'https://member-test.invalid', mycoHome, budget: deadlineBudget(Date.now() + 10_000), now: Date.now });
    expect(held.discarded).toEqual([held.receiptId]);
  });

  it('bounds a hung environment recall without treating a slow share as an outage', async () => {
    let requests = 0;
    const fetch: FetchLike = async () => ++requests === 1 ? new Promise<Response>(() => {}) : Response.json({ persisted: true, context: 'healthy recall' });
    const env = { ...process.env, MYCO_HOME: mycoHome, MYCO_SERVER_URL: 'https://member-test.invalid', MYCO_MEMBER_TOKEN: rig.token, MYCO_PROJECT: 'proj_1' };
    const input = { session_id: 'env-slow', prompt: 'first', transcript_path: transcript('env-slow') };
    const options = { fetch, env, credential: 'env' as const, symbiont: 'copilot' };
    const missed = await runHook('user-prompt-submit', input, options);
    expect(missed.stdout).toBe('');
    expect(missed.stderr).toContain(`cap_ms=${PROMPT_CONTEXT_INLINE_CAP_MS} delivery=discarded`);
    expect(missed.stderr).toContain('result=slow');
    expect(readSessionState(spool().dir, 'env-slow').promptRecall?.asks ?? {}).toEqual({});
    const recovered = await runHook('user-prompt-submit', { ...input, prompt: 'second' }, options);
    // Copilot drops its prompt hook's output, so the answer is held, uncounted, for the first tool call of the same turn.
    expect(recovered.stdout).toBe('');
    expect(recovered.stderr).not.toContain('delivery=inline');
    const tool = () => runHook('post-tool-use', { session_id: 'env-slow', transcript_path: transcript('env-slow'), tool_name: 'view', tool_input: { path: 'README.md' }, cwd: process.cwd() }, options);
    const delivered = await tool();
    expect(contextOf(delivered.stdout)).toContain('healthy recall');
    expect(delivered.stderr).toContain('delivery=tool');
    expect(contextOf((await tool()).stdout)).not.toContain('healthy recall');
    expect(requests).toBe(2);
  });

  it('reports safe diagnostics for an empty answer and renders the Session line alone', async () => {
    const served = servingPrompts(() => '');
    const ran = await runHook('user-prompt-submit', { session_id: 'sess-empty', prompt: 'find evidence' }, { helpers: 'run', fetch: served.fetch, symbiont: 'pi' });
    expect(contextOf(ran.stdout)).toBe('Session:: `sess-empty`');
    expect(ran.stderr).toContain('answered empty');
  });
});

describe('a session start\'s repository remote', () => {
  it('is asked of git by the helper, which sends it with the start: the Deployment binds it to the Project', async () => {
    const repo = removeWhenTestsEnd(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remote-'))));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'a');
    git('remote', 'add', 'origin', 'https://github.com/acme/remote-binding.git');
    registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt, root: repo });
    // The hook names where to ask, and reads no remote itself.
    await runHook('session-start', { session_id: 'sess-remote', transcript_path: transcript('sess-remote'), cwd: repo }, { fetch: rig.fetch });
    expect(readSessionState(spool().dir, 'sess-remote').contextAsks).toEqual([expect.objectContaining({ kind: 'start', remoteFrom: repo })]);
    await runHook('user-prompt-submit', { session_id: 'sess-remote', prompt: 'p', transcript_path: transcript('sess-remote'), cwd: repo }, { helpers: 'run', fetch: rig.fetch });
    expect(rig.env.sqlite.query(`SELECT remote FROM project_remotes`).all()).toEqual([{ remote: 'github.com/acme/remote-binding' }]);
  });
});

describe('a session start', () => {
  const instructions = (text: string | null) => {
    rig.env.sqlite.query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', ?, ?, 'test')`).run(text === null ? 0 : 1, Date.now());
    rig.env.sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('instructions.template', ?, ?, 'test')`).run(JSON.stringify(text ?? ''), Date.now());
  };

  it('records and injects Antigravity session context once across model invocations', async () => {
    instructions('Conversation context.');
    const invoke = (id: string, invocationNum: number) => runHook('session-start', {
      conversationId: id, transcriptPath: transcript(id), workspacePaths: [process.cwd()],
      invocationNum, lastUserInput: 'the current request',
    }, { symbiont: 'antigravity', helpers: 'run', fetch: rig.fetch });
    await invoke('ag-warm', 1);
    const first = await invoke('ag-once', 1);
    expect(JSON.parse(first.stdout).injectSteps).toContainEqual({ userMessage: expect.stringContaining('Conversation context.') });
    const events = rig.env.sqlite.query('SELECT kind, payload FROM events WHERE session_id=? ORDER BY rowid').all('ag-once');
    for (const invocation of [2, 3]) expect(JSON.parse((await invoke('ag-once', invocation)).stdout)).toEqual({});
    expect(rig.env.sqlite.query('SELECT kind, payload FROM events WHERE session_id=? ORDER BY rowid').all('ag-once')).toEqual(events);
  });

  it('tells a project\'s first session on this machine its Project, from nothing cached and with no request', async () => {
    const spy = recordingFetch(rig.fetch);
    const first = await runHook('session-start', { session_id: 'sess-cold', transcript_path: transcript('sess-cold'), cwd: process.cwd() }, { fetch: spy.fetch });
    expect(spy.requests).toEqual([]);
    expect(contextOf(first.stdout).startsWith(`${projectLine('proj_1')}\n\n`)).toBe(true);
    expect(contextOf(first.stdout)).toContain('Session:: `sess-cold`');
  });

  it('serves the first session after a join its whole block: the join cached it', async () => {
    instructions('Joined and briefed.');
    // A sandbox's first hook redeems its join code, and caches the Project's blocks with the membership.
    const fresh = tempMycoHome();
    scratch.push(fresh);
    process.env.MYCO_HOME = fresh;
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { issuer: { kind: 'operator' }, role: 'member', projectId: 'proj_1' });
    process.env[ENV_JOIN_CODE] = `https://s/join#${issued.key}`;
    try {
      const start = await runHook('session-start', { session_id: 'sess-joined', transcript_path: transcript('sess-joined'), cwd: process.cwd() }, { fetch: rig.fetch, credential: 'env' });
      expect(contextOf(start.stdout)).toContain(projectLine('proj_1'));
      expect(contextOf(start.stdout)).toContain('Joined and briefed.');
      // Previewed for no session: the session's own ask is the one the Deployment records.
      expect(rig.env.sqlite.query(`SELECT session_id FROM session_injections`).all()).toEqual([]);
    } finally {
      delete process.env[ENV_JOIN_CODE];
    }
  });

  it('renders the Project\'s block once per session from what the helper fetched, and stops once the Project withdraws it', async () => {
    instructions('Write tests first.');
    const start = (id: string) => runHook('session-start', { session_id: id, transcript_path: transcript(id), cwd: process.cwd() }, { helpers: 'run', fetch: rig.fetch });
    // Nothing cached yet: the Project line alone.
    expect(contextOf((await start('sess-1')).stdout)).not.toContain('Write tests first.');
    expect(readProjectContext(spool().dir).blocks.start?.context).toContain('Write tests first.');
    const second = await start('sess-2');
    expect(second.stdout).toContain('Write tests first.');
    expect(second.stdout).toContain('Session:: `sess-2`');
    // Once per session: a start fired again in the same session serves nothing.
    expect((await start('sess-2')).stdout).toBe('');

    // The capability goes off: the next answer replaces the block with what the Project serves now, and the session
    // after is served no instructions.
    instructions(null);
    await start('sess-3');
    expect(readProjectContext(spool().dir).blocks.start?.context).not.toContain('Write tests first.');
    expect((await start('sess-4')).stdout).not.toContain('Write tests first.');
  });

  it('is asked for by the session that renders it, once: a resumed start asks nothing, and a block rendered on a tool call is asked for there', async () => {
    instructions('Asked by the renderer.');
    // An earlier session's ask cached the block.
    await runHook('session-start', { session_id: 'sess-earlier', transcript_path: transcript('sess-earlier'), cwd: process.cwd() }, { helpers: 'run', fetch: rig.fetch });
    const tx = transcript('sess-asker');
    await runHook('session-start', { session_id: 'sess-asker', transcript_path: tx, cwd: process.cwd() }, { helpers: 'run', fetch: rig.fetch });
    const recorded = () => (rig.env.sqlite.query(`SELECT session_id FROM session_injections WHERE kind = 'cortex' ORDER BY session_id`).all() as Array<{ session_id: string }>).map((r) => r.session_id);
    expect(recorded()).toEqual(['sess-asker', 'sess-earlier']);
    // Resumed: served nothing again, and nothing asked.
    const offline: FetchLike = async () => { throw new TypeError('fetch failed'); };
    await runHook('session-start', { session_id: 'sess-asker', transcript_path: tx, cwd: process.cwd(), source: 'resume' }, { fetch: offline });
    expect(readSessionState(spool().dir, 'sess-asker').contextAsks).toBeUndefined();
    // A harness that is served the block on its first tool call: that session renders it from the cache, and asks.
    const cursor = await runHook('post-tool-use', { session_id: 'sess-tool', transcript_path: transcript('sess-tool'), tool_name: 'Read', tool_input: { file_path: '/a' }, cwd: process.cwd() }, { helpers: 'run', fetch: rig.fetch, symbiont: 'cursor' });
    expect(contextOf(cursor.stdout)).toContain('Asked by the renderer.');
    expect(recorded()).toEqual(['sess-asker', 'sess-earlier', 'sess-tool']);
  });

  it('serves a session whose start found nothing cached its whole block on the next hook that can inject, once the helper has it', async () => {
    instructions('Served whole, later.');
    const tx = transcript('sess-late-block');
    const input = { session_id: 'sess-late-block', transcript_path: tx, cwd: process.cwd(), tool_name: 'Read', tool_input: { file_path: '/a' } };
    // Nothing cached: the Project line alone, which delivers no block. The helper this start kicks caches it.
    const start = await runHook('session-start', input, { helpers: 'run', fetch: rig.fetch, symbiont: 'cursor' });
    expect(contextOf(start.stdout)).not.toContain('Served whole, later.');
    expect(readSessionState(spool().dir, 'sess-late-block').delivered).not.toContain('cortex');
    const tool = () => runHook('post-tool-use', input, { helpers: 'run', fetch: rig.fetch, symbiont: 'cursor' });
    const first = contextOf((await tool()).stdout);
    expect(first).toContain(projectLine('proj_1'));
    expect(first).toContain('Served whole, later.');
    expect(readSessionState(spool().dir, 'sess-late-block').delivered).toContain('cortex');
    // Once.
    expect(contextOf((await tool()).stdout)).not.toContain('Served whole, later.');
  });

  it('serves a delegated agent its block once per delegation', async () => {
    instructions('Keep it small.');
    const tx = transcript('sess-sub');
    await runHook('session-start', { session_id: 'sess-sub', transcript_path: tx, cwd: process.cwd() }, { helpers: 'run', fetch: rig.fetch });
    const sub = (agentId: string) => runHook('subagent-start', { session_id: 'sess-sub', transcript_path: tx, agent_id: agentId, agent_type: 'Explore' }, { helpers: 'run', fetch: rig.fetch });
    // The first delegation is told its Project, and asks; the block it fetched serves the next.
    const first = contextOf((await sub('a1')).stdout);
    expect(first).toBe(projectLine('proj_1'));
    expect((await sub('a2')).stdout).toContain('Keep it small.');
    expect((await sub('a2')).stdout).toBe('');
  });
});

describe('the features a Deployment advertises', () => {
  it('emits turn events while an answer names them, none once an answer stops naming them, and keeps shipping transcripts', async () => {
    let advertising = true;
    const fetch: FetchLike = async (input, init) => {
      const res = await rig.fetch(new Request(input, init));
      if (advertising) return res;
      // A Deployment rolled back to before S1: its answers name no feature.
      const headers = new Headers(res.headers);
      headers.delete(FEATURES_HEADER);
      return new Response(await res.text(), { status: res.status, headers });
    };
    const tx = transcript('sess-f');
    const turns = () => (rig.env.sqlite.query(`SELECT COUNT(*) AS n FROM events WHERE kind = 'turn'`).get() as { n: number }).n;
    await runHook('session-start', { session_id: 'sess-f', transcript_path: tx, cwd: process.cwd() }, { helpers: 'run', fetch });
    expect(readProjectContext(spool().dir).features).toEqual(['turn', 'project-name', 'prompt-identity', 'prompt-scheme', 'tool-result-reason', 'launch-parent', 'context-tool-link', 'harness-health-v1', 'harness-deployment-activity-v1', 'harness-held-elsewhere-v1']);
    await runHook('user-prompt-submit', { session_id: 'sess-f', prompt: 'one', transcript_path: tx }, { helpers: 'run', fetch });
    await runHook('stop', { session_id: 'sess-f', last_assistant_message: 'done', transcript_path: tx }, { helpers: 'run', fetch });
    expect(turns()).toBe(2);

    advertising = false;
    // The first answer without the header drops the feature at once.
    await runHook('user-prompt-submit', { session_id: 'sess-f', prompt: 'two', transcript_path: tx }, { helpers: 'run', fetch });
    expect(readProjectContext(spool().dir).features).toEqual([]);
    const segmentsBefore = rig.rows('transcript_segments');
    fs.appendFileSync(tx, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'more' } })}\n`);
    await runHook('stop', { session_id: 'sess-f', last_assistant_message: 'done', transcript_path: tx }, { helpers: 'run', fetch });
    // The prompt above spooled one turn start (it ran before its own helper's answer); the Stop after emits none.
    expect(turns()).toBe(3);
    expect(rig.rows('transcript_segments')).toBeGreaterThan(segmentsBefore);
  });
});

describe('Deployment feature scope', () => {
  const serverUrl = 'https://member-test.invalid';
  function advertise(projectId: string, features: Array<'turn'>, at: number, url = serverUrl) {
    registerTestMember({ mycoHome, token: rig.token, projectId, serverUrl: url, root: path.join(mycoHome, projectId) });
    const project = new MemberSpool({ projectId, serverUrl: url }, { mycoHome });
    updateProjectContext(project.dir, mycoHome, (cache) => { cache.features = features; cache.featuresAt = at; });
  }
  it('uses the newest advertisement, isolates Deployments, and honors feature withdrawal', () => {
    advertise('proj_old', ['turn'], 1);
    advertise('proj_new', [], 2);
    advertise('proj_foreign', ['turn'], 3, 'https://other.invalid');
    const deployment = { serverUrl: `${serverUrl}/`, projectId: 'proj_1' };
    expect(readDeploymentFeatures(deployment, mycoHome)).toEqual([]);
    advertise('proj_new', ['turn'], 4);
    expect(readDeploymentFeatures(deployment, mycoHome)).toEqual(['turn']);
  });
  it('reads Deployment features for a pending join without deriving a spool from an empty project id', () => {
    const deployment = { serverUrl, projectId: '' };
    expect(readDeploymentFeatures(deployment, mycoHome)).toEqual([]);
    advertise('proj_new', ['turn'], 2);
    expect(readDeploymentFeatures(deployment, mycoHome)).toEqual(['turn']);
  });
  it('follows response order despite equal or backwards clocks and later context block writes', async () => {
    advertise('proj_1', [], 1);
    advertise('proj_new', ['turn'], 1);
    const other = new MemberSpool({ projectId: 'proj_new', serverUrl: 'https://member-test.invalid' }, { mycoHome });
    let at = 1;
    const answer = (features: string, spoolDir: string) => watchingFeatures(async () => Response.json({}, {
      headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: features },
    }), { serverUrl, spoolDir, mycoHome, now: () => at })(`${serverUrl}/context/session`);
    await answer('turn', spool().dir);
    await answer('', other.dir);
    updateProjectContext(spool().dir, mycoHome, (cache) => { cache.blocks.start = { context: 'block', at }; });
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual([]);
    at = 0;
    await answer('turn', other.dir);
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
    const unrelated = watchingFeatures(async () => Response.json({}, { headers: { [FEATURES_HEADER]: '' } }), { serverUrl, spoolDir: other.dir, mycoHome, now: () => at });
    await unrelated(`${serverUrl}/context/session`);
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
    expect(readDeploymentFeatures({ serverUrl: 'https://other.invalid', projectId: 'proj_foreign' }, mycoHome)).toEqual([]);
  });
  it.each(['corrupt JSON', 'version mismatch', 'unreadable path'])('%s does not block a hook-owned prompt and response', async damage => {
    advertise('proj_1', ['turn'], 1);
    advertise('proj_new', [], 2);
    const file = deploymentFeaturesPath(serverUrl, mycoHome);
    fs.rmSync(file, { force: true });
    if (damage === 'unreadable path') fs.mkdirSync(file);
    else fs.writeFileSync(file, damage === 'corrupt JSON' ? 'invalid' : JSON.stringify({ version: -1 }), { mode: 0o600 });
    const sessionId = 'feature-cache-capture';
    const raw = { trajectory_id: sessionId, tool_info: { user_prompt: 'save prompt', response: 'save response', transcript_path: transcript(sessionId) }, cwd: process.cwd() };
    const fetch = async () => Response.json({ persisted: true, context: '' });
    const prompt = await runHook('user-prompt-submit', raw, { fetch, symbiont: 'windsurf' });
    await runHook('stop', raw, { fetch, symbiont: 'windsurf' });
    expect(spool().readRecords(sessionId).map(record => record?.kind)).toEqual(expect.arrayContaining(['prompt', 'response']));
    expect(prompt.stderr).toContain('feature cache read failed');
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
  });
  it('logs a read failure once and falls back through the newest project to no features', () => {
    advertise('proj_new', ['turn'], 2);
    fs.writeFileSync(deploymentFeaturesPath(serverUrl, mycoHome), 'invalid', { mode: 0o600 });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const deployment = { serverUrl, projectId: 'proj_1' };
      expect(readDeploymentFeatures(deployment, mycoHome)).toEqual(['turn']);
      expect(readDeploymentFeatures(deployment, mycoHome)).toEqual(['turn']);
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(readDeploymentFeatures({ serverUrl: 'https://absent.invalid', projectId: '' }, mycoHome)).toEqual([]);
    } finally { stderr.mockRestore(); }
  });
  it('keeps the fallback project advertisement across repeated answers without a protocol header', async () => {
    advertise('proj_new', ['turn'], 2);
    const fetch = watchingFeatures(async () => Response.json({}), { serverUrl, spoolDir: spool().dir, mycoHome, now: () => 1 });
    for (let i = 0; i < 3; i++) {
      await fetch(serverUrl);
      expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
    }
  });
  it('prefers its own legacy advertisement over another project with no timestamp', () => {
    advertise('proj_1', ['turn'], 0);
    updateProjectContext(spool().dir, mycoHome, (cache) => { delete cache.featuresAt; });
    advertise('proj_new', [], 0);
    updateProjectContext(new MemberSpool({ projectId: 'proj_new', serverUrl: 'https://member-test.invalid' }, { mycoHome }).dir, mycoHome, (cache) => { delete cache.featuresAt; });
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
  });
  it('rejects a delayed older answer even when the newer answer leaves features unchanged', async () => {
    cacheDeploymentFeatures(serverUrl, [], mycoHome);
    let finishOld!: (response: Response) => void;
    const delayed = watchingFeatures(() => new Promise<Response>((resolve) => { finishOld = resolve; }), { serverUrl, spoolDir: spool().dir, mycoHome, now: () => 10 });
    const old = delayed(serverUrl);
    const newer = watchingFeatures(async () => Response.json({}, { headers: { [PROTOCOL_HEADER]: '1' } }), { serverUrl, spoolDir: spool().dir, mycoHome, now: () => -1 });
    await newer(serverUrl);
    finishOld(Response.json({}, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: 'turn' } }));
    await old;
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual([]);
    expect(readProjectContext(spool().dir).features).toEqual([]);
    expect(JSON.parse(fs.readFileSync(deploymentFeaturesPath(serverUrl, mycoHome), 'utf8')).receivedAt).toBeGreaterThan(0);
  });
  it('orders later answers by a published snapshot whose ordering stamp could not be persisted', async () => {
    cacheDeploymentFeatures(serverUrl, [], mycoHome);
    let finishOld!: (response: Response) => void;
    const opts = { serverUrl, spoolDir: spool().dir, mycoHome, now: () => 1 };
    const old = watchingFeatures(() => new Promise<Response>((resolve) => { finishOld = resolve; }), opts)(serverUrl);
    const fail = failing('renameSync', (from, to) => to === `${deploymentFeaturesPath(serverUrl, mycoHome)}.order` && JSON.parse(fs.readFileSync(from, 'utf8')).receivedAt > 1);
    try {
      const fetch = watchingFeatures(async () => Response.json({}, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: 'turn' } }), opts);
      expect((await fetch(serverUrl)).status).toBe(200);
    } finally { fail.mockRestore(); }
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
    finishOld(Response.json({}, { headers: { [PROTOCOL_HEADER]: '1' } }));
    await old;
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
    expect(readProjectContext(spool().dir).features).toEqual(['turn']);
  });
  it('keeps the accepted answer stamp when its project cache write fails', async () => {
    advertise('proj_1', [], 1);
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual([]);
    let finishOld!: (response: Response) => void;
    const delayed = watchingFeatures(() => new Promise<Response>((resolve) => { finishOld = resolve; }), { serverUrl, spoolDir: spool().dir, mycoHome, now: () => 1 });
    const old = delayed(serverUrl);
    const fail = failing('renameSync', (_from, to) => to === projectContextPath(spool().dir));
    try {
      const newer = watchingFeatures(async () => Response.json({}, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: 'turn' } }), { serverUrl, spoolDir: spool().dir, mycoHome, now: () => 2 });
      await newer(serverUrl);
    } finally { fail.mockRestore(); }
    finishOld(Response.json({}, { headers: { [PROTOCOL_HEADER]: '1' } }));
    await old;
    expect(readDeploymentFeatures({ serverUrl, projectId: 'proj_1' }, mycoHome)).toEqual(['turn']);
  });
  it('does not clear a cache failure when it ignores an older delayed answer', async () => {
    cacheDeploymentFeatures(serverUrl, [], mycoHome);
    let finishOld!: (response: Response) => void;
    const opts = { serverUrl, spoolDir: spool().dir, mycoHome, now: () => 1 };
    const delayed = watchingFeatures(() => new Promise<Response>((resolve) => { finishOld = resolve; }), opts);
    const old = delayed(serverUrl);
    const fail = failing('renameSync', (_from, to) => to === projectContextPath(spool().dir));
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const newer = watchingFeatures(async () => Response.json({}, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: 'turn' } }), opts);
    try {
      await newer(serverUrl);
      finishOld(Response.json({}, { headers: { [PROTOCOL_HEADER]: '1' } }));
      await old;
      await newer(serverUrl);
      expect(stderr).toHaveBeenCalledTimes(1);
    } finally { fail.mockRestore(); stderr.mockRestore(); }
  });
  it('records each accepted stamp in the snapshot, rewrites the project cache only on changes, and logs write failure once until recovery', async () => {
    advertise('proj_1', [], 1);
    let features = 'turn';
    const fetch = watchingFeatures(async () => Response.json({}, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: features } }), { serverUrl, spoolDir: spool().dir, mycoHome, now: () => 2 });
    const snapshot = deploymentFeaturesPath(serverUrl, mycoHome), project = projectContextPath(spool().dir);
    const stamp = () => JSON.parse(fs.readFileSync(snapshot, 'utf8')).receivedAt as number;
    await fetch(serverUrl);
    const first = { stamp: stamp(), project: fs.statSync(project).ino };
    await fetch(serverUrl);
    expect(stamp()).toBeGreaterThan(first.stamp);
    expect(fs.statSync(project).ino).toBe(first.project);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    let fail = failing('renameSync', (_from, to) => to === snapshot);
    features = '';
    try {
      expect((await fetch(serverUrl)).status).toBe(200); await fetch(serverUrl);
      expect(stderr).toHaveBeenCalledTimes(1);
      fail.mockRestore();
      await fetch(serverUrl);
      fail = failing('renameSync', (_from, to) => to.startsWith(mycoHome));
      await fetch(serverUrl);
      expect(stderr).toHaveBeenCalledTimes(2);
    } finally { fail.mockRestore(); stderr.mockRestore(); }
  });
  it('deduplicates filesystem failures despite changing temporary filenames', () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      featureCacheDiagnostic(serverUrl, mycoHome, 'write', Object.assign(new Error('rename snapshot.1.first.tmp failed'), { code: 'EACCES' }));
      featureCacheDiagnostic(serverUrl, mycoHome, 'write', Object.assign(new Error('rename snapshot.1.second.tmp failed'), { code: 'EACCES' }));
      expect(stderr).toHaveBeenCalledTimes(1);
      featureCacheDiagnostic(serverUrl, mycoHome, 'write', Object.assign(new Error('volume full'), { code: 'ENOSPC' }));
      expect(stderr).toHaveBeenCalledTimes(2);
      featureCacheDiagnostic(serverUrl, mycoHome, 'write');
      featureCacheDiagnostic(serverUrl, mycoHome, 'write', Object.assign(new Error('rename snapshot.1.third.tmp failed'), { code: 'EACCES' }));
      expect(stderr).toHaveBeenCalledTimes(3);
    } finally { stderr.mockRestore(); }
  });
  it('ships every session transcript in one backlog drain', async () => {
    for (const sessionId of ['sess-drain-a', 'sess-drain-b']) {
      const file = transcript(sessionId);
      spool().appendAndRecord(sessionId, [], (state) => { state.hookAt = 100; state.agent = 'claude-code'; state.transcript = transcriptPointerFor(file, 'machine_1')!; }, 100);
    }
    const report = await drainBacklog(spool(), new ServerClient({ serverUrl, projectId: 'proj_1', token: rig.token }, rig.fetch), deadlineBudget(Date.now() + 10_000), { machineId: 'machine_1' });
    expect(report.sessions.filter((session) => session.transcripts !== undefined)).toHaveLength(2);
  });
  for (const hook of ['user-prompt-submit', 'stop'] as const) {
    it(`${hook} emits turn events using another project's newest advertisement`, async () => {
      advertise('proj_old', [], 1);
      advertise('proj_new', ['turn'], 2);
      const sessionId = `sess-scope-${hook}`;
      const tx = transcript(sessionId);
      await runHook(hook, { session_id: sessionId, prompt: 'one', last_assistant_message: 'done', transcript_path: tx, cwd: process.cwd() }, { fetch: async () => Response.json({ persisted: true, context: '' }) });
      const events = spool().readRecords(sessionId);
      expect(events.some((event) => event?.kind === 'turn')).toBe(true);
      advertise('proj_new', [], 3);
      const withdrawn = `${sessionId}-withdrawn`;
      await runHook(hook, { session_id: withdrawn, prompt: 'two', last_assistant_message: 'done', transcript_path: tx, cwd: process.cwd() }, { fetch: async () => Response.json({ persisted: true, context: '' }) });
      expect(spool().readRecords(withdrawn).some((event) => event?.kind === 'turn')).toBe(false);
    });
  }
  it('releases transcript tails using another project and holds them after withdrawal', () => {
    advertise('proj_new', ['turn'], 2);
    const state = readSessionState(spool().dir, 'sess-tail');
    state.hookAt = 100;
    expect(holdsTranscriptTail(spool(), state, 101, serverUrl)).toBe(false);
    advertise('proj_new', [], 3);
    expect(holdsTranscriptTail(spool(), state, 101, serverUrl)).toBe(true);
  });
});

describe('prompts a harness writes only to its transcript', () => {
  it('publishes equal source submissions and their replies once through the Deployment', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agy-tx-'));
    scratch.push(dir);
    const tx = path.join(dir, 'transcript_full.jsonl');
    fs.writeFileSync(tx, '');
    const raw = { conversationId: 'sess-agy', transcriptPath: tx, cwd: process.cwd() };
    const options = { helpers: 'run' as const, fetch: rig.fetch, symbiont: 'antigravity' };
    await runHook('session-start', raw, options);
    expect(readSessionState(spool().dir, 'sess-agy').promptBackfill).toBeUndefined();
    fs.writeFileSync(tx, [
      { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>first turn</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'first reply' },
      { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>first turn</USER_REQUEST>' },
      { step_index: 3, type: 'PLANNER_RESPONSE', content: 'final reply' },
    ].map(record => JSON.stringify({ ...record, created_at: '2026-06-01T12:00:00Z' })).join('\n') + '\n');
    await runHook('stop', raw, options);
    await publishFixture(rig.env);
    const captured = await readFixtureRecords(rig.env.serverEnv, 'proj_1', 'sess-agy');
    const prompts = captured.filter(row => row.k === 'prompt');
    expect(prompts.map(row => row.text)).toEqual(['first turn', 'first turn']);
    expect(new Set(prompts.map(row => row.id)).size).toBe(2);
    const replies = captured.filter(row => row.k === 'reply');
    expect(replies.map(row => row.text).sort()).toEqual(['final reply', 'first reply']);
    expect(new Set(replies.map(row => row.prompt_id))).toEqual(new Set(prompts.map(row => row.id)));
    await runHook('stop', raw, options);
    await publishFixture(rig.env);
    expect(await readFixtureRecords(rig.env.serverEnv, 'proj_1', 'sess-agy')).toEqual(captured);
  });
});

it('the member helper ships a final retained plugin turn without another plugin callback', async () => {
  const { snippetModule } = await import('../support/plugin-snippet.js');
  const route = spool().routing!;
  const { prepareMemberTranscriptScope } = await import('@myco/member/transcript-routing.js');
  const key = prepareMemberTranscriptScope(route, mycoHome);
  const claim = path.join(mycoHome, 'member', 'claims', key, 'cline-final-inbox.lock');
  fs.mkdirSync(path.dirname(claim), { recursive: true });
  fs.writeFileSync(claim, `unverified-writer ${Date.now()}`, { mode: 0o600 });
  const wakes: Record<string, unknown>[] = [];
  const subject = snippetModule({ ...process.env, MYCO_HOME: mycoHome }, [], [], (_bin, args, options) => {
    if (args[1] === 'stop') wakes.push(JSON.parse((options as { input: string }).input));
    return { status: 0, stdout: '{}', stderr: '' };
  }, key, Date.now, fs, () => 0, 'cline');
  subject.MycoClinePlugin.setup({}, { session: { sessionId: 'final-inbox' }, workspaceInfo: { rootPath: process.cwd() } });
  const snapshot = { agentId: 'final-agent', conversationId: 'conv_final-inbox' };
  await subject.MycoClinePlugin.hooks.beforeModel({ snapshot, request: { messages: [{ id: 'source-1', role: 'user', content: [{ type: 'text', text: 'final prompt' }] }] } });
  await subject.MycoClinePlugin.hooks.afterModel({ snapshot, assistantMessage: { id: 'reply-1', content: [{ type: 'text', text: 'final reply' }] } });
  expect(wakes).toHaveLength(2);
  await runHook('stop', wakes.at(-1)!, { helpers: 'run', fetch: rig.fetch, symbiont: 'cline' });
  await publishFixture(rig.env);
  expect((await readFixtureRecords(rig.env.serverEnv, 'proj_1', 'final-inbox')).filter(row => row.k === 'prompt' || row.k === 'reply').map(row => row.text))
    .toEqual(['final prompt', 'final reply']);
});
