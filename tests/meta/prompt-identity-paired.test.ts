/**
 * One prompt, one id, from the hook to the session page, for every agent whose hook and transcript share a prompt's
 * identity (`promptIdentity.kind` `harness-key` or `stamped`).
 *
 * Each case drives the real hooks with the input its harness sends, carrying the key, against the in-process
 * Deployment, which serves real spores; then the paired transcript is parsed, and the turn is read as the dashboard
 * reads it. Two prompts run: the first prompt's text selects the context, and the second prompt carries it to the
 * agent. The receipt and the answer name the first, their delivery names the second, and the second is where the turn
 * view shows what Myco added. Tool calls and replies sit on their own prompts. Cross-package, so it lives here.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { promptIdFor } from '@myco-server-worker/ingest/parsers/index.js';
import { canonicalPromptId } from '@goondocks/myco-shared/prompt-identity';
import { deriveId } from '@myco/member/envelope.js';
import { documentTurnDetail } from '@myco-server-worker/content/session-turns.js';
import { TEST_PROJECT_ID } from '../member/helpers/server.js';
import { runHook } from '../member/helpers/hooks.js';
import { identityRig, RELEVANT_WORD, type IdentityRig } from './helpers/prompt-identity-rig.js';

const savedHome = process.env.MYCO_HOME;
afterEach(() => { process.env.MYCO_HOME = savedHome; resetMachineIdCache(); });

const FIRST = `How long does the ${RELEVANT_WORD} window keep records?`;
const SECOND = `And does the ${RELEVANT_WORD} window cover plans too?`;
const SCOPE = { projectId: TEST_PROJECT_ID };

/** What every case asserts once the hooks ran and the transcript was parsed: selection, delivery, and where the turn view puts them. */
async function assertSelectedThenDelivered(r: IdentityRig, sessionId: string, first: string, second: string): Promise<void> {
  const receipts = r.rows(`SELECT prompt_id, ask_protocol, asked_at, delivered_prompt_id, delivered_scope_reason, spore_ids FROM spore_injections WHERE session_id = ?`, sessionId);
  expect(receipts.length).toBe(1);
  expect(JSON.parse(receipts[0]!.spore_ids as string).length).toBeGreaterThan(0);
  expect(receipts[0]).toMatchObject({ prompt_id: first, ask_protocol: 'v1', delivered_prompt_id: second, delivered_scope_reason: null });
  expect(typeof receipts[0]!.asked_at).toBe('number');
  const answers = r.rows(`SELECT prompt_id, outcome, delivered_prompt_id FROM prompt_context_answers WHERE session_id = ? ORDER BY created_at, rowid`, sessionId);
  expect(answers.length).toBeGreaterThanOrEqual(2);
  expect(answers[0]).toMatchObject({ prompt_id: first, outcome: 'served', delivered_prompt_id: second });
  expect(answers[1]).toMatchObject({ prompt_id: second });
  const prompts = r.rows(`SELECT prompt_id FROM prompt_batches WHERE session_id = ? ORDER BY created_at`, sessionId).map((p) => p.prompt_id);
  expect(prompts).toEqual([first, second]);
  const env = r.rig.env.serverEnv;
  expect((await documentTurnDetail(env, SCOPE, sessionId, first))?.injection).toBeNull();
  const delivered = await documentTurnDetail(env, SCOPE, sessionId, second);
  expect(delivered?.injection?.spores.length).toBeGreaterThan(0);
  expect(r.rows(`SELECT prompt_id, tool_name FROM tool_calls WHERE session_id = ?`, sessionId)).toEqual([{ prompt_id: first, tool_name: expect.any(String) }]);
  expect(r.rows(`SELECT prompt_id FROM responses WHERE session_id = ? ORDER BY created_at`, sessionId).map((p) => p.prompt_id)).toEqual([first, second]);

}

const lines = (records: readonly Record<string, unknown>[]): string => records.map((o) => `${JSON.stringify(o)}\n`).join('');

