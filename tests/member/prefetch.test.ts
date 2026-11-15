/**
 * A context ask carries the id `withAsk` minted for it: an answer settles that ask alone, and a prompt renders an
 * answer by the id of the ask it answered. State and caches written before asks carried ids are dropped and counted.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deadlineBudget } from '@myco/member/budget.js';
import { contextDir, readProjectContext, withAsk } from '@myco/member/context-cache.js';
import { prefetchContext } from '@myco/member/prefetch.js';
import { readSessionState, sessionStatePath, updateSessionState } from '@myco/member/session-state.js';
import { queuePromptRecall } from '@myco/member/prompt-context.js';
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
  it('continues cached block asks when prompt recall storage is unreadable', async () => {
    const live = spool();
    updateSessionState(live.dir, 'isolated', state => {
      queuePromptRecall(state, { kind: 'prompt', text: 'recall', promptId: 'p', at: 1 }, { late: false });
      state.contextAsks = withAsk(undefined, { kind: 'start', at: 1 });
    });
    fs.mkdirSync(contextDir(live.dir), { recursive: true });
    fs.writeFileSync(path.join(contextDir(live.dir), 'prompt-retry.json'), 'invalid');
    const client = new ServerClient({ serverUrl: SERVER_URL, projectId: PROJECT_ID, token: 'fixture' }, async () => Response.json({ persisted: true, context: 'start survives' }), { credentialSource: 'env' });
    expect(await prefetchContext({ spool: live, client, serverUrl: SERVER_URL, mycoHome: path.join(scratches.at(-1)!, 'myco'), budget: deadlineBudget(Date.now() + 10_000), now: Date.now })).toMatchObject({ asked: 1, answered: 1 });
    expect(readProjectContext(live.dir).blocks.start?.context).toBe('start survives');
  });

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
    updateSessionState(live.dir, sessionId, (state) => { state.contextAsks = withAsk(state.contextAsks, { kind: 'compact', compaction: 1, at }); });
    const client = new ServerClient({ serverUrl: SERVER_URL, projectId: PROJECT_ID, token: 'fake' }, async () => {
      updateSessionState(live.dir, sessionId, (state) => { state.contextAsks = withAsk(state.contextAsks, { kind: 'compact', compaction: 2, at }); });
      return Response.json({ persisted: true, context: 'old context', skipped: [] }, { headers: { 'x-myco-protocol': '1' } });
    }, { credentialSource: 'env' });
    const report = await prefetchContext({ spool: live, client, serverUrl: SERVER_URL, mycoHome: live.mycoHome, budget: deadlineBudget(Date.now() + 10_000), now: Date.now });
    expect(report).toMatchObject({ asked: 1, answered: 1 });
    const asks = readSessionState(live.dir, sessionId).contextAsks;
    expect(asks?.map((ask) => (ask.kind === 'compact' ? ask.compaction : ask.kind))).toEqual([2]);
  });

  it('drops stored asks without an id and a render marker that is not an ask id, and reports them once', () => {
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
      expect(stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('3 context item(s) without an ask id dropped'))).toHaveLength(1);
    } finally { stderr.mockRestore(); }
  });

  it('discards queued prompt asks without requesting or caching their answers', async () => {
    const live = spool();
    updateSessionState(live.dir, 'expired', state => { state.contextAsks = withAsk(undefined, { kind: 'prompt', text: 'expired', at: 1 }); });
    let requested = false;
    const client = new ServerClient({ serverUrl: SERVER_URL, projectId: PROJECT_ID, token: 'fake' }, async () => {
      requested = true;
      return Response.json({ persisted: true, context: 'wrong prompt' });
    }, { credentialSource: 'env' });
    await prefetchContext({ spool: live, client, serverUrl: SERVER_URL, mycoHome: live.mycoHome, budget: deadlineBudget(Date.now() + 10_000), now: Date.now });
    expect(requested).toBe(false);
    expect(readSessionState(live.dir, 'expired').contextAsks).toBeUndefined();
  });
});
