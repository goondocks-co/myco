/**
 * A backlog walk reads every session's transcript pointers against their files: a transcript that grows after an
 * earlier walk, with no hook of its session since, is selected by the next walk.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drainBacklog } from '@myco/member/backlog.js';
import { deadlineBudget } from '@myco/member/budget.js';
import { updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from '@myco/member/transport.js';

const SERVER_URL = 'https://backlog.example';
const PROJECT_ID = 'proj_ecfd2c27e50729848003a856c1c3747e';
const scratches: string[] = [];
afterEach(() => { for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('backlog discovery', () => {
  it('selects a session whose transcript grew after an earlier walk reached its end', async () => {
    const run = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backlog-discovery-'));
    scratches.push(run);
    const mycoHome = path.join(run, 'myco');
    const sessionId = 'grown';
    const spool = new MemberSpool({ serverUrl: SERVER_URL, projectId: PROJECT_ID }, { mycoHome });
    const file = path.join(run, 'transcript.jsonl');
    fs.writeFileSync(file, 'abc');
    updateSessionState(spool.dir, sessionId, (state) => {
      state.transcript = { path: file, transcriptId: 'tx', inode: fs.statSync(file).ino, nextOffset: 3, parsedSize: 3 };
    });
    const requests: string[] = [];
    const client = new ServerClient({ serverUrl: SERVER_URL, projectId: PROJECT_ID, token: 'fake' }, async (input) => {
      requests.push(String(input));
      throw new Error('unexpected network request');
    }, { credentialSource: 'env' });
    const opts = { machineId: 'm', mycoHome, now: Date.now };
    const first = await drainBacklog(spool, client, deadlineBudget(Date.now() + 10_000), opts);
    expect(first.sessions).toEqual([]);
    fs.appendFileSync(file, 'def');
    const second = await drainBacklog(spool, client, deadlineBudget(Date.now() + 10_000), opts);
    // No symbiont is named for the session, so the walk keeps its bytes and its mark without dialling.
    expect(second.sessions).toEqual([{ sessionId, transcripts: 'no-agent' }]);
    expect(spool.transcriptBacklogIds()).toEqual([sessionId]);
    expect(requests).toEqual([]);
  });
});
