/**
 * Every field of a session's state merges by one rule (`SESSION_STATE_MERGE`) when another state of the same session
 * joins it: a repository's held capture adopted into its Project's spool, and a legacy spool migrated. The table is
 * typed over every key of `SessionState`, so a field added without a rule fails to compile there, and the full-state
 * fixture below, typed `Required<SessionState>`, fails to compile here until its rule is pinned.
 */
import { describe, expect, it } from 'bun:test';
import { mergeHeldState } from '@myco/member/pending.js';
import { mergeSessionState, SESSION_STATE_MERGE, type SessionState } from '@myco/member/session-state.js';

const pointer = (path: string) => ({ path, transcriptId: `tx-${path}`, inode: 1, nextOffset: 10, parsedSize: 10 });

/** A state holding every field, its values marking which state they came from. */
function full(side: 'target' | 'other', n: number): Required<SessionState> {
  return {
    version: 1, highWater: n, markWater: n, markGeneration: side, startSettled: true, promptId: `${side}-prompt`,
    prompts: { [side]: side, both: side }, transcript: pointer(`${side}.jsonl`), continuations: { [`${side}-old.jsonl`]: pointer(`${side}-old.jsonl`) },
    siblings: { [side]: pointer(`${side}-sub.jsonl`) }, planHashes: { [side]: side, both: side }, planTagCount: n,
    planPaths: { [side]: { planKey: side, hash: side } }, attachmentKeys: [side, 'both'], delivered: [side, 'both'], compactionOrdinal: n,
    agent: side, agentUnknown: true, transcriptRetry: { at: n, backoffMs: n }, eventRetry: { at: n, backoffMs: n }, startedAt: n,
    lastAckAt: n, lastAccountedAt: n, lastDeliveryAt: n,
    contextAsks: [{ kind: 'prompt', text: side, at: n }, ...(side === 'other' ? [{ kind: 'start' as const, at: n }] : [])],
    promptBackfill: { transcriptPath: side, at: n }, hookAt: n, endedAt: n, renderedAsk: n, turn: { id: `${side}-turn`, promptId: side },
    updatedAt: n, pendingLosses: [{ key: side, kind: 'record', at: n }],
  };
}

describe('merging two states of one session', () => {
  it('names a rule for every field: what the target recorded stands, and what only the other recorded is added', () => {
    const target = full('target', 1);
    const other = full('other', 2);
    mergeSessionState(target, other);
    expect(Object.keys(SESSION_STATE_MERGE).sort()).toEqual(Object.keys(full('target', 1)).sort());
    expect(target).toEqual({
      version: 1, highWater: 1, markWater: 1, markGeneration: 'target', startSettled: true, promptId: 'target-prompt',
      prompts: { other: 'other', target: 'target', both: 'target' }, transcript: pointer('target.jsonl'),
      continuations: { 'other-old.jsonl': pointer('other-old.jsonl'), 'target-old.jsonl': pointer('target-old.jsonl'), 'other.jsonl': pointer('other.jsonl') },
      siblings: { other: pointer('other-sub.jsonl'), target: pointer('target-sub.jsonl') }, planHashes: { other: 'other', target: 'target', both: 'target' },
      planTagCount: 2, planPaths: { other: { planKey: 'other', hash: 'other' }, target: { planKey: 'target', hash: 'target' } },
      attachmentKeys: ['other', 'both', 'target'], delivered: ['other', 'both', 'target'], compactionOrdinal: 2, agent: 'target', agentUnknown: true,
      transcriptRetry: { at: 1, backoffMs: 1 }, eventRetry: { at: 1, backoffMs: 1 }, startedAt: 1, lastAckAt: 2, lastAccountedAt: 2, lastDeliveryAt: 2,
      contextAsks: [{ kind: 'prompt', text: 'other', at: 2 }, { kind: 'start', at: 2 }], promptBackfill: { transcriptPath: 'target', at: 1 },
      hookAt: 2, endedAt: 1, renderedAsk: 2, turn: { id: 'target-turn', promptId: 'target' }, updatedAt: 1, pendingLosses: [{ key: 'target', kind: 'record', at: 1 }],
    });
  });

  it('takes what only the held state recorded when a repository joins, the asks it still owes and the answer it rendered included', () => {
    const target: SessionState = { ...full('target', 1) };
    for (const key of ['contextAsks', 'renderedAsk', 'turn', 'promptId', 'startedAt'] as const) delete target[key];
    mergeHeldState(target, full('other', 2));
    expect({ asks: target.contextAsks, rendered: target.renderedAsk, turn: target.turn, promptId: target.promptId, startedAt: target.startedAt }).toEqual({
      asks: [{ kind: 'prompt', text: 'other', at: 2 }, { kind: 'start', at: 2 }], rendered: 2, turn: { id: 'other-turn', promptId: 'other' }, promptId: 'other-prompt', startedAt: 2,
    });
  });
});
