import type { RelationalStore } from '../core/adapters.js';
import { clampLimit, decodeCursor, page, type Page, type ReadScope } from './scope.js';

export interface TokenRow {
  id: string;
  machineId: string | null;
  expiresAt: number;
  revokedAt: number | null;
  bytesWritten: number;
  predecessorId: string | null;
  lineageRoot: string | null;
  lineageStartedAt: number | null;
  firstUsedAt: number | null;
}

export interface ActivityRow {
  eventId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  receivedAt: number;
}

/** Every token minted for the scope's project. The token hash is never selected — nothing outside authentication reads it. */
export async function listTokens(db: RelationalStore, scope: ReadScope): Promise<TokenRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, machine_id, expires_at, revoked_at, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at
         FROM member_tokens WHERE project_id = ? ORDER BY lineage_started_at DESC, id DESC`
    )
    .bind(scope.projectId)
    .all<Record<string, unknown>>();
  return results.map((r) => ({
    id: r.id as string,
    machineId: (r.machine_id as string | null) ?? null,
    expiresAt: r.expires_at as number,
    revokedAt: (r.revoked_at as number | null) ?? null,
    bytesWritten: r.bytes_written as number,
    predecessorId: (r.predecessor_id as string | null) ?? null,
    lineageRoot: (r.lineage_root as string | null) ?? null,
    lineageStartedAt: (r.lineage_started_at as number | null) ?? null,
    firstUsedAt: (r.first_used_at as number | null) ?? null,
  }));
}

/** What one token wrote, newest first, over `idx_events_token (project_id, token_id, created_at)`. */
export async function tokenActivity(db: RelationalStore, scope: ReadScope, tokenId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Page<ActivityRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const where = after ? `AND (created_at < ? OR (created_at = ? AND event_id < ?))` : '';
  const sql = `SELECT event_id, session_id, kind, created_at, received_at FROM events
                WHERE project_id = ? AND token_id = ? ${where}
                ORDER BY created_at DESC, event_id DESC LIMIT ?`;
  const statement = after
    ? db.prepare(sql).bind(scope.projectId, tokenId, after.createdAt, after.createdAt, after.id, limit + 1)
    : db.prepare(sql).bind(scope.projectId, tokenId, limit + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows = results.map((r) => ({
    eventId: r.event_id as string,
    sessionId: r.session_id as string,
    kind: r.kind as string,
    createdAt: r.created_at as number,
    receivedAt: r.received_at as number,
  }));
  return page(rows, limit, (r) => ({ createdAt: r.createdAt, id: r.eventId }));
}
