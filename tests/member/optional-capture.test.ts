import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { setBufferedStdin } from '@myco/hooks/read-stdin.js';
import { runMemberHook } from '@myco/member/capture.js';
import * as contextCache from '@myco/member/context-cache.js';
import { mintId, promptEvent } from '@myco/member/envelope.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
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

afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  resetMachineIdCache();
});

const kinds = (sessionId: string): string[] => new MemberSpool('proj_1', { mycoHome })
  .readRecords(sessionId).flatMap((record) => record ? [record.kind] : []);

describe('optional capture follows the mandatory spool append', () => {
  it('spools a prompt and its receipt when the turn feature lookup throws', async () => {
    const lookup = spyOn(contextCache, 'featureAdvertised').mockImplementation(() => { throw new Error('feature lookup failed'); });
    try {
      const result = await runHook('user-prompt-submit', { session_id: 'sess-prompt', hook_event_name: 'UserPromptSubmit', prompt: 'capture me' }, { fetch: rig.fetch, symbiont: 'copilot' });
      expect(result.stderr).toContain('optional capture skipped: feature lookup failed');
      expect(kinds('sess-prompt')).toEqual(['prompt']);
      expect(readSessionState(new MemberSpool('proj_1', { mycoHome }).dir, 'sess-prompt').promptId).toBeDefined();
    } finally {
      lookup.mockRestore();
    }
  });

  it('spools a response and leaves the transcript turn-end mark when the feature lookup throws', async () => {
    const transcript = path.join(mycoHome, 'stop-transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'hello' } })}\n`);
    const lookup = spyOn(contextCache, 'featureAdvertised').mockImplementation(() => { throw new Error('feature lookup failed'); });
    try {
      const result = await runHook('stop', {
        session_id: 'sess-stop', hook_event_name: 'Stop', transcript_path: transcript, last_assistant_message: 'saved reply',
      }, { fetch: rig.fetch, symbiont: 'copilot' });
      expect(result.stderr).toContain('optional capture skipped: feature lookup failed');
      expect(kinds('sess-stop')).toContain('response');
      expect(new MemberSpool('proj_1', { mycoHome }).pendingTurnEnds('sess-stop').map(({ mark }) => mark.atSize)).toEqual([fs.statSync(transcript).size]);
    } finally {
      lookup.mockRestore();
    }
  });

  it('commits arbitrary optional work after the captured event and its receipt', async () => {
    const sessionId = 'sess-generic';
    const originalArgv = process.argv;
    process.argv = [originalArgv[0], 'myco', 'hook', 'user-prompt-submit', '--symbiont', 'copilot'];
    setBufferedStdin(Buffer.from(JSON.stringify({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', prompt: 'record first' })));
    let sawCommitted = false;
    try {
      await runMemberHook('user-prompt-submit', {
        credential: 'registry', argv: process.argv, helperSpawn: () => ({ started: false }),
      }, (run) => ({
        events: [promptEvent(run.ctx, { promptId: mintId(), text: 'record first' })],
        record: (state) => { state.promptId = 'receipt-committed'; },
        optional: () => {
          sawCommitted = kinds(sessionId).includes('prompt') && readSessionState(run.spool.dir, sessionId).promptId === 'receipt-committed';
          throw new Error('optional work failed');
        },
      }));
      expect(sawCommitted).toBe(true);
      expect(kinds(sessionId)).toEqual(['prompt']);
    } finally {
      setBufferedStdin(null);
      process.argv = originalArgv;
    }
  });
});
