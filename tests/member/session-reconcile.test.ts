/**
 * The session reconciler's rules over vectors of target and source states, and its three production paths:
 * - each rule's result for a side absent, present or cleared, in both orientations, with the clock rolled back;
 * - a session either side shows open stays open, so its transcript tail is held;
 * - the target's own context stands, and every source ask and render marker is dropped and counted;
 * - reconciling again changes nothing; and each path persists exactly the reconciled state.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rootKeyFor } from '@myco/member/auto-join.js';
import { holdsTranscriptTail } from '@myco/member/backlog.js';
import { withAsk, type ContextAsk } from '@myco/member/context-cache.js';
import { sessionStartEvent } from '@myco/member/envelope.js';
import { restoreHeldReceiptsForHook } from '@myco/member/held.js';
import { appendPending, flushPendingForRoot, pendingSpool } from '@myco/member/pending.js';
import { reconcileSessionState, type SourceSessionState } from '@myco/member/session-reconcile.js';
import { emptySessionState, readSessionState, updateSessionState, writeSessionStateUnlocked, type SessionState, type TranscriptPointer } from '@myco/member/session-state.js';
import { assignLegacySpoolDestination, legacySpoolDir, migrateLegacySpool } from '@myco/member/spool-migration.js';
import { MemberSpool } from '@myco/member/spool.js';

const SERVER_URL = 'https://reconcile.example';
const PROJECT_ID = 'proj_ecfd2c27e50729848003a856c1c3747e';
const scratches: string[] = [];
afterEach(() => { for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-session-reconcile-'));
  scratches.push(dir);
  return dir;
};

const source = (state: SessionState): SourceSessionState => state as SourceSessionState;
const state = (fields: Partial<SessionState> = {}): SessionState => ({ ...emptySessionState(0), ...fields });
const reconciled = (target: SessionState, from: SessionState) => reconcileSessionState(target, source(from));
const pointer = (file: string, offset = 0): TranscriptPointer => ({ path: file, transcriptId: `tx-${file}`, inode: 1, nextOffset: offset, parsedSize: offset });
const holdsTail = (merged: SessionState, now: number): boolean =>
  holdsTranscriptTail(new MemberSpool({ serverUrl: SERVER_URL, projectId: PROJECT_ID }, { mycoHome: path.join(scratch(), 'myco') }), merged, now, SERVER_URL, false);

describe('session reconciler rules', () => {
  const LIFECYCLES: Record<string, Pick<SessionState, 'hookAt' | 'endedAt'>> = {
    none: {}, 'open@100': { hookAt: 100 }, 'open@200': { hookAt: 200 }, 'ended@100': { hookAt: 100, endedAt: 100 },
    'ended@200': { hookAt: 200, endedAt: 200 }, 'endedOnly@150': { endedAt: 150 },
  };
  const pairs = Object.keys(LIFECYCLES).flatMap((target) => Object.keys(LIFECYCLES).map((from) => [target, from] as const));

  it.each(pairs)('reconciles a %s target with a %s source as one lifecycle', (targetName, sourceName) => {
    const target = state(LIFECYCLES[targetName]);
    const from = state(LIFECYCLES[sourceName]);
    const rolledBack = spyOn(Date, 'now').mockReturnValue(0);
    let merged: SessionState;
    try { merged = reconciled(target, from).state; }
    finally { rolledBack.mockRestore(); }
    const open = (side: SessionState) => side.hookAt !== undefined && side.endedAt === undefined;
    const hooks = [target.hookAt, from.hookAt].filter((at): at is number => at !== undefined);
    expect(merged.hookAt).toBe(hooks.length === 0 ? undefined : Math.max(...hooks));
    expect(merged.endedAt).toBe(open(target) || open(from) ? undefined : target.endedAt ?? from.endedAt);
    if (open(target) || open(from)) expect(holdsTail(merged, merged.hookAt! + 1)).toBe(true);
    expect(reconciled(merged, from).state).toEqual(merged);
  });

  it('keeps the target\'s own context and drops every source ask and marker with a count', () => {
    const asks = (text: string): ContextAsk[] => withAsk(undefined, { kind: 'prompt', text, at: 1 });
    for (const targetAsks of [undefined, asks('t')]) {
      for (const sourceAsks of [undefined, asks('s'), withAsk(asks('s'), { kind: 'start', at: 1 })]) {
        for (const [targetMarker, sourceMarker] of [[undefined, undefined], ['t', undefined], [undefined, 's'], ['t', 's']] as const) {
          const target = state({ ...(targetAsks ? { contextAsks: targetAsks } : {}), ...(targetMarker ? { renderedAsk: targetMarker } : {}) });
          const from = state({ ...(sourceAsks ? { contextAsks: sourceAsks } : {}), ...(sourceMarker ? { renderedAsk: sourceMarker } : {}) });
          const result = reconciled(target, from);
          expect(result.state.contextAsks).toEqual(targetAsks);
          expect(result.state.renderedAsk).toBe(targetMarker);
          expect(result.contextSkipped).toBe((sourceAsks?.length ?? 0) + (sourceMarker === undefined ? 0 : 1));
        }
      }
    }
  });

  it.each([['target', 'source'], ['source', 'target']] as const)('applies each scalar rule with the %s side present', (present) => {
    const fields: Partial<SessionState> = {
      promptId: 'p', agent: 'codex', promptBackfill: { transcriptPath: '/t', at: 1 }, startSettled: true, startedAt: 5, planTagCount: 2,
      compactionOrdinal: 3, lastAckAt: 4, lastAccountedAt: 4, lastDeliveryAt: 4, highWater: 7, markWater: 2, markGeneration: 'g',
      eventRetry: { at: 1, backoffMs: 1 }, transcriptRetry: { at: 1, backoffMs: 1 }, agentUnknown: true,
    };
    const merged = present === 'target' ? reconciled(state(fields), state()).state : reconciled(state(), state(fields)).state;
    const carried = { promptId: 'p', agent: 'codex', promptBackfill: { transcriptPath: '/t', at: 1 }, startSettled: true, startedAt: 5, planTagCount: 2, compactionOrdinal: 3, lastAckAt: 4, lastAccountedAt: 4, lastDeliveryAt: 4 };
    expect(merged).toMatchObject(carried);
    const targetOwned = { highWater: merged.highWater, markWater: merged.markWater, markGeneration: merged.markGeneration, eventRetry: merged.eventRetry, transcriptRetry: merged.transcriptRetry, agentUnknown: merged.agentUnknown };
    expect(targetOwned).toEqual(present === 'target'
      ? { highWater: 7, markWater: 2, markGeneration: 'g', eventRetry: { at: 1, backoffMs: 1 }, transcriptRetry: { at: 1, backoffMs: 1 }, agentUnknown: true }
      : { highWater: 0, markWater: undefined, markGeneration: undefined, eventRetry: undefined, transcriptRetry: undefined, agentUnknown: undefined });
  });

  it('takes earlier, later and either-side values, and unions with the target winning', () => {
    const target = state({ promptId: 'target', startedAt: 20, planTagCount: 1, lastAckAt: 50, prompts: { a: 'target-a', b: 'b' }, attachmentKeys: ['x'], delivered: ['cortex'] });
    const from = state({ promptId: 'source', startedAt: 10, planTagCount: 3, lastAckAt: 40, startSettled: true, prompts: { a: 'source-a', c: 'c' }, attachmentKeys: ['y', 'x'], delivered: ['cortex:agent'] });
    for (const [left, right, promptId] of [[target, from, 'target'], [from, target, 'source']] as const) {
      const merged = reconciled(left, right).state;
      expect(merged).toMatchObject({ promptId, startedAt: 10, planTagCount: 3, lastAckAt: 50, startSettled: true });
      expect(merged.prompts).toEqual({ ...right.prompts, ...left.prompts });
      expect(new Set(merged.attachmentKeys)).toEqual(new Set(['x', 'y']));
      expect(new Set(merged.delivered)).toEqual(new Set(['cortex', 'cortex:agent']));
    }
  });

  it('keeps every transcript pointer: a source primary at another path becomes a continuation', () => {
    expect(reconciled(state(), state({ transcript: pointer('/s') })).state.transcript).toEqual(pointer('/s'));
    const both = reconciled(state({ transcript: pointer('/t'), siblings: { '/x': pointer('/x', 1) } }), state({ transcript: pointer('/s'), siblings: { '/x': pointer('/x', 2), '/y': pointer('/y') } })).state;
    expect(both.transcript).toEqual(pointer('/t'));
    expect(both.continuations).toEqual({ '/s': pointer('/s') });
    expect(both.siblings).toEqual({ '/x': pointer('/x', 1), '/y': pointer('/y') });
    const same = reconciled(state({ transcript: pointer('/t', 5) }), state({ transcript: pointer('/t', 1) })).state;
    expect(same.transcript).toEqual(pointer('/t', 5));
    expect(same.continuations).toBeUndefined();
  });

  it('keeps the turn claim apart from the prompt id, and a steered turn steered', () => {
    expect(reconciled(state({ promptId: 'legacy' }), state({ turn: { id: 't1', promptId: 'opener' } })).state)
      .toMatchObject({ promptId: 'legacy', turn: { id: 't1', promptId: 'opener' } });
    expect(reconciled(state({ turn: { id: 't1', promptId: 'opener' } }), state({ turn: { id: 't1' } })).state.turn).toEqual({ id: 't1' });
    expect(reconciled(state({ turn: { id: 't1' } }), state({ turn: { id: 't1', promptId: 'opener' } })).state.turn).toEqual({ id: 't1' });
  });

  it('changes neither input', () => {
    const target = state({ hookAt: 1, contextAsks: withAsk(undefined, { kind: 'start', at: 1 }), prompts: { a: 'a' } });
    const from = state({ hookAt: 2, endedAt: 2, prompts: { b: 'b' }, transcript: pointer('/s') });
    const before = JSON.stringify([target, from]);
    reconciled(target, from);
    expect(JSON.stringify([target, from])).toBe(before);
  });
});

describe('session reconciler paths', () => {
  const sessionId = 'matrix';
  const rich = (side: 'target' | 'source', at: number): Partial<SessionState> => ({
    hookAt: at, ...(side === 'source' ? { endedAt: at } : {}), promptId: `${side}-prompt`, prompts: { [`${side}-hash`]: `${side}-prompt` },
    transcript: pointer(`/${side}.jsonl`), siblings: { [`/${side}-agent.jsonl`]: pointer(`/${side}-agent.jsonl`) },
    contextAsks: withAsk(undefined, { kind: 'prompt', text: side, at }), renderedAsk: `${side}-marker`, startedAt: at, planTagCount: at,
    attachmentKeys: [side], delivered: [`cortex:${side}`], promptBackfill: { transcriptPath: `/${side}.jsonl`, at }, turn: { id: `${side}-turn`, promptId: `${side}-opener` },
  });
  /** What a path must persist: the reconciled state, as the state writer stores it. */
  function expected(target: SessionState, from: SessionState): Omit<SessionState, 'updatedAt'> {
    const dir = scratch();
    writeSessionStateUnlocked(dir, sessionId, reconciled(target, from).state);
    const { updatedAt: _, ...rest } = readSessionState(dir, sessionId);
    return rest;
  }
  const persisted = (dir: string): Omit<SessionState, 'updatedAt'> => {
    const { updatedAt: _, ...rest } = readSessionState(dir, sessionId);
    return rest;
  };

  function heldRig() {
    const run = scratch();
    const mycoHome = path.join(run, 'myco');
    const root = path.join(run, 'repo');
    fs.mkdirSync(root);
    const repo = { root, rootKey: rootKeyFor(root, mycoHome), serverUrl: SERVER_URL };
    const live = new MemberSpool({ serverUrl: SERVER_URL, projectId: PROJECT_ID }, { mycoHome });
    const held = pendingSpool(repo, { mycoHome, now: 1 })!;
    const event = sessionStartEvent({ agent: 'claude-code', sessionId, stage: held.stagerFor(sessionId), now: () => 1 }, { startedAt: 1, originPath: root });
    appendPending(repo, sessionId, [event], (s) => Object.assign(s, rich('source', 100)), { mycoHome, now: 1 });
    updateSessionState(live.dir, sessionId, (s) => Object.assign(s, rich('target', 200)));
    return { mycoHome, repo, live, held };
  }

  it('restores held receipts as the reconciled state, and restoring again changes nothing', () => {
    const r = heldRig();
    const want = expected(readSessionState(r.live.dir, sessionId), readSessionState(r.held.dir, sessionId));
    restoreHeldReceiptsForHook(r.repo.root, sessionId, r.live, { mycoHome: r.mycoHome, now: 1 });
    expect(persisted(r.live.dir)).toEqual(want);
    restoreHeldReceiptsForHook(r.repo.root, sessionId, r.live, { mycoHome: r.mycoHome, now: 2 });
    expect(persisted(r.live.dir)).toEqual(want);
    expect(holdsTail(readSessionState(r.live.dir, sessionId), 201)).toBe(true);
  });

  it('moves held capture as the reconciled state', () => {
    const r = heldRig();
    const want = expected(readSessionState(r.live.dir, sessionId), readSessionState(r.held.dir, sessionId));
    expect(flushPendingForRoot(r.repo.root, r.live, { mycoHome: r.mycoHome, now: 1 })).toBe(1);
    expect(persisted(r.live.dir)).toEqual(want);
  });

  it('migrates a legacy session as the reconciled state, and a retry changes nothing', () => {
    const run = scratch();
    const mycoHome = path.join(run, 'myco');
    const route = { serverUrl: SERVER_URL, projectId: PROJECT_ID };
    const legacy = new MemberSpool(null, { dir: legacySpoolDir(PROJECT_ID, mycoHome), mycoHome });
    const target = new MemberSpool(route, { mycoHome });
    expect(assignLegacySpoolDestination(route, mycoHome).status).toBe('assigned');
    updateSessionState(legacy.dir, sessionId, (s) => Object.assign(s, rich('source', 100)));
    updateSessionState(target.dir, sessionId, (s) => Object.assign(s, rich('target', 200)));
    const want = expected(readSessionState(target.dir, sessionId), readSessionState(legacy.dir, sessionId));
    expect(migrateLegacySpool(route, mycoHome, 1)).toMatchObject({ status: 'migrated', contextSkipped: 2 });
    expect(persisted(target.dir)).toEqual(want);
    updateSessionState(target.dir, sessionId, () => {});
    expect(migrateLegacySpool(route, mycoHome, 2)).toMatchObject({ status: 'migrated', contextSkipped: 0 });
    expect(persisted(target.dir)).toEqual(want);
  });
});
