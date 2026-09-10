import { isCompactionOrdinal, type SessionContextRequest } from '@goondocks/myco-shared/recall';
import type { HookRun } from './capture.js';
import { readSessionState, type SessionState } from './session-state.js';

/**
 * Whether this session-start is the one a harness fires after compacting the
 * conversation. Claude Code names the cause in `source`; the block served
 * after a compaction is the one thing the hook asks for on it.
 */
export function compactionStart(run: Pick<HookRun, 'agent' | 'input'>): boolean {
  return run.agent === 'claude-code' && run.input.raw.source === 'compact';
}

/** Applied under the spool append lock by the hook that observes a compaction, before the block for it is asked for. */
export function recordCompaction(state: SessionState): void {
  const next = state.compactionOrdinal + 1;
  if (!isCompactionOrdinal(next)) throw new Error('session compaction ordinal is invalid');
  state.compactionOrdinal = next;
}

export function sessionContextRequest(run: HookRun, remote?: string): SessionContextRequest | undefined {
  const named = remote === undefined || remote.length === 0 ? {} : { remote };
  if (!compactionStart(run)) return { sessionId: run.sessionId, kind: 'start', ...named };
  const compaction = readSessionState(run.spool.dir, run.sessionId).compactionOrdinal;
  if (!isCompactionOrdinal(compaction)) {
    process.stderr.write('[myco] session-start: recall skipped (no recorded compaction ordinal)\n');
    return undefined;
  }
  return { sessionId: run.sessionId, kind: 'compact', compaction, ...named };
}
