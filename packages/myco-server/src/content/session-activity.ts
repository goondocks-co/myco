/**
 * A session's activity: tool calls that did not succeed, read from its newest page chunks, at most `REQUEST_CHUNKS` a
 * request, and the sessions related to it by a parent edge, read from the catalog a page at a time. The two streams
 * continue independently: the cursor is `<chunk cursor>|<edge cursor>`, and an empty part names a stream read through.
 */
import type { ContentStore } from '../core/adapters.js';
import { clampLimit, decodeCursor, page, type Page, type ReadScope } from '../read/scope.js';
import { sessionEdges, type SessionActivityOptions, type SessionActivityRow } from '../read/session-activity.js';
import { SESSION_OWNER } from './document.js';
import { pageCursor, readPageCursor, REQUEST_CHUNKS, SessionDocument } from './session-pages.js';

const REASON_DETAILS: Readonly<Record<string, string>> = {
  reported: 'Tool reported a failure',
  no_result: 'No result captured',
  pending_limit: 'Pending tool call limit reached',
};
const NO_RESULT = new Set(['no_result', 'pending_limit']);

export async function documentSessionActivity(env: ContentStore, scope: ReadScope, sessionId: string,
  opts: SessionActivityOptions): Promise<(Page<SessionActivityRow> & { tools: string[] }) | 'stale' | null> {
  const split = opts.cursor === undefined ? -1 : opts.cursor.indexOf('|');
  if (opts.cursor !== undefined && split < 0) return null;
  const toolCursor = opts.cursor === undefined ? undefined : opts.cursor.slice(0, split);
  const edgeCursor = opts.cursor === undefined ? undefined : opts.cursor.slice(split + 1);
  if (edgeCursor !== undefined && edgeCursor !== '' && decodeCursor(edgeCursor) === null) return null;
  const doc = await SessionDocument.open(env, scope.projectId, sessionId);
  const rows: SessionActivityRow[] = [];
  const tools = new Set<string>();
  let nextTools: string | null = null;
  const toolTypes = opts.type === undefined || opts.type === 'failure' || opts.type === 'no_result';
  if (doc !== null && toolTypes && opts.failed !== false && toolCursor !== '') {
    const at = readPageCursor(toolCursor, doc.generation);
    if (at === null || at === 'stale') return at;
    const read = await doc.chunksBefore(at.at < 0 ? Number.MAX_SAFE_INTEGER : at.at, REQUEST_CHUNKS);
    for (const chunk of read.chunks) {
      for (const page of chunk.pages) {
        for (const record of page.records) {
          if (record.k !== 'tool' || record.success !== 0) continue;
          const reason = typeof record.result_reason === 'string' ? record.result_reason : null;
          const type = reason !== null && NO_RESULT.has(reason) ? 'no_result' : 'failure';
          const toolName = typeof record.tool_name === 'string' ? record.tool_name : 'unknown';
          tools.add(toolName);
          if ((opts.type !== undefined && opts.type !== type) || (opts.tool !== undefined && opts.tool !== toolName)) continue;
          const placed = page.owner === SESSION_OWNER ? null : record.prompt_id;
          rows.push({
            id: record.id, type, title: reason === null ? 'Tool call did not succeed' : toolName,
            detail: [reason === null ? 'Reason not recorded' : REASON_DETAILS[reason] ?? reason, placed === null ? 'Not placed on a turn' : null].filter(Boolean).join(' · '),
            at: record.created_at, promptId: placed, toolName, resultReason: reason as SessionActivityRow['resultReason'], failed: true, sessionId: null, agent: null,
          });
        }
      }
    }
    if (read.more) nextTools = pageCursor(doc.generation, read.chunks.at(-1)!.chunkNo);
  }
  let nextEdges: string | null = null;
  if (opts.tool === undefined && opts.failed !== true && edgeCursor !== '') {
    const limit = clampLimit(opts.limit);
    const edges = page(await sessionEdges(env.db, scope, sessionId, { type: opts.type, limit, cursor: edgeCursor }), limit,
      (row) => ({ createdAt: row.at, id: row.id }));
    rows.push(...edges.rows);
    nextEdges = edges.cursor;
  }
  rows.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const cursor = nextTools === null && nextEdges === null ? null : `${nextTools ?? ''}|${nextEdges ?? ''}`;
  return { rows, cursor, tools: [...tools].sort() };
}
