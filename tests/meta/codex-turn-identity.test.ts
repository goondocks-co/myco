/**
 * A Codex turn key names a turn, of which only the opener is one submission (`codex-turn-v1`).
 * - The first prompt hook of a turn claims the opener's id, and the parse names the turn's first person's prompt by
 *   the same id; a later prompt of the turn steers it, is session-scoped, and its row is named by its acceptance order.
 * - When the opener's hook never ran, the first steering hook claims the opener: the receipt resolves, and the prompt
 *   key mismatch signal counts it.
 * - When another hook blocked the opener, no opener row exists, and the invariant reports the receipt dangling.
 * Cross-package (member hooks and the Deployment's parse), so it lives here.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalPromptId, type TurnSubmission } from '@goondocks/myco-shared/prompt-identity';
import { deriveId } from '@myco/member/envelope.js';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { danglingPromptReferences, promptKeyMismatches } from '@myco-server-worker/read/prompt-reference-invariant.js';
import { runHook } from '../member/helpers/hooks.js';
import { identityRig, RELEVANT_WORD, type IdentityRig } from './helpers/prompt-identity-rig.js';

const savedHome = process.env.MYCO_HOME;
afterEach(() => { process.env.MYCO_HOME = savedHome; resetMachineIdCache(); });

const FIRST = `How long does the ${RELEVANT_WORD} window keep records?`;
const STEER = `Only the ${RELEVANT_WORD} window for plans, please.`;
const SECOND = `Does the ${RELEVANT_WORD} window cover attachments?`;
const lines = (records: readonly Record<string, unknown>[]): string => records.map((o) => `${JSON.stringify(o)}\n`).join('');

/** A Codex session driven through its real hooks, with the rollout its turns write. */
async function codexSession(r: IdentityRig, sessionId: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-codex-turn-'));
  const file = path.join(dir, `rollout-2026-10-18T16-47-57-${sessionId}.jsonl`);
  const meta = { timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: sessionId, source: 'cli', cwd: '/repo' } };
  fs.writeFileSync(file, lines([meta]));
  const common = { session_id: sessionId, transcript_path: file, cwd: '/repo' };
  const hook = { helpers: 'run' as const, fetch: r.fetch.fetch, symbiont: 'codex' };
  await runHook('session-start', { ...common, hook_event_name: 'SessionStart', source: 'startup' }, hook);
  const id = (turnId: string, submission: TurnSubmission) => canonicalPromptId(deriveId, { scheme: 'codex-turn-v1', sessionId, turnId, submission });
  return {
    id,
    prompt: (turnId: string, prompt: string) => runHook('user-prompt-submit', { ...common, hook_event_name: 'UserPromptSubmit', turn_id: turnId, prompt }, hook),
    /** Write the rollout its turns ran, after every hook, then end the session and parse it. */
    async finish(turns: ReadonlyArray<{ turnId: string; items: ReadonlyArray<{ role: 'user' | 'assistant'; text: string; order?: number }> }>) {
      const written = Date.now();
      let ms = 0;
      const at = () => new Date(written + (ms += 1)).toISOString();
      fs.writeFileSync(file, lines([meta, ...turns.flatMap(({ turnId, items }) => [
        { timestamp: at(), type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
        { timestamp: at(), type: 'turn_context', payload: { turn_id: turnId, cwd: '/repo' } },
        ...items.map(({ role, text, order }) => ({ timestamp: at(), type: 'response_item',
          payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
          ...(order === undefined ? {} : { metadata: { user_input_order: order } }) })),
      ])]));
      await runHook('stop', { ...common, hook_event_name: 'Stop', last_assistant_message: 'done' }, hook);
      await runHook('session-end', { ...common, hook_event_name: 'SessionEnd' }, hook);
      await r.parse();
    },
  };
}

