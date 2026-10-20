/**
 * The one place two states of one session are combined: a held or legacy spool's state (the source) folded into the
 * state the session's own spool holds (the target). Every field of `SessionState` is decided by exactly one declared
 * rule; fields that must agree with each other are decided together by one composite rule.
 *
 * What protects captured data or identity is carried: transcript pointers, prompt ids, the turn claim and the
 * session's lifecycle. Hook-side context (asks, a cached answer and its render marker) is not: the source's is dropped
 * and counted, and the session's next prompt asks again.
 */
import {
  emptySessionState, mergedTurn, readSessionStateResult, readSessionStateResultUnlocked,
  type SessionState, type SessionStateRefusal,
} from './session-state.js';

const sourceState: unique symbol = Symbol('sourceState');
/**
 * Another spool's state for a session, read only to be reconciled into the session's own spool, with the context
 * items its read discarded for naming no ask id. The count is keyed by a symbol, so no field rule or serialization
 * sees it.
 */
export type SourceSessionState = SessionState & { readonly [sourceState]: { contextDiscarded: number } };

export type SourceStateRead =
  | { ok: true; state: SourceSessionState; found: boolean }
  | { ok: false; reason: Exclude<SessionStateRefusal, 'missing'>; detail?: string };

/**
 * The only reader of another spool's session state. A missing state reads as an empty one (`found: false`); any other
 * refusal is returned. `lock` says whether the caller already holds the session's buffer lock in `spoolDir`.
 */
export function readSourceStateForMove(spoolDir: string, sessionId: string, lock: 'held' | 'take'): SourceStateRead {
  const read = lock === 'held' ? readSessionStateResultUnlocked(spoolDir, sessionId) : readSessionStateResult(spoolDir, sessionId);
  if (read.ok) return { ok: true, state: Object.assign(read.state, { [sourceState]: { contextDiscarded: read.contextDiscarded ?? 0 } }), found: true };
  if (read.reason === 'missing') return { ok: true, state: emptySource(), found: false };
  return { ok: false, reason: read.reason, detail: read.detail };
}

const emptySource = (): SourceSessionState => Object.assign(emptySessionState(0), { [sourceState]: { contextDiscarded: 0 } });

type ScalarRule = 'meta' | 'target' | 'targetElseSource' | 'union' | 'max' | 'min' | 'or';
type CompositeRule = 'context' | 'lifecycle' | 'pointers' | 'turnClaim';
export type SessionFieldRule = ScalarRule | CompositeRule;

/** Each state field's merge rule. A field with no rule fails the type check here. */
export const SESSION_FIELD_RULES = {
  // Written by the target's own writer.
  version: 'meta', updatedAt: 'meta', pendingLosses: 'meta',
  // Count in the target spool's own journal, marks file and retry waits.
  highWater: 'target', markWater: 'target', markGeneration: 'target',
  eventRetry: 'target', transcriptRetry: 'target', agentUnknown: 'target',
  contextAsks: 'context', renderedAsk: 'context',
  hookAt: 'lifecycle', endedAt: 'lifecycle',
  promptId: 'targetElseSource', agent: 'targetElseSource', promptBackfill: 'targetElseSource',
  startSettled: 'or', startedAt: 'min', planTagCount: 'max', compactionOrdinal: 'max',
  // Report instants: shown, never used to order anything.
  lastAckAt: 'max', lastAccountedAt: 'max', lastDeliveryAt: 'max',
  prompts: 'union', planHashes: 'union', planPaths: 'union', attachmentKeys: 'union',
  // Only ever suppresses a second render of a block.
  delivered: 'union',
  transcript: 'pointers', continuations: 'pointers', siblings: 'pointers',
  turn: 'turnClaim',
} as const satisfies { [K in keyof SessionState]-?: SessionFieldRule };

type FieldsRuled<R extends SessionFieldRule> = {
  [K in keyof SessionState]-?: (typeof SESSION_FIELD_RULES)[K] extends R ? K : never
}[keyof SessionState];

