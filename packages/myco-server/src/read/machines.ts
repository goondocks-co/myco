/** Canonical machine summaries and activity, scoped to claims owned by the viewer. */
import type { RelationalStore } from '../core/adapters.js';
import { parseOffers, type ReportedHarness } from '../core/worker-contacts.js';
import { captureRecencyStatement } from './capture.js';
import { clampLimit, decodeCursor, encodeCursor, page, type Page } from './scope.js';
import type { ActivityRow } from './credentials.js';
import { claimedMachineIds, claimPage, machineClaimed, machineCredentialFacts, machineEvents } from '../db/runners/machines.js';
import { machineHeadPage } from '../db/runners/heads.js';

interface MachineCapture {
  agent: string | null;
  lastEventAt: number;
  projectId: string;
}

type MachineStanding = 'allowed' | 'stopped' | 'replayed' | 'expired';

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

/** `building` while the machine heads are being seeded: an empty contact on such a page means not yet known, never offline. */
export type MachineFacts = 'ready' | 'building';

export type MachineScope = { all: true } | { all: false; memberId: string };

/** A claim is paged by immutable claim time and id; credential history never drives the page. */
export async function listMachines(
  db: RelationalStore, nowMs: number, scope: MachineScope, opts: { limit?: number; cursor?: string } = {},
): Promise<{ machines: MachineRow[]; cursor: string | null; contactFacts: MachineFacts }> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { machines: [], cursor: null, contactFacts: 'ready' };
  const claims = await claimPage(db, scope, limit + 1, after);
  const visible = claims.slice(0, limit);
  if (visible.length === 0) return { machines: [], cursor: null, contactFacts: 'ready' };
  const ids = visible.map((row) => row.machine_id);
  const [{ heads, building }, credentials, recent] = await Promise.all([
    machineHeadPage(db, ids),
    machineCredentialFacts(db, nowMs, ids),
    captureRecencyStatement(db, nowMs, ids).all<Record<string, unknown>>(),
  ]);
  const byId = new Map(credentials.map((row) => [row.machine_id, row]));
  const headOf = new Map(heads.map((head) => [head.machine_id, head]));
  const capture = new Map<string, MachineCapture[]>();
  for (const row of recent.results) {
    const machineId = String(row.machine_id);
    const held = capture.get(machineId) ?? [];
    held.push({ agent: row.agent == null ? null : String(row.agent), lastEventAt: Number(row.last_event_at), projectId: String(row.project_id) });
    capture.set(machineId, held);
  }
  const machines = visible.map((row): MachineRow => {
    const machineId = row.machine_id;
    const cred = byId.get(machineId);
    const head = headOf.get(machineId);
    const liveCredentialCount = Number(cred?.live_count ?? 0);
    const standing: MachineStanding = liveCredentialCount > 0 ? 'allowed'
      : row.member_revoked_at != null ? 'stopped'
        : cred?.newest_revoked_at == null ? 'expired'
        : cred.newest_revoked_by === 'lineage-replay' ? 'replayed' : 'stopped';
    const captured = capture.get(machineId) ?? [];
    return {
      machineId, name: row.label ?? cred?.live_label ?? null,
      live: liveCredentialCount > 0,
      member: { id: row.member_id, label: row.member_label, revoked: row.member_revoked_at != null },
      claimedAt: row.claimed_at, credentialCount: Number(cred?.credential_count ?? 0), liveCredentialCount,
      bytesWritten: Number(cred?.bytes_written ?? 0), firstSeenAt: Number(cred?.first_seen_at ?? row.claimed_at), standing,
      stoppedBy: standing === 'stopped' && cred?.newest_revoked_at != null && cred.newest_revoked_by != null ? String(cred.newest_revoked_by) : null,
      offers: head?.offers == null ? null : parseOffers(head.offers), lastContactAt: head?.latest_contact_at ?? null,
      lastRunAt: head?.latest_run_at ?? null, capture: captured, lastCaptureAt: captured[0]?.lastEventAt ?? head?.latest_capture_at ?? null,
    };
  });
  const last = visible[visible.length - 1]!;
  return { machines, cursor: claims.length > limit ? encodeCursor(last.claimed_at, last.machine_id) : null, contactFacts: building ? 'building' : 'ready' };
}

/** Machine history merges indexed credential pages behind one statement. */
export async function machineActivity(
  db: RelationalStore,
  machineId: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<Page<ActivityRow>> {
  const limit = clampLimit(opts.limit);
  const after = opts.cursor === undefined ? null : decodeCursor(opts.cursor);
  if (opts.cursor !== undefined && after === null) return { rows: [], cursor: null };
  const results = await machineEvents(db, machineId, limit + 1, after === null ? null : { at: after.createdAt, ...cursorEvent(after.id) });
  const rows = results.map(
    (r): ActivityRow => ({ eventId: r.event_id, projectId: r.project_id, sessionId: r.session_id, kind: r.kind, createdAt: r.created_at, receivedAt: r.received_at }),
  );
  return page(rows, limit, (r) => ({ createdAt: r.createdAt, id: `${r.projectId}:${r.eventId}` }));
}

function cursorEvent(value: string): { project: string; event: string } {
  const split = value.indexOf(':');
  return { project: value.slice(0, split), event: value.slice(split + 1) };
}

/** The same machine claim owns summary, activity, rename, and stop. */
export const machineInScope = (db: RelationalStore, machineId: string, scope: MachineScope): Promise<boolean> => machineClaimed(db, machineId, scope);

export const machinesOf = (db: RelationalStore, memberId: string): Promise<Set<string>> => claimedMachineIds(db, memberId);
