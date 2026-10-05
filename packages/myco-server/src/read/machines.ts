/** Canonical machine summaries and activity, scoped to claims owned by the viewer. */
import type { RelationalStore } from '../core/adapters.js';
import { machineContactsOf, type ReportedHarness } from '../core/worker-contacts.js';
import { CAPTURE_WINDOW_MS } from './capture.js';
import { credentialLive } from '../db/liveness.js';
import { clampLimit, decodeCursor, encodeCursor, page, type Page } from './scope.js';
import type { ActivityRow } from './credentials.js';

export interface MachineCapture {
  agent: string | null;
  lastEventAt: number;
  projectId: string;
}

export type MachineStanding = 'allowed' | 'stopped' | 'replayed' | 'expired';

export interface MachineRow {
  machineId: string;
  name: string | null;
  live: boolean;
  member: { id: string; label: string | null; revoked: boolean };
  claimedAt: number;
  credentialCount: number;
  liveCredentialCount: number;
  bytesWritten: number;
  firstSeenAt: number;
  standing: MachineStanding;
  stoppedBy: string | null;
  offers: ReportedHarness[] | null;
  lastContactAt: number | null;
  capture: MachineCapture[];
  lastCaptureAt: number | null;
  lastRunAt: number | null;
}

export type MachineScope = { all: true } | { all: false; memberId: string };

/** A claim is paged by immutable claim time and id; credential history never drives the page. */
export async function listMachines(
  db: RelationalStore, nowMs: number, scope: MachineScope, opts: { limit?: number; cursor?: string } = {},
): Promise<{ machines: MachineRow[]; cursor: string | null }> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { machines: [], cursor: null };
  const { results: claims } = await db.prepare(
    `SELECT mc.machine_id, mc.member_id, mc.claimed_at, mc.label, m.label AS member_label, m.revoked_at AS member_revoked_at
       FROM machine_claims mc CROSS JOIN members m ON m.id = mc.member_id
      WHERE ${scope.all ? '1 = 1' : 'mc.member_id = ?'}
        ${after === null ? '' : 'AND (mc.claimed_at < ? OR (mc.claimed_at = ? AND mc.machine_id > ?))'}
      ORDER BY mc.claimed_at DESC, mc.machine_id ASC LIMIT ?`,
  ).bind(...(scope.all ? [] : [scope.memberId]), ...(after === null ? [] : [after.createdAt, after.createdAt, after.id]), limit + 1)
    .all<Record<string, unknown>>();
  const visible = claims.slice(0, limit);
  if (visible.length === 0) return { machines: [], cursor: null };
  const ids = JSON.stringify(visible.map((row) => String(row.machine_id)));
  const [credentials, recent, contacts] = await db.batch([
    db.prepare(`SELECT c.machine_id, COUNT(*) AS credential_count,
          SUM(CASE WHEN ${credentialLive('c')} THEN 1 ELSE 0 END) AS live_count,
          SUM(CASE WHEN c.lineage_rank = 1 THEN c.bytes_written ELSE 0 END) AS bytes_written,
          MIN(c.lineage_started_at) AS first_seen_at,
          (SELECT n.revoked_at FROM member_credentials n WHERE n.machine_id = c.machine_id ORDER BY n.issued_at DESC, n.id DESC LIMIT 1) AS newest_revoked_at,
          (SELECT n.revoked_by FROM member_credentials n WHERE n.machine_id = c.machine_id ORDER BY n.issued_at DESC, n.id DESC LIMIT 1) AS newest_revoked_by,
          (SELECT n.runtime_label FROM member_credentials n WHERE n.machine_id = c.machine_id AND ${credentialLive('n')} AND n.runtime_label IS NOT NULL ORDER BY n.issued_at DESC, n.id DESC LIMIT 1) AS live_label
       FROM (SELECT c.machine_id, c.member_id, c.revoked_at, c.expires_at, c.bytes_written, c.lineage_started_at,
          ROW_NUMBER() OVER (PARTITION BY c.machine_id, c.lineage_root ORDER BY c.issued_at DESC, c.id DESC) AS lineage_rank
         FROM member_credentials c INDEXED BY idx_member_credentials_machine
         WHERE c.machine_id IN (SELECT value FROM json_each(?))) c GROUP BY c.machine_id`).bind(nowMs, nowMs, ids),
    db.prepare(`SELECT machine_id, agent, MAX(last_received_at) AS last_event_at, project_id FROM sessions
       WHERE last_received_at >= ? AND machine_id IN (SELECT value FROM json_each(?))
       GROUP BY machine_id, agent ORDER BY last_event_at DESC, machine_id, agent`).bind(nowMs - CAPTURE_WINDOW_MS, ids),
    db.prepare(`SELECT COALESCE(w.machine_id, c.machine_id) AS machine_id, w.credential_id, w.offers, w.updated_at AS offer_revision, w.last_seen_at,
          (SELECT MAX(r.started_at) FROM agent_runs r INDEXED BY idx_agent_runs_lease WHERE r.leased_by = w.credential_id) AS last_run_at
       FROM worker_contacts w CROSS JOIN member_credentials c ON c.id = w.credential_id
       WHERE COALESCE(w.machine_id, c.machine_id) IN (SELECT value FROM json_each(?)) ORDER BY w.last_seen_at DESC`).bind(ids),
  ]);
  const byId = new Map((credentials!.results as Record<string, unknown>[]).map((row) => [String(row.machine_id), row]));
  const capture = new Map<string, MachineCapture[]>();
  for (const row of recent!.results as Record<string, unknown>[]) {
    const machineId = String(row.machine_id);
    const held = capture.get(machineId) ?? [];
    held.push({ agent: row.agent == null ? null : String(row.agent), lastEventAt: Number(row.last_event_at), projectId: String(row.project_id) });
    capture.set(machineId, held);
  }
  const contact = machineContactsOf(contacts!.results);
  const machines = visible.map((row): MachineRow => {
    const machineId = String(row.machine_id);
    const cred = byId.get(machineId);
    const liveCredentialCount = Number(cred?.live_count ?? 0);
    const standing: MachineStanding = liveCredentialCount > 0 ? 'allowed'
      : row.member_revoked_at != null ? 'stopped'
        : cred?.newest_revoked_at == null ? 'expired'
        : cred.newest_revoked_by === 'lineage-replay' ? 'replayed' : 'stopped';
    const captured = capture.get(machineId) ?? [];
    return {
      machineId, name: row.label == null ? cred?.live_label == null ? null : String(cred.live_label) : String(row.label),
      live: liveCredentialCount > 0,
      member: { id: String(row.member_id), label: row.member_label == null ? null : String(row.member_label), revoked: row.member_revoked_at != null },
      claimedAt: Number(row.claimed_at), credentialCount: Number(cred?.credential_count ?? 0), liveCredentialCount,
      bytesWritten: Number(cred?.bytes_written ?? 0), firstSeenAt: Number(cred?.first_seen_at ?? row.claimed_at), standing,
      stoppedBy: standing === 'stopped' && cred?.newest_revoked_at != null && cred.newest_revoked_by != null ? String(cred.newest_revoked_by) : null,
      offers: contact.get(machineId)?.offers ?? null, lastContactAt: contact.get(machineId)?.lastSeenAt ?? null,
      lastRunAt: contact.get(machineId)?.lastRunAt ?? null, capture: captured, lastCaptureAt: captured[0]?.lastEventAt ?? null,
    };
  });
  const last = visible[visible.length - 1]!;
  return { machines, cursor: claims.length > limit ? encodeCursor(Number(last.claimed_at), String(last.machine_id)) : null };
}

