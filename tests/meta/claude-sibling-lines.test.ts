/**
 * claude-v1, as PR 1 left it: a delegated agent's transcript and a teammate's message carry the lead's current
 * `promptId`. Whichever transcript the Deployment parses first, the person's prompt keeps the id its hook derives and
 * its own text, and each sibling line is a prompt of its own, from an agent. A transcript pinned to claude-v1 keeps
 * deriving exactly this; claude-v2 is `claude-v2-identity.test.ts`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { promptIdFor } from '@myco-server-worker/ingest/parsers/index.js';
import { parseTranscripts } from '@myco-server-worker/ingest/parse.js';
import { identityRig, type IdentityRig } from './helpers/prompt-identity-rig.js';
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
      const prompts = r.rows(`SELECT prompt_id, text, origin, prompt_kind FROM prompt_batches WHERE session_id = ? ORDER BY created_at`, SESSION);
      expect(prompts).toEqual([
        { prompt_id: person, text: 'Review the retention change and tell me what breaks.', origin: 'user', prompt_kind: 'user_prompt' },
        { prompt_id: await promptIdFor(SESSION, 'sidechain', '0a1b2c3d-0000-4000-8000-000000000101'), text: 'Review the retention change in src/retention.ts.', origin: 'agent_dispatch', prompt_kind: 'sidechain' },
        { prompt_id: await promptIdFor(SESSION, 'teammate_message', '0a1b2c3d-0000-4000-8000-000000000004'), text: expect.stringContaining('<teammate-message'), origin: 'agent_dispatch', prompt_kind: 'teammate_message' },
      ]);
      expect(r.rows(`SELECT prompt_id FROM responses WHERE session_id = ? AND text = 'Delegating the review.'`, SESSION)).toEqual([{ prompt_id: person }]);
    });
  }
});

/**
 * A checkpoint the previous classification wrote: it parsed the delegated agent's first line as the person's prompt,
 * and stopped with that prompt open. The current parser derives that line's own id, so the lines that arrive after
 * the upgrade must not go on naming the person's prompt.
 */
