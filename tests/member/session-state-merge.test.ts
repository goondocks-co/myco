/**
 * A session's state merges concern by concern (`CONCERN_MERGE`) when another state of the same session joins it: a
 * repository's held capture adopted into its Project's spool, and a legacy spool migrated. Every field belongs to one
 * concern (`FIELD_CONCERN`, typed over every key of `SessionState`, so a field added without one fails to compile), and
 * the full-state fixture below, typed `Required<SessionState>`, fails to compile here until the field is pinned.
 */
import { describe, expect, it } from 'bun:test';
import { CONCERN_MERGE, mergeSessionState, type SessionState } from '@myco/member/session-state.js';

const pointer = (path: string) => ({ path, transcriptId: `tx-${path}`, inode: 1, nextOffset: 10, parsedSize: 10 });
const NONE = { keptAnswerAsk: undefined };

/** A state holding every field, its values marking which state they came from; `n` dates its facts. */
function full(side: 'target' | 'other', n: number): Required<SessionState> {
  return {
    version: 1, highWater: n, markWater: n, markGeneration: side, startSettled: true, promptId: `${side}-prompt`,
    prompts: { [side]: side, both: side }, transcript: pointer(`${side}.jsonl`), continuations: { [`${side}-old.jsonl`]: pointer(`${side}-old.jsonl`) },
    siblings: { [side]: pointer(`${side}-sub.jsonl`) }, planHashes: { [side]: side, both: side }, planTagCount: n,
    planPaths: { [side]: { planKey: side, hash: side } }, attachmentKeys: [side, 'both'], delivered: [side, 'both'], compactionOrdinal: n,
    agent: side, agentUnknown: true, transcriptRetry: { at: n, backoffMs: n }, eventRetry: { at: n, backoffMs: n }, startedAt: n,
    lastAckAt: n, lastAccountedAt: n, lastDeliveryAt: n,
    contextAsks: [{ kind: 'prompt', text: side, at: n * 100 }, ...(side === 'other' ? [{ kind: 'start' as const, at: n * 100 }] : [])],
    settledAsks: { compact: n }, promptBackfill: { transcriptPath: side, at: n }, hookAt: n, endedAt: n, renderedAsk: n * 10,
    turn: { id: `${side}-turn`, promptId: side }, updatedAt: n, pendingLosses: [{ key: side, kind: 'record', at: n }],
  };
}

const merged = (target: SessionState, other: SessionState, context: { keptAnswerAsk: number | undefined } = NONE): SessionState => {
  const into = structuredClone(target);
  mergeSessionState(into, other, context);
  return into;
};

