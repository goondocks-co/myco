import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { OutboundEvent } from '@myco/member/envelope.js';
import { rootKeyFor } from '@myco/member/auto-join.js';
import {
  autoJoinDir, clearJoinRequest, clearPendingImport, listAutoJoinStates, listJoinRequests, listPendingImports, markSessionsReported,
  noticeOnce, queueImport, readAutoJoinState, recordSessionSeen, requestJoin, unreportedSessions, writeAutoJoinState,
} from '@myco/member/auto-join.js';
import { flushHeldCapture } from '@myco/member/held.js';
import { appendPending, appendPendingTurnEnd, assignLegacyPending, expirePending, flushPending, listHeldEnds, listPending, pendingDir, pendingSpool, PENDING_TTL_MS } from '@myco/member/pending.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { readSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';

const FIRST = 'https://first.example';
const SECOND = 'https://second.example';
const homes: string[] = [];
const home = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pending-route-'));
  homes.push(dir);
  return dir;
};
const repo = { root: '/checkout/widget', rootKey: 'a'.repeat(32) };
const event = (sessionId: string): OutboundEvent => ({ envelope: {
  eventId: '00000000-0000-4000-8000-000000000001', sessionId, kind: 'session.start', createdAt: 1,
  channel: 'cli', producer: { adapter: 'claude-code', version: '1' }, payload: {},
} } as OutboundEvent);

