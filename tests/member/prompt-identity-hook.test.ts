/**
 * The prompt hook names each submission by its agent's declared identity, behind the Deployment's `prompt-identity`
 * feature, and reports where a rendered answer reached the agent.
 * - Claude Code: the hook's `prompt_id` derives the id the transcript's parse derives; a submission without one names
 *   no prompt and is asked about session-scoped (`absent_key`), never under a minted id.
 * - A Deployment that does not name the feature is asked as before: a minted id and no identity marker.
 * - Each answer renders once, keyed on the ask it answered, so a harness that reuses a prompt id still gets each answer.
 * - The hook that renders an answer emits `context.delivered` naming the rows the answer named, in the same append.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FEATURES_HEADER, PROTOCOL_HEADER } from '@goondocks/myco-shared/member-protocol';
import { CONTEXT_DELIVERED_KIND } from '@goondocks/myco-shared/prompt-identity';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { promptIdFor } from '@myco-server-worker/ingest/parsers/index.js';
import type { FetchLike } from '@myco/member/transport.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';
import { registerTestMember, runHook } from './helpers/hooks.js';

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
afterEach(() => { process.env.MYCO_HOME = savedHome; resetMachineIdCache(); });

type Ask = { promptId?: string; scopeReason?: string; identity?: number; at?: number; text: string };

/**
 * The rig, with the prompt route answered by a Deployment that names `features` and writes the rows it names: every
 * other route reaches the rig's own worker, which delivers the hooks' events.
 */
function serving(features: string, rows: (n: number) => { receiptId?: string; answerId?: string } = (n) => ({ receiptId: `00000000-0000-4000-8000-00000000000${n}`, answerId: `00000000-0000-4000-8000-0000000000a${n}` })) {
  const asked: Ask[] = [];
  const fetch: FetchLike = async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).pathname !== '/context/prompt') return rig.fetch(req);
    const body = JSON.parse(await req.clone().text()) as Ask;
    asked.push(body);
    return Response.json({ persisted: true, context: `Recalled for: ${body.text}`, skipped: [], ...rows(asked.length) },
      { headers: { [PROTOCOL_HEADER]: '1', [FEATURES_HEADER]: features } });
  };
  return { fetch, asked };
}