/** Each paired agent and the case that pairs it; a declaration that shares an id with no case here fails below. */
const PAIRED: Record<string, (r: IdentityRig) => Promise<void>> = {
  'claude-code': async (r) => {
    const sessionId = 's-identity-claude';
    const [k1, k2] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-identity-claude-'));
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '');
    const common = { session_id: sessionId, transcript_path: file, cwd: '/repo' };
    const hook = { helpers: 'run' as const, fetch: r.fetch.fetch };
    await runHook('session-start', { ...common, hook_event_name: 'SessionStart' }, hook);
    await runHook('user-prompt-submit', { ...common, hook_event_name: 'UserPromptSubmit', prompt: FIRST, prompt_id: k1 }, hook);
    const second = await runHook('user-prompt-submit', { ...common, hook_event_name: 'UserPromptSubmit', prompt: SECOND, prompt_id: k2 }, hook);
    expect(second.stdout).toContain(`${RELEVANT_WORD} window keeps thirty days`);
    // The agent writes its transcript as the turns run: after each ask and delivery, on the same clock.
    const written = Date.now();
    const at = (s: number) => new Date(written + s * 1000).toISOString();
    fs.writeFileSync(file, lines([
      { type: 'user', promptId: k1, message: { content: FIRST }, uuid: 'u1', timestamp: at(1), sessionId },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the setting.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/retention.ts' } }] }, uuid: 'a1', timestamp: at(2), sessionId },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'thirty days' }] }, uuid: 'r1', timestamp: at(3), sessionId },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Thirty days.' }], stop_reason: 'end_turn' }, uuid: 'a2', timestamp: at(4), sessionId },
      { type: 'user', promptId: k2, message: { content: SECOND }, uuid: 'u2', timestamp: at(5), sessionId },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Plans are kept until archived.' }], stop_reason: 'end_turn' }, uuid: 'a3', timestamp: at(6), sessionId },
    ]));
    await runHook('stop', { ...common, hook_event_name: 'Stop', last_assistant_message: 'Plans are kept until archived.' }, hook);
    await runHook('session-end', { ...common, hook_event_name: 'SessionEnd' }, hook);
    await r.parse();
    await assertSelectedThenDelivered(r, sessionId, await promptIdFor(sessionId, 'user_prompt', k1), await promptIdFor(sessionId, 'user_prompt', k2));
  },
  codex: async (r) => {
    // The hook input Codex sends (`tests/fixtures/prompt-identity/codex-user-prompt-submit.json`), with its turn key.
    const observed = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '..', 'fixtures', 'prompt-identity', 'codex-user-prompt-submit.json'), 'utf8')) as Record<string, unknown>;
    const sessionId = observed.session_id as string;
    const [t1, t2] = [observed.turn_id as string, '01a150c5-7000-7071-a239-ca91304db9d8'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-identity-codex-'));
    const file = path.join(dir, `rollout-2026-10-18T16-47-57-${sessionId}.jsonl`);
    const meta = { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: sessionId, source: 'cli', cwd: '/repo', cli_version: '0.163.0' } };
    fs.writeFileSync(file, lines([meta]));
    const common = { session_id: sessionId, transcript_path: file, cwd: '/repo' };
    const hook = { helpers: 'run' as const, fetch: r.fetch.fetch, symbiont: 'codex' };
    await runHook('session-start', { ...common, hook_event_name: 'SessionStart', source: 'startup' }, hook);
    await runHook('user-prompt-submit', { ...observed, ...common, turn_id: t1, prompt: FIRST }, hook);
    // A tool the rollout does not record reaches the Deployment from the hook, named by the turn's opener.
    await runHook('post-tool-use', { ...common, hook_event_name: 'PostToolUse', turn_id: t1, tool_name: 'web_search', tool_use_id: 'call_ws_1',
      tool_input: { query: 'retention window' }, tool_response: 'thirty days' }, hook);
    const second = await runHook('user-prompt-submit', { ...observed, ...common, turn_id: t2, prompt: SECOND }, hook);
    expect(second.stdout).toContain(`${RELEVANT_WORD} window keeps thirty days`);
    // Codex writes its rollout as the turns run: after each ask and delivery, on the same clock, and before the parse
    // reads it, which takes no line's time past its own.
    const written = Date.now();
    const at = (ms: number) => new Date(written + ms).toISOString();
    const item = (s: number, payload: Record<string, unknown>, order?: number) => ({ timestamp: at(s), type: 'response_item', payload, ...(order === undefined ? {} : { metadata: { user_input_order: order } }) });
    const message = (role: string, text: string) => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] });
    fs.writeFileSync(file, lines([
      meta,
      { timestamp: at(1), type: 'event_msg', payload: { type: 'task_started', turn_id: t1 } },
      { timestamp: at(1), type: 'turn_context', payload: { turn_id: t1, cwd: '/repo' } },
      item(1, message('user', FIRST), 0),
      item(2, message('assistant', 'Thirty days.'), 1),
      { timestamp: at(3), type: 'event_msg', payload: { type: 'task_started', turn_id: t2 } },
      { timestamp: at(3), type: 'turn_context', payload: { turn_id: t2, cwd: '/repo' } },
      item(4, message('user', SECOND), 2),
      item(5, message('assistant', 'Plans are kept until archived.'), 3),
    ]));
    await runHook('stop', { ...common, hook_event_name: 'Stop', turn_id: t2, last_assistant_message: 'Plans are kept until archived.' }, hook);
    await runHook('session-end', { ...common, hook_event_name: 'SessionEnd' }, hook);
    await r.parse();
    const opener = (turnId: string) => canonicalPromptId(deriveId, { scheme: 'codex-turn-v1', sessionId, turnId, submission: { opener: true } });
    expect(r.rows(`SELECT prompt_identity_scheme FROM transcripts WHERE session_id = ?`, sessionId)).toEqual([{ prompt_identity_scheme: 'codex-turn-v1' }]);
    await assertSelectedThenDelivered(r, sessionId, opener(t1), opener(t2));
  },
  opencode: (r) => stampedCase(r, 'opencode', { session: (id) => ({ session_id: id }) }),
  cline: (r) => stampedCase(r, 'cline', { session: (id) => ({ conversationId: id }) }),
};

