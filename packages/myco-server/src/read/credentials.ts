import type { RelationalStore } from '../core/adapters.js';
import { clampLimit, decodeCursor, page, type Page } from './scope.js';

export interface CredentialRow {
  id: string;
  /** The member this credential belongs to. */
  memberId: string;
  machineId: string | null;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  bytesWritten: number;
  predecessorId: string | null;
  lineageRoot: string;
  lineageStartedAt: number;
  firstUsedAt: number | null;
}

export interface ActivityRow {
  eventId: string;
  projectId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  receivedAt: number;
}

/** The Deployment's credentials, newest lineage first, one page at a time over `idx_member_credentials_started`. The token hash is never selected — nothing outside authentication reads it. */
export async function listCredentials(db: RelationalStore, opts: { limit?: number; cursor?: string } = {}): Promise<Page<CredentialRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const where = after ? `WHERE (lineage_started_at < ? OR (lineage_started_at = ? AND id < ?))` : '';
  const sql = `SELECT id, member_id, machine_id, expires_at, revoked_at, revoked_by, bytes_written, predecessor_id, lineage_root, lineage_started_at, first_used_at
                 FROM member_credentials ${where} ORDER BY lineage_started_at DESC, id DESC LIMIT ?`;
  const statement = after ? db.prepare(sql).bind(after.createdAt, after.createdAt, after.id, limit + 1) : db.prepare(sql).bind(limit + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows = results.map((r) => ({
    id: r.id as string,
    memberId: r.member_id as string,
    machineId: (r.machine_id as string | null) ?? null,
    expiresAt: r.expires_at as number,
    revokedAt: (r.revoked_at as number | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    bytesWritten: r.bytes_written as number,
    predecessorId: (r.predecessor_id as string | null) ?? null,
    lineageRoot: r.lineage_root as string,
    lineageStartedAt: r.lineage_started_at as number,
    firstUsedAt: (r.first_used_at as number | null) ?? null,
  }));
  return page(rows, limit, (r) => ({ createdAt: r.lineageStartedAt, id: r.id }));
}

/** What one credential wrote across every Project, newest first, over `idx_events_token_only (token_id, created_at, event_id)`. */
export async function credentialActivity(db: RelationalStore, tokenId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Page<ActivityRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const where = after ? `AND (created_at < ? OR (created_at = ? AND event_id < ?))` : '';
  const sql = `SELECT event_id, project_id, session_id, kind, created_at, received_at FROM events
                WHERE token_id = ? ${where}
                ORDER BY created_at DESC, event_id DESC LIMIT ?`;
  const statement = after
    ? db.prepare(sql).bind(tokenId, after.createdAt, after.createdAt, after.id, limit + 1)
    : db.prepare(sql).bind(tokenId, limit + 1);
  const { results } = await statement.all<Record<string, unknown>>();
  const rows = results.map((r) => ({
    eventId: r.event_id as string,
    projectId: r.project_id as string,
    sessionId: r.session_id as string,
    kind: r.kind as string,
    createdAt: r.created_at as number,
    receivedAt: r.received_at as number,
  }));
  return page(rows, limit, (r) => ({ createdAt: r.createdAt, id: r.eventId }));
}
