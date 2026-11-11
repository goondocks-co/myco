import type { RelationalStore } from '../core/adapters.js';
import { credentialEvents } from '../db/credentials/activity.js';
import { credentialPage } from '../db/identity/credential-pages.js';
import { decodeProjectCursor, projectPage } from './project-cursor.js';
import { clampLimit, decodeCursor, page, type Page } from './scope.js';

/** Whether the credential belongs to an agent run or a member runtime. */
type CredentialPurpose = 'run' | 'member';

export interface CredentialRow {
  id: string;
  /** The member this credential belongs to. */
  memberId: string;
  machineId: string | null;
  /** The name of the machine the credential belongs to: the machine's own, else the name the runtime gave when it joined; null when neither holds one. */
  runtimeLabel: string | null;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  bytesWritten: number;
  predecessorId: string | null;
  lineageRoot: string;
  lineageStartedAt: number;
  firstUsedAt: number | null;
  /** Whether this credential authenticates now: unrevoked, unexpired, and its member live. */
  live: boolean;
  /** Whether the credential belongs to an agent run or a member runtime. */
  purpose: CredentialPurpose;
}

export interface ActivityRow {
  eventId: string;
  projectId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  receivedAt: number;
}

/** The Deployment's credentials, newest lineage first, one page at a time. The token hash is never selected — nothing outside authentication reads it. */
export async function listCredentials(
  db: RelationalStore,
  nowMs: number,
  opts: { limit?: number; cursor?: string; purpose?: CredentialPurpose; memberId?: string; excludedMemberId?: string } = {},
): Promise<Page<CredentialRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const results = await credentialPage(db, { now: nowMs, fetch: limit + 1, after, purpose: opts.purpose, memberId: opts.memberId, excludedMemberId: opts.excludedMemberId });
  const rows = results.map((r): CredentialRow => ({
    id: r.id,
    memberId: r.member_id,
    machineId: r.machine_id,
    runtimeLabel: r.runtime_label,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    revokedBy: r.revoked_by,
    bytesWritten: r.bytes_written,
    predecessorId: r.predecessor_id,
    lineageRoot: r.lineage_root,
    lineageStartedAt: r.lineage_started_at,
    firstUsedAt: r.first_used_at,
    live: r.live === 1,
    purpose: r.run_credential === 1 ? 'run' : 'member',
  }));
  return page(rows, limit, (r) => ({ createdAt: r.lineageStartedAt, id: r.id }));
}

/**
 * What one credential wrote across every Project, newest first, over `idx_events_token_only (token_id, created_at,
 * event_id, project_id)`. An event is keyed by its Project and its id, so the cursor carries both; a cursor this list
 * did not issue reads nothing, and the route refuses it first.
 */
export async function credentialActivity(db: RelationalStore, tokenId: string, opts: { limit?: number; cursor?: string } = {}): Promise<Page<ActivityRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeProjectCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const rows = (await credentialEvents(db, tokenId, after, limit + 1)).map((r) => ({
    eventId: r.event_id,
    projectId: r.project_id,
    sessionId: r.session_id,
    kind: r.kind,
    createdAt: r.created_at,
    receivedAt: r.received_at,
  }));
  return projectPage(rows, limit, (r) => ({ createdAt: r.createdAt, projectId: r.projectId, id: r.eventId }));
}
