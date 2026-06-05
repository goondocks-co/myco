/**
 * Maps a logger `LogEntry` (or a parsed JSONL buffer line) to a
 * `LogEntryInsert`. The live persist path and the buffer-replay path
 * (`reconcileLogBuffer`) both resolve a log row's `project_id` here: the
 * entry's own explicit `project_id` when present, else the caller-supplied
 * fallback (NULL for a groveless context).
 */

import type { LogEntryInsert } from '@myco/db/queries/logs.js';
import { assertGroveProjectId, type GroveProjectId } from '@myco/grove/ids.js';
import { kindToComponent } from '@myco/constants/log-kinds.js';

/**
 * Resolve the `project_id` a daemon log row should carry: the entry's own
 * explicit id when present (validated as a real Grove project id), otherwise
 * the daemon's resolved fallback (NULL for the groveless anchor).
 */
export function resolveLogRowProjectId(
  entryProjectId: unknown,
  fallbackProjectId: GroveProjectId | null,
): GroveProjectId | null {
  return typeof entryProjectId === 'string'
    ? assertGroveProjectId(entryProjectId)
    : fallbackProjectId;
}

/**
 * Map a logger entry (or a parsed JSONL buffer line) to a `LogEntryInsert`.
 * Defensive about `kind`/`component` so a malformed or partial buffered line
 * still replays. `project_id` and `session_id` are lifted to their own
 * columns and excluded from the JSON `data` blob.
 */
export function logEntryToInsert(
  entry: Record<string, unknown>,
  fallbackProjectId: GroveProjectId | null,
): LogEntryInsert {
  const {
    timestamp,
    level,
    kind,
    component,
    message,
    project_id: entryProjectId,
    session_id: entrySessionId,
    ...data
  } = entry;

  const resolvedKind = typeof kind === 'string' && kind.length > 0
    ? kind
    : `${typeof component === 'string' && component.length > 0 ? component : 'unknown'}.unknown`;
  const resolvedComponent = typeof component === 'string' && component.length > 0
    ? component
    : kindToComponent(resolvedKind);

  return {
    timestamp: String(timestamp),
    level: String(level),
    kind: resolvedKind,
    component: resolvedComponent,
    message: typeof message === 'string' ? message : String(message ?? ''),
    data: Object.keys(data).length > 0 ? JSON.stringify(data) : null,
    session_id: typeof entrySessionId === 'string' ? entrySessionId : null,
    project_id: resolveLogRowProjectId(entryProjectId, fallbackProjectId),
  };
}