/**
 * A plugin-written transcript: the plugin passes the prompt to the hook, takes the id its answer returns, and stamps
 * that id on the lines of the turn it writes.
 */
async function stampedCase(r: IdentityRig, agent: string, harness: { session: (id: string) => Record<string, unknown> }): Promise<void> {
  const sessionId = `ses-identity-${agent}`;
  const hook = { helpers: 'run' as const, fetch: r.fetch.fetch, symbiont: agent };
  const common = { ...harness.session(sessionId), cwd: '/repo' };
  await runHook('session-start', common, hook);
  const promptIdOf = (stdout: string): string => {
    const answer = JSON.parse(stdout) as { promptId?: unknown };
    if (typeof answer.promptId !== 'string') throw new Error(`the ${agent} hook returned no prompt id: ${stdout}`);
    return answer.promptId;
  };
  const first = promptIdOf((await runHook('user-prompt-submit', { ...common, prompt: FIRST }, hook)).stdout);
  const secondRun = await runHook('user-prompt-submit', { ...common, prompt: SECOND }, hook);
  expect(secondRun.stdout).toContain(`${RELEVANT_WORD} window keeps thirty days`);
  const second = promptIdOf(secondRun.stdout);
  // The plugin writes its transcript as the turns run: after each ask and delivery, on the same clock.
  const written = Date.now();
  const at = (s: number) => new Date(written + s * 1000).toISOString();
  await r.storeTranscript({
    transcriptId: `tx_${(agent === 'cline' ? 'c' : 'd').repeat(32)}`, sessionId, agent, text: lines([
      { v: 1, type: 'session', sessionId, agent, cwd: '/repo', at: at(0) },
      { v: 1, type: 'prompt', sessionId, promptId: first, text: FIRST, origin: 'human', at: at(1) },
      { v: 1, type: 'tool', sessionId, promptId: first, name: 'read', input: { filePath: 'retention.ts' }, output: 'thirty days', failed: false, at: at(2) },
      { v: 1, type: 'response', sessionId, promptId: first, text: 'Thirty days.', at: at(3) },
      { v: 1, type: 'prompt', sessionId, promptId: second, text: SECOND, origin: 'human', at: at(4) },
      { v: 1, type: 'response', sessionId, promptId: second, text: 'Plans are kept until archived.', at: at(5) },
    ]),
  });
  await r.parse();
  await assertSelectedThenDelivered(r, sessionId, first, second);
}

describe('one prompt identity, hook to session page', () => {
  it('pairs every agent whose hook and transcript share a prompt id, and only those', () => {
    const shared = Object.entries(HOOK_CONFIG).filter(([, entry]) => entry.promptIdentity.kind === 'harness-key' || entry.promptIdentity.kind === 'stamped').map(([agent]) => agent).sort();
    expect(Object.keys(PAIRED).sort()).toEqual(shared);
  });

  for (const [agent, run] of Object.entries(PAIRED)) {
    it(`${agent}: the receipt and the answer name the prompt that selected them, and their delivery the prompt that carried them`, async () => {
      await run(await identityRig());
    });
  }
});
