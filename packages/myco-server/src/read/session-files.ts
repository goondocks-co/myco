import type { RelationalStore } from '../core/adapters.js';
import { sessionPathPage, type PathKind } from '../db/documents/session-paths.js';
import { clampLimit, decodeCursor, encodeCursor, type ReadScope } from './scope.js';

export async function sessionFiles(db: RelationalStore, scope: ReadScope, sessionId: string,
  opts: { kind: PathKind; cursor?: string; limit?: number }) {
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  const limit = clampLimit(opts.limit);
  const { rows, capped } = await sessionPathPage(db, { project: scope.projectId, session: sessionId, kind: opts.kind, after: after?.id ?? null, limit: limit + 1 });
  const files = rows.slice(0, limit).map(row => ({ path: row.path, calls: row.tool_calls, edits: row.edits, lastTurn: row.last_turn }));
  return { files, nextCursor: rows.length > limit ? encodeCursor(0, files.at(-1)!.path) : null,
    capped, shellEditsUnseen: true as const };
}
