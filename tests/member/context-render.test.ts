/**
 * Context a hook serves from this machine alone (#1561 PR 3b): the member helper fetches what the hooks ask for, and
 * the next hook renders it.
 * - A prompt renders what the Deployment served the session's previous prompt; the helper asks with each prompt's own
 *   id and text.
 * - A session start renders the Project's start block once per session; a block the Project withdraws stops being
 *   served.
 * - A delegated agent renders the subagent block once per delegation.
 * - The features the Deployment advertises are read from every answer: a hook emits `turn` events while they are
 *   named, and stops the moment an answer no longer names them; the session's transcripts keep shipping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FEATURES_HEADER, PROTOCOL_HEADER } from '@goondocks/myco-shared/member-protocol';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { readProjectContext } from '@myco/member/context-cache.js';
import { projectLine } from '@goondocks/myco-shared/recall';
import { removeWhenTestsEnd } from '../support/remove-when-tests-end.ts';
import { ENV_JOIN_CODE } from '@myco/member/constants.js';
import { issueEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
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
  resetMachineIdCache();
  rig = await memberRig();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
});
/** Directories a test made, removed after it. */
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

const transcript = (id: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-render-tx-'));
  scratch.push(dir);
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  return file;
};
const spool = () => new MemberSpool('proj_1', { mycoHome });
/** The context a hook answered, whether its harness takes JSON or plain text. */
const contextOf = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string }; additionalContext?: string };
    return parsed.hookSpecificOutput?.additionalContext ?? parsed.additionalContext ?? stdout;
  } catch {
    return stdout.trim();
  }
};

/** The rig, with the prompt route answered by `serve`: what the Deployment would compose for a prompt. */
function servingPrompts(serve: (body: { promptId: string; text: string }) => string): { fetch: FetchLike; asked: Array<{ promptId: string; text: string }> } {
  const asked: Array<{ promptId: string; text: string }> = [];
  const fetch: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname === '/context/prompt') {
      const body = JSON.parse(await req.clone().text()) as { promptId: string; text: string };
      asked.push(body);
      return Response.json({ persisted: true, context: serve(body), skipped: [] }, { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: 'turn' } });
    }
    return rig.fetch(req);
  };
  return { fetch, asked };
}

