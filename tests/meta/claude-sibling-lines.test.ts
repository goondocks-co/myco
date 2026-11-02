
/**
 * claude-v1, as PR 1 left it: a delegated agent's transcript and a teammate's message carry the lead's current
 * `promptId`. Whichever transcript the Deployment parses first, the person's prompt keeps the id its hook derives and
 * its own text, and each sibling line is a prompt of its own, from an agent. A transcript pinned to claude-v1 keeps
 * deriving exactly this; claude-v2 is `claude-v2-identity.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { promptIdFor } from '@myco-server-worker/ingest/parsers/index.js';
import {  } from '@myco-server-worker/ingest/parse.js';
import { identityRig } from './helpers/prompt-identity-rig.js';
import { V1_LEAD, V1_SUBAGENT } from './helpers/claude-v1-siblings.js';

const FILES: Record<string, string> = { 'lead.jsonl': V1_LEAD, 'subagent.jsonl': V1_SUBAGENT };
const read = (name: string) => FILES[name]!;
const SESSION = '5d2c9a1e-7b3f-4c1a-9e8d-2f6b0a4c8e11';
const KEY = '7c1e5b2a-9d4f-4e3b-8a6c-1f0e2d3c4b5a';
const TRANSCRIPTS = {
  lead: { transcriptId: `tx_${'1'.repeat(32)}`, file: 'lead.jsonl', role: 'primary' as const },
  subagent: { transcriptId: `tx_${'2'.repeat(32)}`, file: 'subagent.jsonl', role: 'subagent' as const },
};

const savedHome = process.env.MYCO_HOME;
afterEach(() => { process.env.MYCO_HOME = savedHome; resetMachineIdCache(); });

describe('Claude Code sibling lines under the lead prompt id', () => {
  for (const order of [['lead', 'subagent'], ['subagent', 'lead']] as const) {
    it(`keeps the person's prompt on its own id when the ${order[0]} transcript is parsed first`, async () => {
      const r = await identityRig({ relevant: 0, background: 0 });
      r.rig.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        VALUES ('proj_1', ?, 'machine_1', ?, 1, 1)`, [SESSION, r.rig.tokenId]);
      for (const name of order) {
        const t = TRANSCRIPTS[name];
        await r.storeTranscript({ transcriptId: t.transcriptId, sessionId: SESSION, agent: 'claude-code', text: read(t.file), role: t.role, scheme: 'claude-v1' });
        await r.parse();
      }
      const person = await promptIdFor(SESSION, 'user_prompt', KEY);
      const prompts = (await r.records(SESSION)).filter(p=>p.k==='prompt').map(p=>({prompt_id:p.id,text:p.text,origin:p.origin,prompt_kind:p.prompt_kind}));
      expect(prompts).toEqual([
        { prompt_id: person, text: 'Review the retention change and tell me what breaks.', origin: 'user', prompt_kind: 'user_prompt' },
        { prompt_id: await promptIdFor(SESSION, 'sidechain', '0a1b2c3d-0000-4000-8000-000000000101'), text: 'Review the retention change in src/retention.ts.', origin: 'agent_dispatch', prompt_kind: 'sidechain' },
        { prompt_id: await promptIdFor(SESSION, 'teammate_message', '0a1b2c3d-0000-4000-8000-000000000004'), text: expect.stringContaining('<teammate-message'), origin: 'agent_dispatch', prompt_kind: 'teammate_message' },
      ]);
      expect((await r.records(SESSION)).filter(p=>p.k==='reply'&&p.text==='Delegating the review.').map(p=>({prompt_id:p.prompt_id}))).toEqual([{ prompt_id: person }]);
    });
  }
});
