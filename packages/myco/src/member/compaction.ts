import { isCompactionOrdinal, type SessionContextRequest } from '@goondocks/myco-shared/recall';
import type { HookRun } from './capture.js';
import { readSessionState, type SessionState } from './session-state.js';

/** Applied under the spool append lock alongside the PreCompact event. */
export function recordCompaction(state: SessionState): void {
  const next = state.compactionOrdinal + 1;
  if (!isCompactionOrdinal(next)) throw new Error('session compaction ordinal is invalid');
  state.compactionOrdinal = next;
}

export function sessionContextRequest(run: HookRun): SessionContextRequest | undefined {
  if (run.agent !== 'claude-code' || run.input.raw.source !== 'compact') return { sessionId: run.sessionId, kind: 'start' };
  const compaction = readSessionState(run.spool.dir, run.sessionId).compactionOrdinal;
  if (!isCompactionOrdinal(compaction)) {
    process.stderr.write('[myco] session-start: recall skipped (no recorded PreCompact ordinal)\n');
    return undefined;
  }
  return { sessionId: run.sessionId, kind: 'compact', compaction };
}
