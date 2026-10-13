/**
 * Session-continuation lineage over a parsed transcript: which predecessor a
 * continuation transcript names, why, and which records are the continuing
 * session's own. A leaf (`utils/dot-path` only) shared by the transcript
 * miner and the member's session-start hook.
 */
import type { SessionContinuation } from '../symbionts/manifest-schema.js';
import { getAtPath } from '../utils/dot-path.js';

/**
 * The predecessor a continuation transcript names, and the reason.
 *
 * The boundary is the LAST record naming a different session id (an agent
 * stamps the predecessor id on records written before the switch). Markers
 * only label the result: a marker counts when it sits on a record naming the
 * SAME predecessor the boundary resolved to; one naming an older ancestor is
 * describing an earlier continuation and is ignored.
 */
export function findSessionContinuation(
  declaration: SessionContinuation,
  sessionId: string,
  events: ReadonlyArray<Record<string, unknown>>,
): { parentId: string; reason: string } | null {
  const parentIdOf = (event: Record<string, unknown>): string | null => {
    const value = getAtPath(event, declaration.parentSessionIdPath);
    if (typeof value !== 'string' || value.length === 0) return null;
    return value === sessionId ? null : value;
  };

  let parentId: string | null = null;
  for (const event of events) {
    parentId = parentIdOf(event) ?? parentId;
  }
  if (!parentId) return null;

  for (const marker of declaration.markers) {
    for (const event of events) {
      if (getAtPath(event, marker.recordFlagPath) !== true) continue;
      if (parentIdOf(event) !== parentId) continue;
      return { parentId, reason: marker.reason };
    }
  }
  return { parentId, reason: declaration.defaultReason };
}

/**
 * The records that are THIS session's own turns: everything after the last
 * record naming a predecessor, plus every marker record wherever it sits.
 */
export function eventsOwnedBySession(
  declaration: SessionContinuation,
  sessionId: string,
  events: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  let boundary = -1;
  events.forEach((event, index) => {
    const value = getAtPath(event, declaration.parentSessionIdPath);
    if (typeof value === 'string' && value.length > 0 && value !== sessionId) boundary = index;
  });
  if (boundary < 0) return [...events];
  return events.filter((event, index) =>
    index > boundary
    || declaration.markers.some((marker) => getAtPath(event, marker.recordFlagPath) === true));
}
