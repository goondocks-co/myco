/**
 * What the parse records for prompt identity: a stamped transcript's lines name the prompt their own stamp names,
 * and the parse cursor records the latest dated line it read, on the clock that wrote the transcript.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { identityRig } from './helpers/prompt-identity-rig.js';

const savedHome = process.env.MYCO_HOME;
afterEach(() => { process.env.MYCO_HOME = savedHome; });

const lines = (records: readonly Record<string, unknown>[]): string => records.map((o) => `${JSON.stringify(o)}\n`).join('');
const SESSION = 'ses-parse-identity';
const A = '01932bd0-0000-7000-8000-0000000000a1';
const B = '01932bd0-0000-7000-8000-0000000000b2';

async function parsed(agent: string, text: string) {
  const r = await identityRig({ relevant: 0, background: 0 });
  r.rig.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', ?, 'machine_1', ?, 1, 1)`, [SESSION, r.rig.tokenId]);
  await r.storeTranscript({ transcriptId: `tx_${'e'.repeat(32)}`, sessionId: SESSION, agent, text });
  await r.parse();
  return r;
}

describe('a stamped transcript', () => {
  it('puts each reply and tool call on the prompt its own stamp names, not the last prompt line read', async () => {
    const r = await parsed('opencode', lines([
      { v: 1, type: 'prompt', sessionId: SESSION, promptId: A, text: 'first', origin: 'human', at: '2026-10-18T12:00:01.000Z' },
      { v: 1, type: 'prompt', sessionId: SESSION, promptId: B, text: 'second', origin: 'human', at: '2026-10-18T12:00:02.000Z' },
      { v: 1, type: 'response', sessionId: SESSION, promptId: A, text: 'for the first', at: '2026-10-18T12:00:03.000Z' },
      { v: 1, type: 'tool', sessionId: SESSION, promptId: A, name: 'read', input: {}, output: 'ok', failed: false, at: '2026-10-18T12:00:04.000Z' },
      { v: 1, type: 'response', sessionId: SESSION, text: 'unstamped', at: '2026-10-18T12:00:05.000Z' },
    ]));
    expect((await r.records()).filter(p=>p.k==='reply').map(p=>({text:p.text,prompt_id:p.prompt_id}))).toEqual([{ text: 'for the first', prompt_id: A }, { text: 'unstamped', prompt_id: B }]);
    expect((await r.records()).filter(p=>p.k==='tool').map(p=>({prompt_id:p.prompt_id}))).toEqual([{ prompt_id: A }]);
  });
});
