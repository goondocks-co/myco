/**
 * A session's held capture adopted into its Project spool, through the real pending writer, restore and move:
 * - what protects capture moves: prompt backfill, the lifecycle, both primary transcripts;
 * - a session either side shows open stays open, so its transcript tail is held, in both orientations;
 * - held context asks and render markers are dropped and counted, and nothing settled in the target comes back.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootKeyFor } from '@myco/member/auto-join.js';
import { holdsTranscriptTail } from '@myco/member/backlog.js';
import { deadlineBudget } from '@myco/member/budget.js';
import { readSessionContext, withAsk } from '@myco/member/context-cache.js';
import { sessionStartEvent } from '@myco/member/envelope.js';
import { restoreHeldReceiptsForHook } from '@myco/member/held.js';
import { appendPending, flushPending, flushPendingForRoot, pendingSpool } from '@myco/member/pending.js';
import { prefetchContext } from '@myco/member/prefetch.js';
import { readSessionState, sessionStatePath, updateSessionState, type SessionState, type TranscriptPointer } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { ServerClient } from '@myco/member/transport.js';

const SERVER_URL = 'https://held.example';
const PROJECT_ID = 'proj_ecfd2c27e50729848003a856c1c3747e';
const scratches: string[] = [];
afterEach(() => { for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function rig() {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-held-adoption-'));
  scratches.push(run);
  const mycoHome = path.join(run, 'myco');
  const root = path.join(run, 'repo');
  fs.mkdirSync(root);
  const repo = { root, rootKey: rootKeyFor(root, mycoHome), serverUrl: SERVER_URL };
  const live = new MemberSpool({ serverUrl: SERVER_URL, projectId: PROJECT_ID }, { mycoHome });
  return { run, mycoHome, repo, live };
}

/** Hold `record` for `sessionId` in the repository's pending spool, with the session's start event. */
function hold(r: ReturnType<typeof rig>, sessionId: string, record: (state: SessionState) => void, now = 1_000): void {
  const held = pendingSpool(r.repo, { mycoHome: r.mycoHome, now });
  if (held === null) throw new Error('pending spool unavailable');
  const event = sessionStartEvent({ agent: 'claude-code', sessionId, stage: held.stagerFor(sessionId), now: () => now }, { startedAt: now, originPath: r.repo.root });
  expect(appendPending(r.repo, sessionId, [event], record, { mycoHome: r.mycoHome, now })).toBe('pending');
}

const pointer = (file: string): TranscriptPointer => ({ path: file, transcriptId: `tx-${path.basename(file)}`, inode: 1, nextOffset: 0, parsedSize: 0 });
const holdsTail = (r: ReturnType<typeof rig>, state: SessionState, now: number): boolean => holdsTranscriptTail(r.live, state, now, SERVER_URL, false);

