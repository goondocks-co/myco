import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setBufferedStdin } from '@myco/hooks/read-stdin.js';
import { runMemberHook } from '@myco/member/capture.js';
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
  rig = await memberRig();
  registerTestMember({ mycoHome, token: rig.token, tokenId: rig.tokenId, projectId: 'proj_1', expiresAt: rig.expiresAt });
});

afterEach(() => {
  process.env.MYCO_HOME = savedHome;
});

const kinds = (sessionId: string): string[] => new MemberSpool({ projectId: 'proj_1', serverUrl: 'https://member-test.invalid' }, { mycoHome })
  .readRecords(sessionId).flatMap((record) => record ? [record.kind] : []);

describe('optional capture follows the mandatory spool append', () => {
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
