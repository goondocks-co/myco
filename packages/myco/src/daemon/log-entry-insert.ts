/**
 * The single seam that maps a logger `LogEntry` (or a parsed JSONL buffer
 * line) to a `LogEntryInsert`. Both the live persist path (the daemon
 * logger's persistFn) and the buffer-replay path (`reconcileLogBuffer`)
 * resolve a log row's `project_id` here, so there is exactly one rule for it.
 *
 * The rule: a daemon log row carries the entry's own explicit `project_id`
 * when it has one, else the daemon's resolved fallback. The fallback is NULL
 * for the groveless daemon anchor — daemon-owned rows belong to the
 * `project_id IS NULL` (`GLOBAL_SCOPE`) partition, NEVER the phantom
 * `_unbound-bootstrap` project id. Callers compute the fallback via
 * `rowProjectIdFromRequestContext(...)`, which yields NULL for a groveless
 * context, so the phantom id can never reach the data plane through logging.
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