/** A machine's merged event stream; one bounded page no matter how many credentials it used. */
export async function machineActivity(
  db: RelationalStore, machineId: string, opts: { limit?: number; cursor?: string } = {},
): Promise<Page<ActivityRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const { results } = await db.prepare(`SELECT event_id, project_id, session_id, kind, created_at, received_at FROM events
      WHERE token_id IN (SELECT id FROM member_credentials WHERE machine_id = ?)
        ${after === null ? '' : `AND (created_at < ? OR (created_at = ? AND (project_id < ? OR (project_id = ? AND event_id < ?))))`}
      ORDER BY created_at DESC, project_id DESC, event_id DESC LIMIT ?`)
    .bind(machineId, ...(after === null ? [] : [after.createdAt, after.createdAt, ...cursorEvent(after.id)]), limit + 1).all<Record<string, unknown>>();
  const rows = results.map((r): ActivityRow => ({ eventId: String(r.event_id), projectId: String(r.project_id), sessionId: String(r.session_id), kind: String(r.kind), createdAt: Number(r.created_at), receivedAt: Number(r.received_at) }));
  return page(rows, limit, (r) => ({ createdAt: r.createdAt, id: `${r.projectId}:${r.eventId}` }));
}

function cursorEvent(value: string): [string, string, string] {
  const split = value.indexOf(':');
  const project = value.slice(0, split);
  const event = value.slice(split + 1);
  return [project, project, event];
}

/** The same machine claim owns summary, activity, rename, and stop. */
export async function machineInScope(db: RelationalStore, machineId: string, scope: MachineScope): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS found FROM machine_claims WHERE machine_id = ? ${scope.all ? '' : 'AND member_id = ?'}`)
    .bind(machineId, ...(scope.all ? [] : [scope.memberId])).first<{ found: number }>();
  return row !== null;
}

export async function machinesOf(db: RelationalStore, memberId: string): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT machine_id FROM machine_claims WHERE member_id = ?`).bind(memberId).all<{ machine_id: string }>();
  return new Set((results ?? []).map((row) => row.machine_id));
}