afterEach(() => { for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('pending capture destination', () => {
  it('pins the normalized Deployment at staging and moves only to that Deployment', () => {
    const mycoHome = home();
    const first = { ...repo, serverUrl: `${FIRST}/` };
    const second = { ...repo, serverUrl: SECOND };
    const staged = pendingSpool(first, { mycoHome, now: 1 });
    expect(staged?.dir).toBe(pendingDir(repo.rootKey, mycoHome, FIRST));
    expect(JSON.parse(fs.readFileSync(path.join(staged!.dir, 'pending.json'), 'utf8')).serverUrl).toBe(FIRST);
    const blobSource = staged!.stagerFor('first')(Buffer.from('held bytes'), 'text/plain');
    expect(appendPending(first, 'first', [{ ...event('first'), blobSource }], (state) => { state.promptId = 'prompt'; }, { mycoHome, now: 2 })).toBe('pending');
    expect(appendPending(second, 'second', [event('second')], undefined, { mycoHome, now: 3 })).toBe('pending');

    const wrong = new MemberSpool({ serverUrl: 'https://third.example', projectId: 'project' }, { mycoHome });
    expect(flushPending(repo.rootKey, wrong, { mycoHome, now: 4 })).toBe(0);
    expect(listPending({ mycoHome, now: 4 }).map((entry) => entry.serverUrl).sort()).toEqual([FIRST, SECOND]);

    const into = new MemberSpool({ serverUrl: FIRST, projectId: 'project' }, { mycoHome });
    expect(flushPending(repo.rootKey, into, { mycoHome, now: 5 })).toBe(1);
    expect(into.readRecords('first')).toHaveLength(1);
    expect(fs.readFileSync(into.readRecords('first')[0]!._blobSource!.path, 'utf8')).toBe('held bytes');
    expect(readSessionState(into.dir, 'first').promptId).toBe('prompt');
    expect(into.readRecords('second')).toHaveLength(0);
    expect(listPending({ mycoHome, now: 5 }).map((entry) => entry.serverUrl)).toEqual([SECOND]);
  });

  it('keeps a hook on its original Deployment when the repository binding changes while it runs', () => {
    const mycoHome = home();
    const held = { ...repo, rootKey: rootKeyFor(repo.root, mycoHome), serverUrl: FIRST };
    pendingSpool(held, { mycoHome, now: 1 });
    appendPending(held, 'before', [event('before')], undefined, { mycoHome, now: 1 });
    writeRegistryEntry({ version: REGISTRY_VERSION, root: repo.root, serverUrl: SECOND, projectId: 'other',
      token: 'test-token', machineId: 'test-machine', joinedAt: 2, updatedAt: 2 }, { mycoHome });
    expect(appendPending(held, 'after', [event('after')], undefined, { mycoHome, now: 2 })).toBe('pending');
    expect(flushHeldCapture(repo.root, { serverUrl: SECOND, projectId: 'other' }, { mycoHome, now: 3 })).toBe(0);
    expect(new MemberSpool({ serverUrl: SECOND, projectId: 'other' }, { mycoHome }).readRecords('before')).toHaveLength(0);
    expect(listPending({ mycoHome, now: 3 }).map((entry) => entry.records)).toEqual([2]);
  });

  it('keeps legacy capture whose Deployment is unknown and lists ends for both known Deployments', () => {
    const mycoHome = home();
    appendPending(repo, 'legacy', [event('legacy')], undefined, { mycoHome, now: 1 });
    const into = new MemberSpool({ serverUrl: FIRST, projectId: 'project' }, { mycoHome });
    expect(flushPending(repo.rootKey, into, { mycoHome, now: 2 })).toBe(0);
    expect(listPending({ mycoHome, now: 2 }).map((entry) => entry.serverUrl)).toEqual([undefined]);

    const now = PENDING_TTL_MS + 10;
    for (const [serverUrl, sessionId] of [[FIRST, 'first'], [SECOND, 'second']] as const) {
      appendPending({ ...repo, serverUrl }, sessionId, [event(sessionId)], undefined, { mycoHome, now: 1 });
    }
    expect(listPending({ mycoHome, now }).map((entry) => entry.serverUrl)).toEqual([undefined]);
    expect(listHeldEnds(mycoHome).map((entry) => entry.serverUrl).sort()).toEqual([FIRST, SECOND]);
    expect(fs.existsSync(pendingDir(repo.rootKey, mycoHome))).toBe(true);
  });

  it('assigns legacy capture explicitly with a durable receipt and preserves its original records', () => {
    const mycoHome = home();
    const source = pendingSpool(repo, { mycoHome, now: 1 })!;
    const blobSource = source.stagerFor('legacy')(Buffer.from('legacy bytes'), 'text/plain');
    appendPending(repo, 'legacy', [{ ...event('legacy'), blobSource }], (state) => { state.promptId = 'legacy-prompt'; }, { mycoHome, now: 2 });
    appendPendingTurnEnd(repo, 'legacy', { slot: 'primary', transcriptId: 'legacy-transcript', atSize: 9 }, undefined, { mycoHome, now: 3 });
    const original = fs.readFileSync(path.join(source.dir, 'legacy.jsonl'));
    const route = { serverUrl: FIRST, projectId: 'project' };
    const assignmentAt = PENDING_TTL_MS + 4;

    expect(assignLegacyPending(repo.rootKey, route, { mycoHome, now: assignmentAt })).toBe(true);
    const into = new MemberSpool(route, { mycoHome });
    expect(expirePending(repo.rootKey, { mycoHome, now: assignmentAt + 1, serverUrl: FIRST })).toBe(false);
    fs.rmSync(path.join(source.dir, 'assignment.json'));
    expect(flushPending(repo.rootKey, into, { mycoHome, now: assignmentAt + 1 })).toBe(0);
    expect(assignLegacyPending(repo.rootKey, route, { mycoHome, now: assignmentAt + 2 })).toBe(true);
    expect(flushPending(repo.rootKey, into, { mycoHome, now: assignmentAt + 3 })).toBe(1);
    expect(assignLegacyPending(repo.rootKey, route, { mycoHome, now: assignmentAt + 4 })).toBe(false);
    expect(() => assignLegacyPending(repo.rootKey, { serverUrl: SECOND, projectId: 'other' }, { mycoHome, now: assignmentAt + 5 })).toThrow();
    expect(fs.readFileSync(path.join(source.dir, 'legacy.jsonl'))).toEqual(original);
    expect(fs.readFileSync(blobSource.path, 'utf8')).toBe('legacy bytes');
    expect(fs.readFileSync(into.readRecords('legacy')[0]!._blobSource!.path, 'utf8')).toBe('legacy bytes');
    expect(readSessionState(into.dir, 'legacy').promptId).toBe('legacy-prompt');
    expect(into.pendingTurnEnds('legacy').map((pending) => pending.mark.atSize)).toEqual([9]);
    expect(listPending({ mycoHome, now: PENDING_TTL_MS + 100 }).map((entry) => entry.assignedTo)).toEqual([route]);
  });
});

describe('auto-join destination state', () => {
  it('keeps session counts and notices independent for two Deployments', () => {
    const mycoHome = home();
    recordSessionSeen(repo.rootKey, 'same-session', mycoHome, FIRST);
    recordSessionSeen(repo.rootKey, 'same-session', mycoHome, SECOND);
    expect([unreportedSessions(repo.rootKey, mycoHome, FIRST), unreportedSessions(repo.rootKey, mycoHome, SECOND)]).toEqual([1, 1]);
    markSessionsReported(repo.rootKey, 1, mycoHome, FIRST);
    expect([unreportedSessions(repo.rootKey, mycoHome, FIRST), unreportedSessions(repo.rootKey, mycoHome, SECOND)]).toEqual([0, 1]);
    expect(noticeOnce('same-session', mycoHome, Date.now(), FIRST)).toBe(true);
    expect(noticeOnce('same-session', mycoHome, Date.now(), SECOND)).toBe(true);
    expect(noticeOnce('same-session', mycoHome, Date.now(), FIRST)).toBe(false);
  });

  it('retains separate join requests, import receipts, and attempt state after a default change', () => {
    const mycoHome = home();
    requestJoin(repo.root, repo.rootKey, FIRST, mycoHome, 1);
    requestJoin(repo.root, repo.rootKey, SECOND, mycoHome, 2);
    expect(listJoinRequests(mycoHome).map((request) => request.serverUrl)).toEqual([FIRST, SECOND]);
    clearJoinRequest(listJoinRequests(mycoHome)[0]!, mycoHome);
    expect(listJoinRequests(mycoHome).map((request) => request.serverUrl)).toEqual([SECOND]);

    for (const [serverUrl, projectId] of [[FIRST, 'first'], [SECOND, 'second']] as const) {
      queueImport({ ...repo, serverUrl, projectId, at: 1 }, mycoHome);
      writeAutoJoinState({ ...repo, serverUrl, projectId, label: 'widget', outcome: 'missed', attemptAt: 1 }, mycoHome);
    }
    queueImport({ ...repo, serverUrl: FIRST, projectId: 'rebound', at: 2 }, mycoHome);
    expect(listPendingImports(mycoHome).map((item) => `${item.serverUrl}/${item.projectId}`).sort()).toEqual([
      `${FIRST}/first`, `${FIRST}/rebound`, `${SECOND}/second`,
    ]);
    expect(listAutoJoinStates(mycoHome).map((state) => state.serverUrl).sort()).toEqual([FIRST, SECOND]);
    expect(readAutoJoinState(repo.rootKey, mycoHome, FIRST)?.projectId).toBe('first');
    expect(readAutoJoinState(repo.rootKey, mycoHome, SECOND)?.projectId).toBe('second');
    clearPendingImport(repo.rootKey, mycoHome, { serverUrl: FIRST, projectId: 'first' });
    expect(listPendingImports(mycoHome).map((item) => item.projectId).sort()).toEqual(['rebound', 'second']);
  });

  it('keeps an older join request with no recorded Deployment separate from a new request', () => {
    const mycoHome = home();
    const dir = path.join(autoJoinDir(mycoHome), 'requests');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${repo.rootKey}.json`), JSON.stringify({ ...repo, at: 1 }), { mode: 0o600 });
    requestJoin(repo.root, repo.rootKey, SECOND, mycoHome, 2);
    expect(listJoinRequests(mycoHome).map((item) => item.serverUrl)).toEqual([undefined, SECOND]);
  });
});