describe('a Codex turn', () => {
  it('names its opener by the turn and a steering prompt by its acceptance order, and scopes the steering ask', async () => {
    const r = await identityRig();
    const sessionId = '01a150c5-6b8f-7f61-acf3-4c7ea2c29491';
    const s = await codexSession(r, sessionId);
    await s.prompt('t1', FIRST);
    await s.prompt('t1', STEER);
    await s.prompt('t2', SECOND);
    await s.finish([
      { turnId: 't1', items: [
        { role: 'user', text: '<environment_context>cwd: /repo</environment_context>' },
        { role: 'user', text: FIRST, order: 0 }, { role: 'assistant', text: 'Thirty days.', order: 1 },
        { role: 'user', text: STEER, order: 2 }, { role: 'assistant', text: 'Plans too.', order: 3 },
      ] },
      { turnId: 't2', items: [{ role: 'user', text: SECOND, order: 4 }, { role: 'assistant', text: 'No.', order: 5 }] },
    ]);
    const opener1 = s.id('t1', { opener: true });
    const steering = s.id('t1', { order: 2 });
    const opener2 = s.id('t2', { opener: true });
    expect(r.rows(`SELECT prompt_id, origin FROM prompt_batches WHERE session_id = ? AND origin = 'user' ORDER BY created_at`, sessionId))
      .toEqual([{ prompt_id: opener1, origin: 'user' }, { prompt_id: steering, origin: 'user' }, { prompt_id: opener2, origin: 'user' }]);
    expect(r.rows(`SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id = ? AND origin = 'system'`, sessionId)).toEqual([{ n: 1 }]);
    expect(r.rows(`SELECT prompt_id, scope_reason FROM prompt_context_answers WHERE session_id = ? ORDER BY created_at, rowid`, sessionId)).toEqual([
      { prompt_id: opener1, scope_reason: null }, { prompt_id: null, scope_reason: 'steering' }, { prompt_id: opener2, scope_reason: null },
    ]);
    expect(r.rows(`SELECT r.prompt_id, p.text FROM responses r JOIN prompt_batches p ON p.prompt_id = r.prompt_id WHERE r.session_id = ? ORDER BY r.created_at`, sessionId)
      .map((row) => row.text)).toEqual([FIRST, STEER, SECOND]);
    expect(await danglingPromptReferences(r.rig.env.db, 0)).toEqual({ receipt_selected: 0, answer_selected: 0, receipt_delivered: 0, answer_delivered: 0 });
    expect(await promptKeyMismatches(r.rig.env.db, 0)).toEqual({});
  });

  it('gives the opener to the first steering hook when the opener\'s hook never ran, and the mismatch signal counts it', async () => {
    const r = await identityRig();
    const sessionId = '01a150c5-6b8f-7f61-acf3-4c7ea2c29492';
    const s = await codexSession(r, sessionId);
    await s.prompt('t1', STEER);
    await s.finish([{ turnId: 't1', items: [
      { role: 'user', text: FIRST, order: 0 }, { role: 'assistant', text: 'Thirty days.', order: 1 },
      { role: 'user', text: STEER, order: 2 }, { role: 'assistant', text: 'Plans too.', order: 3 },
    ] }]);
    expect(r.rows(`SELECT prompt_id FROM spore_injections WHERE session_id = ?`, sessionId)).toEqual([{ prompt_id: s.id('t1', { opener: true }) }]);
    expect(await danglingPromptReferences(r.rig.env.db, 0)).toMatchObject({ receipt_selected: 0, answer_selected: 0 });
    expect(await promptKeyMismatches(r.rig.env.db, 0)).toEqual({ codex: 1 });
  });

  it('holds no opener row when another hook blocked the opener, and the invariant reports the receipt', async () => {
    const r = await identityRig();
    const sessionId = '01a150c5-6b8f-7f61-acf3-4c7ea2c29493';
    const s = await codexSession(r, sessionId);
    await s.prompt('t1', FIRST);
    await s.finish([{ turnId: 't1', items: [] }, { turnId: 't2', items: [{ role: 'user', text: SECOND, order: 1 }, { role: 'assistant', text: 'No.', order: 2 }] }]);
    expect(r.rows(`SELECT prompt_id FROM spore_injections WHERE session_id = ?`, sessionId)).toEqual([{ prompt_id: s.id('t1', { opener: true }) }]);
    expect(r.rows(`SELECT prompt_id FROM prompt_batches WHERE session_id = ?`, sessionId)).toEqual([{ prompt_id: s.id('t2', { opener: true }) }]);
    expect(await danglingPromptReferences(r.rig.env.db, 0)).toMatchObject({ receipt_selected: 1, answer_selected: 1 });
  });
});