describe('merging two states of one session, concern by concern', () => {
  it('merges every field of a full state, each by its concern', () => {
    const result = merged(full('target', 1), full('other', 2));
    expect(Object.keys(CONCERN_MERGE).sort()).toEqual(['agent', 'asks', 'blocks', 'clocks', 'journal', 'lifecycle', 'receipts', 'rendered', 'retries', 'start', 'transcripts']);
    expect(result).toEqual({
      // journal: the target's own files and mutation
      version: 1, highWater: 1, markWater: 1, markGeneration: 'target', updatedAt: 1, pendingLosses: [{ key: 'target', kind: 'record', at: 1 }],
      // lifecycle: read from the state that saw the session last (the other, at 2)
      hookAt: 2, endedAt: 2, promptId: 'other-prompt', turn: { id: 'other-turn', promptId: 'other' },
      startSettled: true, startedAt: 1, lastAckAt: 2, lastAccountedAt: 2, lastDeliveryAt: 2,
      transcriptRetry: { at: 1, backoffMs: 1 }, eventRetry: { at: 1, backoffMs: 1 },
      transcript: pointer('target.jsonl'),
      continuations: { 'other-old.jsonl': pointer('other-old.jsonl'), 'target-old.jsonl': pointer('target-old.jsonl'), 'other.jsonl': pointer('other.jsonl') },
      siblings: { other: pointer('other-sub.jsonl'), target: pointer('target-sub.jsonl') }, promptBackfill: { transcriptPath: 'target', at: 1 },
      prompts: { other: 'other', target: 'target', both: 'target' }, planHashes: { other: 'other', target: 'target', both: 'target' },
      planPaths: { other: { planKey: 'other', hash: 'other' }, target: { planKey: 'target', hash: 'target' } }, planTagCount: 2,
      attachmentKeys: ['other', 'both', 'target'], delivered: ['other', 'both', 'target'], compactionOrdinal: 2,
      agent: 'target', agentUnknown: undefined,
      // rendered: no cached answer is kept, so the target's marker stands
      renderedAsk: 10,
      // asks: each kind's newer ask, past what either state settled; a rendered answer settles prompt asks up to it
      contextAsks: [{ kind: 'prompt', text: 'other', at: 200 }, { kind: 'start', at: 200 }], settledAsks: { compact: 2, prompt: 20 },
    } as unknown as SessionState);
  });

  it('ends the session only where its end is the latest lifecycle fact, in either direction', () => {
    const at = (hookAt: number, endedAt?: number): SessionState => ({ ...full('target', 1), hookAt, ...(endedAt === undefined ? { endedAt: undefined } : { endedAt }) });
    const strip = (state: SessionState) => { const copy = { ...state }; if (copy.endedAt === undefined) delete copy.endedAt; return copy; };
    expect(merged(strip(at(200)), strip(at(100, 100))).endedAt).toBeUndefined();
    expect(merged(strip(at(100, 100)), strip(at(200))).endedAt).toBeUndefined();
    expect(merged(strip(at(100)), strip(at(200, 200))).endedAt).toBe(200);
    expect(merged(strip(at(200, 200)), strip(at(100))).endedAt).toBe(200);
  });

  it('marks the cached answer the merged session keeps rendered only where either state rendered that very ask', () => {
    const rendered = (renderedAsk: number | undefined): SessionState => { const state = { ...full('target', 1) } as SessionState; if (renderedAsk === undefined) delete state.renderedAsk; else state.renderedAsk = renderedAsk; return state; };
    expect(merged(rendered(100), rendered(200), { keptAnswerAsk: 100 }).renderedAsk).toBe(100);
    expect(merged(rendered(100), rendered(200), { keptAnswerAsk: 200 }).renderedAsk).toBe(200);
    expect(merged(rendered(undefined), rendered(200), { keptAnswerAsk: 200 }).renderedAsk).toBe(200);
    expect(merged(rendered(100), rendered(150), { keptAnswerAsk: 300 }).renderedAsk).not.toBe(300);
  });

  it('owes no ask at or before what either state settled, or a cached or rendered answer settled', () => {
    const asking = (asks: SessionState['contextAsks'], settledAsks?: SessionState['settledAsks']): SessionState => {
      const state = { ...full('target', 1) } as SessionState;
      delete state.renderedAsk;
      state.contextAsks = asks;
      if (settledAsks === undefined) delete state.settledAsks; else state.settledAsks = settledAsks;
      return state;
    };
    const old = { kind: 'prompt' as const, text: 'old', at: 100 };
    expect(merged(asking(undefined, { prompt: 200 }), asking([old])).contextAsks).toBeUndefined();
    expect(merged(asking(undefined), asking([old]), { keptAnswerAsk: 200 }).contextAsks).toBeUndefined();
    expect(merged(asking(undefined), asking([old]), { keptAnswerAsk: 50 }).contextAsks).toEqual([old]);
    expect(merged(asking([old]), asking(undefined, { prompt: 100 })).contextAsks).toBeUndefined();
  });

  it('takes the latest state\'s prompt and turn, keeps a known agent over an unknown search, and never resurrects a steered turn', () => {
    const later = { ...full('other', 2), turn: { id: 't1' } };
    const earlier = { ...full('target', 1), turn: { id: 't1', promptId: 'opener' } };
    expect(merged(earlier, later)).toMatchObject({ promptId: 'other-prompt', turn: { id: 't1' } });
    expect(merged(later, earlier).turn).toEqual({ id: 't1' });
    const unknown = { ...full('target', 1) } as SessionState;
    delete unknown.agent;
    expect(merged(unknown, { ...full('other', 2), agentUnknown: undefined } as SessionState)).toMatchObject({ agent: 'other' });
    expect(merged(unknown, { ...full('other', 2), agentUnknown: undefined } as SessionState).agentUnknown).toBeUndefined();
  });
});