describe('a prompt', () => {
  it('renders what was served for the session\'s previous prompt, and the helper asks with each prompt\'s own id and text', async () => {
    const tx = transcript('sess-p');
    const served = servingPrompts((body) => `Recalled for: ${body.text}`);
    const first = await runHook('user-prompt-submit', { session_id: 'sess-p', prompt: 'how do we rotate tokens?', transcript_path: tx }, { helpers: 'run', fetch: served.fetch, symbiont: 'copilot' });
    // Nothing cached yet: the Session line alone.
    expect(contextOf(first.stdout)).toBe('Session:: `sess-p`');
    expect(served.asked.map((a) => a.text)).toEqual(['how do we rotate tokens?']);
    expect(served.asked[0].promptId).toBe(readSessionState(spool().dir, 'sess-p').promptId!);

    const second = await runHook('user-prompt-submit', { session_id: 'sess-p', prompt: 'and the window?', transcript_path: tx }, { helpers: 'run', fetch: served.fetch, symbiont: 'copilot' });
    expect(contextOf(second.stdout)).toBe('Session:: `sess-p`\n\nRecalled for: how do we rotate tokens?');
    expect(served.asked.map((a) => a.text)).toEqual(['how do we rotate tokens?', 'and the window?']);
    // Every ask is answered and done.
    expect(readSessionState(spool().dir, 'sess-p').contextAsks).toBeUndefined();
  });

  it('renders each answer once: while the Deployment answers no newer one, the prompts after it are served the line alone', async () => {
    const tx = transcript('sess-once');
    const served = servingPrompts((body) => `Recalled for: ${body.text}`);
    await runHook('user-prompt-submit', { session_id: 'sess-once', prompt: 'first', transcript_path: tx }, { helpers: 'run', fetch: served.fetch, symbiont: 'copilot' });
    const offline: FetchLike = async () => { throw new TypeError('fetch failed'); };
    const second = await runHook('user-prompt-submit', { session_id: 'sess-once', prompt: 'second', transcript_path: tx }, { helpers: 'run', fetch: offline, symbiont: 'copilot' });
    expect(contextOf(second.stdout)).toBe('Session:: `sess-once`\n\nRecalled for: first');
    const third = await runHook('user-prompt-submit', { session_id: 'sess-once', prompt: 'third', transcript_path: tx }, { helpers: 'run', fetch: offline, symbiont: 'copilot' });
    expect(contextOf(third.stdout)).toBe('Session:: `sess-once`');
  });

  it('keeps an ask the Deployment did not answer for the next pass', async () => {
    const tx = transcript('sess-q');
    const offline: FetchLike = async () => { throw new TypeError('fetch failed'); };
    await runHook('user-prompt-submit', { session_id: 'sess-q', prompt: 'while offline', transcript_path: tx }, { helpers: 'run', fetch: offline, symbiont: 'copilot' });
    expect(readSessionState(spool().dir, 'sess-q').contextAsks?.map((a) => a.kind)).toEqual(['prompt']);
    const served = servingPrompts((body) => `Recalled for: ${body.text}`);
    await runHook('stop', { session_id: 'sess-q', last_assistant_message: 'ok', transcript_path: tx }, { helpers: 'run', fetch: served.fetch, symbiont: 'copilot' });
    expect(served.asked.map((a) => a.text)).toEqual(['while offline']);
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
    resetMachineIdCache();
    const issued = await issueEnrollmentAuthority(rig.env.db, Date.now(), { role: 'member', projectId: 'proj_1' });
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
    expect(readProjectContext(spool().dir).features).toEqual(['turn']);
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

describe('prompts a harness writes only to its transcript', () => {
  it('are read by the helper after the invocation\'s hook, each once, stamped with the invocation\'s time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-agy-tx-'));
    scratch.push(dir);
    const tx = path.join(dir, 'transcript_full.jsonl');
    // The invocation's hook fires before the IDE writes its transcript.
    fs.writeFileSync(tx, '');
    const invoke = () => runHook('session-start', { conversationId: 'sess-agy', transcriptPath: tx, cwd: process.cwd() }, { helpers: 'run', fetch: rig.fetch, symbiont: 'antigravity' });
    const startedAt = Date.now();
    await invoke();
    expect(rig.rows('prompt_batches')).toBe(0);
    // The request waits for the next pass.
    expect(readSessionState(spool().dir, 'sess-agy').promptBackfill?.transcriptPath).toBe(tx);

    fs.writeFileSync(tx, [
      { step_index: 0, type: 'USER_INPUT', content: '<USER_REQUEST>first turn</USER_REQUEST>', created_at: 't1' },
      { step_index: 1, type: 'PLANNER_RESPONSE', content: 'thinking', created_at: 't2' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    await invoke();
    const rows = rig.env.sqlite.query(`SELECT text FROM prompt_batches`).all() as Array<{ text: string }>;
    expect(rows.map((r) => r.text)).toEqual(['first turn']);
    const createdAt = (rig.env.sqlite.query(`SELECT created_at AS at FROM events WHERE kind = 'prompt'`).get() as { at: number }).at;
    expect(createdAt).toBeGreaterThanOrEqual(startedAt);
    expect(readSessionState(spool().dir, 'sess-agy').promptBackfill).toBeUndefined();

    // A later invocation reads the transcript again and captures only what is new.
    fs.appendFileSync(tx, `${JSON.stringify({ step_index: 2, type: 'USER_INPUT', content: '<USER_REQUEST>second turn</USER_REQUEST>', created_at: 't3' })}\n`);
    await invoke();
    expect((rig.env.sqlite.query(`SELECT text FROM prompt_batches ORDER BY text`).all() as Array<{ text: string }>).map((r) => r.text)).toEqual(['first turn', 'second turn']);
  });
});