const transcript = (id: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-identity-hook-'));
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } })}\n`);
  return file;
};
const delivered = (sessionId: string) => (rig.env.sqlite.query(`SELECT payload FROM events WHERE session_id = ? AND kind = ? ORDER BY received_at, rowid`)
  .all(sessionId, CONTEXT_DELIVERED_KIND) as { payload: string }[]).map((r) => JSON.parse(r.payload) as Record<string, unknown>);

describe('a Claude Code prompt under prompt-identity', () => {
  const features = 'turn,project-name,prompt-identity';

  it('asks with the id the transcript derives, and reports the answer delivered to the next prompt under its own id', async () => {
    const sessionId = 'sess-identity';
    const tx = transcript(sessionId);
    const served = serving(features);
    // A session start learns the Deployment's features before the first prompt.
    await runHook('session-start', { session_id: sessionId, transcript_path: tx, hook_event_name: 'SessionStart' }, { helpers: 'run', fetch: served.fetch });
    const k1 = '11111111-1111-4111-8111-111111111111';
    const k2 = '22222222-2222-4222-8222-222222222222';
    await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'first prompt text', prompt_id: k1 }, { helpers: 'run', fetch: served.fetch });
    const second = await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'second prompt text', prompt_id: k2 }, { helpers: 'run', fetch: served.fetch });
    expect(second.stdout).toContain('Recalled for: first prompt text');
    expect(served.asked.map(({ promptId, identity, scopeReason, at }) => ({ promptId, identity, scopeReason, dated: typeof at === 'number' }))).toEqual([
      { promptId: await promptIdFor(sessionId, 'user_prompt', k1), identity: 1, scopeReason: undefined, dated: true },
      { promptId: await promptIdFor(sessionId, 'user_prompt', k2), identity: 1, scopeReason: undefined, dated: true },
    ]);
    expect(delivered(sessionId)).toEqual([{
      receiptId: '00000000-0000-4000-8000-000000000001', answerId: '00000000-0000-4000-8000-0000000000a1',
      renderedIn: await promptIdFor(sessionId, 'user_prompt', k2),
    }]);
  });

  it('names no prompt for a submission without a key, and reports a delivery to it with the reason', async () => {
    const sessionId = 'sess-absent';
    const tx = transcript(sessionId);
    const served = serving(features);
    await runHook('session-start', { session_id: sessionId, transcript_path: tx, hook_event_name: 'SessionStart' }, { helpers: 'run', fetch: served.fetch });
    await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'first prompt text' }, { helpers: 'run', fetch: served.fetch });
    await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'second prompt text' }, { helpers: 'run', fetch: served.fetch });
    expect(served.asked.map(({ promptId, identity, scopeReason }) => ({ promptId, identity, scopeReason }))).toEqual([
      { promptId: undefined, identity: 1, scopeReason: 'absent_key' },
      { promptId: undefined, identity: 1, scopeReason: 'absent_key' },
    ]);
    expect(delivered(sessionId)).toEqual([{
      receiptId: '00000000-0000-4000-8000-000000000001', answerId: '00000000-0000-4000-8000-0000000000a1', renderedScopeReason: 'absent_key',
    }]);
  });

  it('renders each answer once by the ask it answered, even when the harness reuses a prompt id', async () => {
    const sessionId = 'sess-reused';
    const tx = transcript(sessionId);
    const served = serving(features);
    await runHook('session-start', { session_id: sessionId, transcript_path: tx, hook_event_name: 'SessionStart' }, { helpers: 'run', fetch: served.fetch });
    const reused = '33333333-3333-4333-8333-333333333333';
    await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'first', prompt_id: reused }, { helpers: 'run', fetch: served.fetch });
    const second = await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'second', prompt_id: reused }, { helpers: 'run', fetch: served.fetch });
    const third = await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'third', prompt_id: reused }, { helpers: 'run', fetch: served.fetch });
    expect(second.stdout).toContain('Recalled for: first');
    expect(third.stdout).toContain('Recalled for: second');
    expect(delivered(sessionId).map((d) => d.answerId)).toEqual(['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2']);
  });

  it('reports nothing for an answer that names no row', async () => {
    const sessionId = 'sess-unnamed';
    const tx = transcript(sessionId);
    const served = serving(features, () => ({}));
    await runHook('session-start', { session_id: sessionId, transcript_path: tx, hook_event_name: 'SessionStart' }, { helpers: 'run', fetch: served.fetch });
    await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'first', prompt_id: '44444444-4444-4444-8444-444444444444' }, { helpers: 'run', fetch: served.fetch });
    const second = await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'second', prompt_id: '55555555-5555-4555-8555-555555555555' }, { helpers: 'run', fetch: served.fetch });
    expect(second.stdout).toContain('Recalled for: first');
    expect(delivered(sessionId)).toEqual([]);
  });
});

describe('a Claude Code prompt to a Deployment without prompt-identity', () => {
  it('is asked under a minted id with no identity marker, and reports no delivery', async () => {
    const sessionId = 'sess-legacy';
    const tx = transcript(sessionId);
    const served = serving('turn,project-name');
    const legacy: FetchLike = async (input, init) => {
      const res = await served.fetch(input, init);
      const headers = new Headers(res.headers);
      if (headers.has(FEATURES_HEADER)) headers.set(FEATURES_HEADER, 'turn,project-name');
      return new Response(res.body, { status: res.status, headers });
    };
    await runHook('session-start', { session_id: sessionId, transcript_path: tx, hook_event_name: 'SessionStart' }, { helpers: 'run', fetch: legacy });
    await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'first', prompt_id: '66666666-6666-4666-8666-666666666666' }, { helpers: 'run', fetch: legacy });
    await runHook('user-prompt-submit', { session_id: sessionId, transcript_path: tx, prompt: 'second', prompt_id: '77777777-7777-4777-8777-777777777777' }, { helpers: 'run', fetch: legacy });
    expect(served.asked.map((a) => ({ identity: a.identity, v7: /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(a.promptId ?? '') }))).toEqual([{ identity: undefined, v7: true }, { identity: undefined, v7: true }]);
    expect(delivered(sessionId)).toEqual([]);
  });
});