describe('a checkpoint written under the previous sibling classification', () => {
  const [sidechainLine, replyLine] = read('subagent.jsonl').split('\n').filter((l) => l !== '').map((l) => `${l}\n`) as [string, string];
  const t = TRANSCRIPTS.subagent;

  async function checkpointedByPreviousParser(): Promise<{ r: IdentityRig; person: string; sidechain: string }> {
    const r = await identityRig({ relevant: 0, background: 0 });
    r.rig.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_1', ?, 'machine_1', ?, 1, 1)`, [SESSION, r.rig.tokenId]);
    await r.storeTranscript({ transcriptId: t.transcriptId, sessionId: SESSION, agent: 'claude-code', text: sidechainLine, role: t.role, scheme: 'claude-v1' });
    await r.parse();
    const person = await promptIdFor(SESSION, 'user_prompt', KEY);
    const sidechain = await promptIdFor(SESSION, 'sidechain', '0a1b2c3d-0000-4000-8000-000000000101');
    // What the previous parser stored and checkpointed: the line under the person's id, with that prompt open.
    r.rig.env.sqlite.run(`UPDATE prompt_batches SET prompt_id = ?, origin = 'user', prompt_kind = 'user_prompt' WHERE session_id = ? AND prompt_id = ?`, [person, SESSION, sidechain]);
    r.rig.env.sqlite.run(`UPDATE transcripts SET open_prompt_id = ?, prompt_generation = NULL WHERE transcript_id = ?`, [person, t.transcriptId]);
    expect(r.rows(`SELECT parsed_offset FROM transcripts WHERE transcript_id = ?`, t.transcriptId)).toEqual([{ parsed_offset: Buffer.byteLength(sidechainLine) }]);
    return { r, person, sidechain };
  }

  it('reads the transcript again from its start, so a line that arrives after the upgrade names the line\'s own prompt', async () => {
    const { r, sidechain } = await checkpointedByPreviousParser();
    await r.appendTranscript({ transcriptId: t.transcriptId, text: replyLine });
    await r.parse();
    expect(r.rows(`SELECT prompt_id FROM responses WHERE session_id = ? AND text = 'No breaking change found.'`, SESSION)).toEqual([{ prompt_id: sidechain }]);
    expect(r.rows(`SELECT parsed_offset = size AS caught_up, prompt_generation, json_extract(parser_context, '$.mycoParserRepair.status') AS repair FROM transcripts WHERE transcript_id = ?`, t.transcriptId))
      .toEqual([{ caught_up: 1, prompt_generation: 2, repair: 'replaying' }]);
  });

  it('resumes with no prompt open when the bytes before the cursor are gone, rather than under the person\'s prompt', async () => {
    const { r } = await checkpointedByPreviousParser();
    r.rig.env.sqlite.run(`DELETE FROM transcript_segments WHERE transcript_id = ? AND base_offset = 0`, [t.transcriptId]);
    await r.appendTranscript({ transcriptId: t.transcriptId, text: replyLine });
    await r.parse();
    expect(r.rows(`SELECT prompt_id FROM responses WHERE session_id = ? AND text = 'No breaking change found.'`, SESSION)).toEqual([{ prompt_id: null }]);
    expect(r.rows(`SELECT parsed_offset = size AS caught_up, prompt_generation, json_extract(parser_context, '$.mycoParserRepair.status') AS repair FROM transcripts WHERE transcript_id = ?`, t.transcriptId))
      .toEqual([{ caught_up: 1, prompt_generation: 2, repair: 'raw_prefix_pruned' }]);
  });

  it('drops the person\'s prompt from a call still waiting on its result when the bytes before the cursor are gone', async () => {
    const r = await identityRig({ relevant: 0, background: 0 });
    r.rig.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES ('proj_1', ?, 'machine_1', ?, 1, 1)`, [SESSION, r.rig.tokenId]);
    const at = (s: number) => `2026-10-18T09:01:0${s}.000Z`;
    const call = `${JSON.stringify({ parentUuid: '0a1b2c3d-0000-4000-8000-000000000101', isSidechain: true, agentId: 'a4f1c2e9', type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'src/retention.ts' } }], stop_reason: 'tool_use' },
      uuid: '0a1b2c3d-0000-4000-8000-000000000201', timestamp: at(1), sessionId: SESSION })}\n`;
    const result = `${JSON.stringify({ parentUuid: '0a1b2c3d-0000-4000-8000-000000000201', isSidechain: true, agentId: 'a4f1c2e9', type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'thirty days' }] },
      uuid: '0a1b2c3d-0000-4000-8000-000000000202', timestamp: at(2), sessionId: SESSION })}\n`;
    await r.storeTranscript({ transcriptId: t.transcriptId, sessionId: SESSION, agent: 'claude-code', text: sidechainLine + call, role: t.role, scheme: 'claude-v1' });
    // One live pass: the call stays pending in the checkpoint, waiting on its result.
    await parseTranscripts(r.rig.env.serverEnv, Date.now());
    const person = await promptIdFor(SESSION, 'user_prompt', KEY);
    const sidechain = await promptIdFor(SESSION, 'sidechain', '0a1b2c3d-0000-4000-8000-000000000101');
    expect(r.rows(`SELECT json_extract(parser_context, '$.mycoParserState.pending.toolu_read_1.promptId') AS pending FROM transcripts WHERE transcript_id = ?`, t.transcriptId))
      .toEqual([{ pending: sidechain }]);
    // What the previous parser stored and checkpointed: the line and its pending call under the person's id.
    r.rig.env.sqlite.run(`UPDATE prompt_batches SET prompt_id = ?, origin = 'user', prompt_kind = 'user_prompt' WHERE session_id = ? AND prompt_id = ?`, [person, SESSION, sidechain]);
    r.rig.env.sqlite.run(`UPDATE transcripts SET open_prompt_id = ?, prompt_generation = NULL,
      parser_context = json_set(parser_context, '$.mycoParserState.pending.toolu_read_1.promptId', ?) WHERE transcript_id = ?`, [person, person, t.transcriptId]);
    r.rig.env.sqlite.run(`DELETE FROM transcript_segments WHERE transcript_id = ? AND base_offset = 0`, [t.transcriptId]);
    await r.appendTranscript({ transcriptId: t.transcriptId, text: result });
    await r.parse();
    expect(r.rows(`SELECT prompt_id, tool_name, success FROM tool_calls WHERE session_id = ?`, SESSION)).toEqual([{ prompt_id: null, tool_name: 'Read', success: 1 }]);
    expect(r.rows(`SELECT parsed_offset = size AS caught_up, prompt_generation, json_extract(parser_context, '$.mycoParserRepair.status') AS repair,
      json_type(parser_context, '$.mycoParserPromptsDropped') AS mark FROM transcripts WHERE transcript_id = ?`, t.transcriptId))
      .toEqual([{ caught_up: 1, prompt_generation: 2, repair: 'raw_prefix_pruned', mark: null }]);
  });
});