/** Every field a composite rule decides, each named, present or not. */
type Decided<R extends CompositeRule> = { [K in FieldsRuled<R>]-?: SessionState[K] | undefined };

const extreme = (pick: (a: number, b: number) => number, a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : pick(a, b);

/** A session is open on a side that saw a hook and no end since. */
const open = (state: SessionState): boolean => state.hookAt !== undefined && state.endedAt === undefined;

const SCALAR_RULES: { [R in ScalarRule]: (target: unknown, source: unknown) => unknown } = {
  meta: (target) => target,
  target: (target) => target,
  targetElseSource: (target, source) => target ?? source,
  // Entries the target holds win; the source's first, so trimming drops the oldest.
  union: (target, source) => Array.isArray(target)
    ? [...new Set([...(source as unknown[]), ...target])]
    : { ...(source as object), ...(target as object) },
  max: (target, source) => extreme(Math.max, target as number | undefined, source as number | undefined),
  min: (target, source) => extreme(Math.min, target as number | undefined, source as number | undefined),
  or: (target, source) => (target === true || source === true ? true : undefined),
};

export const SESSION_COMPOSITE_RULES = {
  /** The target's own asks and render marker stand; the source's are dropped. */
  context: (target) => ({ contextAsks: target.contextAsks, renderedAsk: target.renderedAsk }),
  /**
   * Ended only when every side that saw a hook has ended; otherwise open, with the later hook, so the transcript tail
   * is held until the idle timeout.
   */
  lifecycle: (target, source) => ({
    hookAt: extreme(Math.max, target.hookAt, source.hookAt),
    endedAt: open(target) || open(source) ? undefined : target.endedAt ?? source.endedAt,
  }),
  /**
   * The target's transcript stands, else the source's; a source transcript at another path becomes a continuation,
   * unless the target already holds one there.
   */
  pointers: (target, source) => {
    const sourcePrimary = source.transcript !== undefined && target.transcript !== undefined && source.transcript.path !== target.transcript.path
      ? { [source.transcript.path]: source.transcript } : {};
    // A continuation the target already holds at that path keeps its own progress and refusal.
    const continuations = { ...source.continuations, ...sourcePrimary, ...target.continuations };
    return {
      transcript: target.transcript ?? source.transcript,
      continuations: Object.keys(continuations).length === 0 ? undefined : continuations,
      siblings: { ...source.siblings, ...target.siblings },
    };
  },
  turnClaim: (target, source) => ({ turn: mergedTurn(target.turn, source.turn) }),
} satisfies { [R in CompositeRule]: (target: SessionState, source: SessionState) => Decided<R> };

const isComposite = (rule: SessionFieldRule): rule is CompositeRule => rule in SESSION_COMPOSITE_RULES;

/** The source's hook-side context dropped: each ask and its render marker, and what its read discarded. */
const contextDropped = (source: SourceSessionState): number =>
  (source.contextAsks?.length ?? 0) + (source.renderedAsk === undefined ? 0 : 1) + (source[sourceState]?.contextDiscarded ?? 0);

/**
 * `source` folded into `target` by each field's rule, as a new state; neither input is changed. `contextSkipped` counts
 * the source's context that was dropped, including what its read discarded.
 */
export function reconcileSessionState(target: SessionState, source: SourceSessionState): { state: SessionState; contextSkipped: number } {
  const decided: Record<string, unknown> = {};
  for (const rule of new Set(Object.values(SESSION_FIELD_RULES))) {
    if (isComposite(rule)) Object.assign(decided, SESSION_COMPOSITE_RULES[rule](target, source));
  }
  const fields = target as unknown as Record<string, unknown>;
  const sources = source as unknown as Record<string, unknown>;
  for (const [field, rule] of Object.entries(SESSION_FIELD_RULES)) {
    if (!isComposite(rule)) decided[field] = SCALAR_RULES[rule](fields[field], sources[field]);
  }
  for (const [field, value] of Object.entries(decided)) if (value === undefined) delete decided[field];
  return { state: decided as unknown as SessionState, contextSkipped: contextDropped(source) };
}
