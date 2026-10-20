/**
 * A context ask carries the id `withAsk` minted for it: an answer settles that ask alone, and a prompt renders an
 * answer by the id of the ask it answered. State and caches written before asks carried ids are dropped and counted.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deadlineBudget } from '@myco/member/budget.js';
import { readSessionContext, sessionContextPath, withAsk } from '@myco/member/context-cache.js';
import { prefetchContext } from '@myco/member/prefetch.js';
import { readSessionState, sessionStatePath, updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from '@myco/member/transport.js';

const SERVER_URL = 'https://prefetch.example';
const PROJECT_ID = 'proj_ecfd2c27e50729848003a856c1c3747e';
const scratches: string[] = [];
afterEach(() => { for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function spool(): MemberSpool {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-prefetch-identity-'));
  scratches.push(run);
  return new MemberSpool({ serverUrl: SERVER_URL, projectId: PROJECT_ID }, { mycoHome: path.join(run, 'myco') });
}

describe('context ask identity', () => {
  it('mints a distinct id for each ask, even in the same millisecond', () => {
    const first = withAsk(undefined, { kind: 'prompt', promptId: 'a', text: 'a', at: 789 });
    const second = withAsk(first, { kind: 'prompt', promptId: 'b', text: 'b', at: 789 });
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
  });

  it('keeps a newer ask written in the same millisecond while an older answer settles', async () => {
    const live = spool();
    const sessionId = 'same-millisecond';
    const at = 789;
    updateSessionState(live.dir, sessionId, (state) => { state.contextAsks = withAsk(state.contextAsks, { kind: 'prompt', promptId: 'old', text: 'old', at }); });
    const client = new ServerClient({ serverUrl: SERVER_URL, projectId: PROJECT_ID, token: 'fake' }, async () => {
      updateSessionState(live.dir, sessionId, (state) => { state.contextAsks = withAsk(state.contextAsks, { kind: 'prompt', promptId: 'new', text: 'new', at }); });
      return Response.json({ persisted: true, context: 'old context', skipped: [] }, { headers: { 'x-myco-protocol': '1' } });
    }, { credentialSource: 'env' });
    const report = await prefetchContext({ spool: live, client, serverUrl: SERVER_URL, mycoHome: live.mycoHome, budget: deadlineBudget(Date.now() + 10_000), now: Date.now });
    expect(report).toMatchObject({ asked: 1, answered: 1 });
    const asks = readSessionState(live.dir, sessionId).contextAsks;
    expect(asks?.map((ask) => (ask.kind === 'prompt' ? ask.promptId : ask.kind))).toEqual(['new']);
    expect(readSessionContext(live.dir, sessionId).prompt?.askId).not.toBe(asks![0]!.id);
  });

  it('drops stored asks without an id and reports them once', () => {
    const live = spool();
    const sessionId = 'unidentified';
    updateSessionState(live.dir, sessionId, () => {});
    const file = sessionStatePath(live.dir, sessionId);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.contextAsks = [{ kind: 'start', at: 1 }, { kind: 'prompt', text: 'old', at: 2 }, ...withAsk(undefined, { kind: 'compact', compaction: 1, at: 3 })];
    stored.renderedAsk = 2;
    fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const first = readSessionState(live.dir, sessionId);
      readSessionState(live.dir, sessionId);
      expect(first.contextAsks?.map((ask) => ask.kind)).toEqual(['compact']);
      expect(first.renderedAsk).toBeUndefined();
      expect(stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('2 context ask(s) without an id dropped'))).toHaveLength(1);
    } finally { stderr.mockRestore(); }
  });

  it('treats a cached answer without an ask id as absent, and reports it once', () => {
    const live = spool();
    const file = sessionContextPath(live.dir, 'legacy-cache');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, prompt: { context: 'old answer', at: 11, askedAt: 10 } }), { mode: 0o600 });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(readSessionContext(live.dir, 'legacy-cache').prompt).toBeUndefined();
      expect(readSessionContext(live.dir, 'legacy-cache').prompt).toBeUndefined();
      expect(stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('cached answer without an ask id'))).toHaveLength(1);
    } finally { stderr.mockRestore(); }
  });
});
