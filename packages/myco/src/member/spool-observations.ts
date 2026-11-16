import fs from 'node:fs';
import path from 'node:path';
import type { MemberSpool } from './spool.js';
import { REFUSED_LOG_FILE } from './spool.js';
import { assertMemberPathContained, pathIsAbsent } from './store.js';
import { readSessionStateResult, type SessionStateRead } from './session-state.js';

/** A report retains unreadable sessions as unknown depth and admits every path before reading. */
export function observeSpool(spool: MemberSpool, options: { createReadLocks?: boolean } = {}): { readable: boolean; sessions: Array<{ sessionId: string; unacknowledged: number | null }> } {
  try { assertMemberPathContained(spool.dir, spool.mycoHome); }
  catch { return { readable: false, sessions: [] }; }
  let names: string[];
  try {
    names = fs.readdirSync(spool.dir).filter((name) => name.endsWith('.jsonl'));
  } catch (err) {
    // A spool a member has not written yet is empty, not unreadable — and
    // absence is the directory's own, so a link to nothing, or a directory
    // the listing lost, is a spool that could not be read.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(spool.dir)) return { readable: true, sessions: [] };
    return { readable: false, sessions: [] };
  }
  const refusedLog = path.basename(REFUSED_LOG_FILE, '.jsonl');
  const sessions = names
    .map((name) => path.basename(name, '.jsonl'))
    .filter((sessionId) => sessionId !== refusedLog)
    .map((sessionId) => {
      const read = spool.readRecordsOrNull(sessionId);
      if (!read.readable) return { sessionId, unacknowledged: null };
      // The count is records against the acknowledged mark, so a state the
      // report cannot use leaves it unknown rather than counting from zero.
      let state: SessionStateRead;
      try {
        state = readSessionStateResult(spool.dir, sessionId, { createLock: options.createReadLocks });
      } catch {
        return { sessionId, unacknowledged: null };
      }
      if (!state.ok) return { sessionId, unacknowledged: state.reason === 'missing' ? read.records.length : null };
      return { sessionId, unacknowledged: Math.max(0, read.records.length - state.state.highWater) };
    });
  return { readable: true, sessions };
}