describe('held capture adoption', () => {
  it('moves prompt backfill and the open lifecycle into an empty target, and drops held asks with a count', () => {
    const r = rig();
    const sessionId = 'held-open';
    const at = 5_000;
    hold(r, sessionId, (state) => {
      state.contextAsks = withAsk(undefined, { kind: 'start', at });
      state.promptBackfill = { transcriptPath: path.join(r.run, 'transcript.jsonl'), at };
      state.hookAt = at;
    }, at);
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(flushPending(r.repo.rootKey, r.live, { mycoHome: r.mycoHome, now: at })).toBe(1);
      expect(stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(`pending session ${sessionId} moved without 1 held context item(s)`))).toHaveLength(1);
    } finally { stderr.mockRestore(); }
    const after = readSessionState(r.live.dir, sessionId);
    expect(r.live.readRecords(sessionId).map((record) => record?.kind)).toEqual(['session.start']);
    expect(after.promptBackfill).toEqual({ transcriptPath: path.join(r.run, 'transcript.jsonl'), at });
    expect(after.hookAt).toBe(at);
    expect(after.endedAt).toBeUndefined();
    expect(after.contextAsks).toBeUndefined();
    expect(holdsTail(r, after, at + 1)).toBe(true);
  });

  it.each([
    ['held ended, target resumed', { hookAt: 100, endedAt: 100 }, { hookAt: 200 }],
    ['held resumed, target ended', { hookAt: 200 }, { hookAt: 100, endedAt: 100 }],
    ['held open, target ended later', { hookAt: 100 }, { hookAt: 200, endedAt: 200 }],
    ['held ended later, target open', { hookAt: 200, endedAt: 200 }, { hookAt: 100 }],
  ] as const)('keeps the session open when %s, holding its tail', (_case, held, target) => {
    const r = rig();
    const sessionId = 'lifecycle';
    updateSessionState(r.live.dir, sessionId, (state) => Object.assign(state, target));
    hold(r, sessionId, (state) => Object.assign(state, held));
    const rolledBack = spyOn(Date, 'now').mockReturnValue(1);
    try { flushPending(r.repo.rootKey, r.live, { mycoHome: r.mycoHome, now: 1 }); }
    finally { rolledBack.mockRestore(); }
    const after = readSessionState(r.live.dir, sessionId);
    expect({ hookAt: after.hookAt, endedAt: after.endedAt }).toEqual({ hookAt: 200, endedAt: undefined });
    expect(holdsTail(r, after, 201)).toBe(true);
  });

  it('ends the session only when every side that saw a hook ended, keeping the target\'s end', () => {
    const r = rig();
    updateSessionState(r.live.dir, 'ended', (state) => { state.hookAt = 150; state.endedAt = 150; });
    hold(r, 'ended', (state) => { state.hookAt = 100; state.endedAt = 120; });
    flushPending(r.repo.rootKey, r.live, { mycoHome: r.mycoHome, now: 1 });
    const after = readSessionState(r.live.dir, 'ended');
    expect({ hookAt: after.hookAt, endedAt: after.endedAt }).toEqual({ hookAt: 150, endedAt: 150 });
    expect(holdsTail(r, after, 151)).toBe(false);
  });

  it.each([['held', 'target'], ['target', 'held']])('keeps both primary transcripts when the %s one is at another path', (heldName, targetName) => {
    const r = rig();
    const heldFile = path.join(r.run, `${heldName}.jsonl`);
    const targetFile = path.join(r.run, `${targetName}.jsonl`);
    updateSessionState(r.live.dir, 'pointers', (state) => { state.transcript = pointer(targetFile); });
    hold(r, 'pointers', (state) => { state.transcript = pointer(heldFile); });
    flushPending(r.repo.rootKey, r.live, { mycoHome: r.mycoHome, now: 1 });
    const after = readSessionState(r.live.dir, 'pointers');
    expect(after.transcript?.path).toBe(targetFile);
    expect(after.continuations?.[heldFile]).toEqual(pointer(heldFile));
  });

  it('keeps the target\'s continuation, with its progress and refusal, when a held primary names the same transcript', () => {
    const r = rig();
    const oldFile = path.join(r.run, 'old.jsonl');
    const settled = { ...pointer(oldFile), nextOffset: 500, parsedSize: 500, refused: 'identity_conflict' };
    updateSessionState(r.live.dir, 'rotated', (state) => {
      state.transcript = pointer(path.join(r.run, 'new.jsonl'));
      state.continuations = { [oldFile]: settled };
    });
    hold(r, 'rotated', (state) => { state.transcript = pointer(oldFile); });
    restoreHeldReceiptsForHook(r.repo.root, 'rotated', r.live, { mycoHome: r.mycoHome, now: 1 });
    expect(readSessionState(r.live.dir, 'rotated').continuations?.[oldFile]).toEqual(settled);
    flushPendingForRoot(r.repo.root, r.live, { mycoHome: r.mycoHome, now: 2 });
    expect(readSessionState(r.live.dir, 'rotated').continuations?.[oldFile]).toEqual(settled);
  });

  it('counts held asks without an id and a non-id render marker among the context it moved without', () => {
    const r = rig();
    const sessionId = 'older-format';
    hold(r, sessionId, (state) => { state.hookAt = 100; });
    const file = sessionStatePath(pendingSpool(r.repo, { mycoHome: r.mycoHome, now: 1 })!.dir, sessionId);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...stored, contextAsks: [{ kind: 'start', at: 1 }, { kind: 'prompt', text: 'old', at: 2 }], renderedAsk: 100 }), { mode: 0o600 });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(flushPending(r.repo.rootKey, r.live, { mycoHome: r.mycoHome, now: 1 })).toBe(1);
      expect(stderr.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(`pending session ${sessionId} moved without 3 held context item(s)`))).toHaveLength(1);
    } finally { stderr.mockRestore(); }
    const after = readSessionState(r.live.dir, sessionId);
    expect(after.contextAsks).toBeUndefined();
    expect(after.renderedAsk).toBeUndefined();
  });

  it('restores, settles and moves a session without reviving a held ask or rendering a held answer', async () => {
    const r = rig();
    const sessionId = 'restore-settle-flush';
    hold(r, sessionId, (state) => {
      state.contextAsks = withAsk(undefined, { kind: 'prompt', promptId: 'held', text: 'held prompt', at: 100 });
      state.renderedAsk = 'held-marker';
      state.hookAt = 100;
    });
    updateSessionState(r.live.dir, sessionId, (state) => {
      state.contextAsks = withAsk(state.contextAsks, { kind: 'prompt', promptId: 'live', text: 'live prompt', at: 200 });
      state.hookAt = 200;
    });
    restoreHeldReceiptsForHook(r.repo.root, sessionId, r.live, { mycoHome: r.mycoHome, now: 1 });
    const restored = readSessionState(r.live.dir, sessionId);
    expect(restored.contextAsks?.map((ask) => (ask.kind === 'prompt' ? ask.text : ask.kind))).toEqual(['live prompt']);
    expect(restored.renderedAsk).toBeUndefined();
    const asked: string[] = [];
    const client = new ServerClient({ serverUrl: SERVER_URL, projectId: PROJECT_ID, token: 'fake' }, async (_input, init) => {
      asked.push(JSON.parse(String(init?.body)).text);
      return Response.json({ persisted: true, context: 'live answer', skipped: [] }, { headers: { 'x-myco-protocol': '1' } });
    }, { credentialSource: 'env' });
    await prefetchContext({ spool: r.live, client, serverUrl: SERVER_URL, mycoHome: r.mycoHome, budget: deadlineBudget(Date.now() + 10_000), now: Date.now });
    expect(asked).toEqual(['live prompt']);
    expect(flushPendingForRoot(r.repo.root, r.live, { mycoHome: r.mycoHome, now: 2 })).toBe(1);
    const after = readSessionState(r.live.dir, sessionId);
    expect(after.contextAsks).toBeUndefined();
    expect(after.renderedAsk).toBeUndefined();
    expect(readSessionContext(r.live.dir, sessionId).prompt).toMatchObject({ context: 'live answer', askId: restored.contextAsks![0]!.id });
  });
});
