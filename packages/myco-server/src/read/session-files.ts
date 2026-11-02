import type { RelationalStore } from '../core/adapters.js';
import { liveGenerationSql } from './document-catalog.js';
import { clampLimit, decodeCursor, encodeCursor, type ReadScope } from './scope.js';

export async function sessionFiles(db: RelationalStore, scope: ReadScope, sessionId: string,
  opts: { kind: 'edited' | 'read' | 'all'; cursor?: string; limit?: number }) {
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  const limit = clampLimit(opts.limit);
  const filter = opts.kind === 'all' ? '' : opts.kind === 'edited' ? 'AND edits>0' : 'AND edits=0';
  const { results } = await db.prepare(`SELECT path,tool_calls,edits,last_turn FROM session_paths
    WHERE project_id=?1 AND session_id=?2 AND generation=${liveGenerationSql('?1', '?2')}
      ${after === null ? '' : 'AND path>?4'} ${filter}
    ORDER BY path LIMIT ?3`).bind(scope.projectId, sessionId, limit + 1, ...(after === null ? [] : [after.id]))
    .all<{ path: string; tool_calls: number; edits: number; last_turn: string | null }>();
  const capped = await db.prepare(`SELECT paths_capped FROM session_documents
    WHERE project_id=? AND session_id=? AND state='live'`).bind(scope.projectId, sessionId).first<{ paths_capped: number }>();
  const files = results.slice(0, limit).map(row => ({ path: row.path, calls: row.tool_calls, edits: row.edits, lastTurn: row.last_turn }));
  return { files, nextCursor: results.length > limit ? encodeCursor(0, files.at(-1)!.path) : null,
    capped: capped?.paths_capped === 1, shellEditsUnseen: true as const };
}
