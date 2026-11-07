/**
 * Capture recency, and how every read names a machine.
 *
 * Capture recency is each provisioned harness's latest live receipt across every Project, over a recent window.
 * Each reported machine/harness pair seeks one session through `idx_sessions_harness_live`. Imported bytes do not
 * establish live capture. A deleted session still counts: capture recency records receipt, independent of deletion.
 *
 * A machine's name is its claim's label, or, for a machine claimed before names lived there, the label its newest live
 * credential carries. A read shows a viewer the name of the viewer's own machines alone: anyone else's machine is
 * shown as the member it belongs to, never by its host name. Only the admin pages that manage machines read every name.
 */
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { HARNESS_MEMBER_ID } from '../constants.js';

/** How far back capture recency looks. A machine and agent silent for longer drop out of the answer. */
export const CAPTURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A claimed machine: its name, and the member it belongs to. */
export interface MachineOwner {
  name: string | null;
  memberId: string;
  memberLabel: string | null;
}

/** Every claimed machine with its own label and its member. The claims are the Deployment's machines, a handful of rows. */
export function machineClaimsStatement(db: RelationalStore): PreparedStatement {
  return db.prepare(
    `SELECT mc.machine_id, mc.member_id, mc.label, m.label AS member_label
       FROM machine_claims mc CROSS JOIN members m ON m.id = mc.member_id`,
  );
}

/** The label each machine's live credentials carry, newest first: the name of a machine whose claim holds none. */
export function machineNamesStatement(db: RelationalStore, nowMs: number): PreparedStatement {
  return db.prepare(
    `SELECT machine_id, runtime_label FROM member_credentials INDEXED BY idx_member_credentials_live_successor
      WHERE revoked_at IS NULL AND expires_at > ? AND machine_id IS NOT NULL AND runtime_label IS NOT NULL
      ORDER BY issued_at DESC, id DESC`,
  ).bind(nowMs);
}

/** Each claimed machine's name and member, from what `machineClaimsStatement` and `machineNamesStatement` answer. */
export function machineOwnersOf(claims: readonly unknown[], credentials: readonly unknown[]): Map<string, MachineOwner> {
  const carried = new Map<string, string>();
  for (const row of credentials as { machine_id: string; runtime_label: string }[]) {
    if (!carried.has(row.machine_id)) carried.set(row.machine_id, row.runtime_label);
  }
  const owners = new Map<string, MachineOwner>();
  for (const row of claims as { machine_id: string; member_id: string; label: string | null; member_label: string | null }[]) {
    owners.set(row.machine_id, { name: row.label ?? carried.get(row.machine_id) ?? null, memberId: row.member_id, memberLabel: row.member_label });
  }
  return owners;
}

/** The two statements `machineOwnersOf` reads, for a caller to batch beside its own. */
export const machineOwnerStatements = (db: RelationalStore, nowMs: number): PreparedStatement[] => [machineClaimsStatement(db), machineNamesStatement(db, nowMs)];

/** What `viewerId` is shown as a machine's name: the name of a machine that is theirs, and null for anyone else's. */
export function shownMachineName(owner: MachineOwner | undefined, viewerId: string): string | null {
  return owner !== undefined && owner.memberId === viewerId ? owner.name : null;
}

/**
 * The names of `viewerId`'s own machines: each claim's label, else the label its newest live credential carries. Each
 * claim seeks its newest live credential only when its label is absent.
 */
export async function ownMachineNames(db: RelationalStore, viewerId: string, nowMs: number, machineIds?: readonly string[]): Promise<Map<string, string>> {
  if (machineIds?.length === 0) return new Map();
  const { results } = await db.prepare(`SELECT mc.machine_id, COALESCE(mc.label, (
      SELECT c.runtime_label FROM member_credentials c
        WHERE c.machine_id = mc.machine_id AND c.member_id = mc.member_id AND c.revoked_at IS NULL
          AND c.expires_at > ? AND c.runtime_label IS NOT NULL ORDER BY c.issued_at DESC, c.id DESC LIMIT 1)) AS name
    FROM machine_claims mc WHERE mc.member_id = ?
      ${machineIds === undefined ? '' : 'AND mc.machine_id IN (SELECT value FROM json_each(?))'}`)
    .bind(nowMs, viewerId, ...(machineIds === undefined ? [] : [JSON.stringify(machineIds)]))
    .all<{ machine_id: string; name: string | null }>();
  return new Map(results.flatMap(row => row.name === null ? [] : [[row.machine_id, row.name] as const]));
}

/** `rows` with the viewer's own machines named from `names`, and every other machine left unnamed. */
export function nameOwnMachines<T extends { machineId: string | null; runtimeLabel: string | null }>(rows: readonly T[], names: ReadonlyMap<string, string>): T[] {
  return rows.map((row) => ({ ...row, runtimeLabel: row.machineId === null ? null : names.get(row.machineId) ?? null }));
}

/** One machine and agent: when it last sent anything, and the Project that capture landed in. */
export interface CaptureRow {
  machineId: string;
  /** The machine's name, to the member it belongs to alone; null to anyone else, and while it has none. */
  machineName: string | null;
  /**
   * The member the machine belongs to, served to every viewer: capture is attributed to the person. Myco's own runtime
   * (`HARNESS_MEMBER_ID`, the member `/api/members` marks `system`) is named Myco. Null for a machine no member claims.
   */
  member: { id: string; label: string | null } | null;
  /** The agent the sessions record; null for sessions that name none. */
  agent: string | null;
  lastEventAt: number;
  projectId: string;
}

/** The latest live receipt per provisioned machine/harness pair, most recent first. */
export function captureRecencyStatement(db: RelationalStore, nowMs: number, machineIds?: readonly string[]): PreparedStatement {
  return db.prepare(`SELECT s.machine_id, s.agent, s.last_live_received_at AS last_event_at, s.project_id
    FROM machine_harness_reports r CROSS JOIN json_each(r.harnesses) h CROSS JOIN sessions s
    WHERE s.rowid = (SELECT newest.rowid FROM sessions newest INDEXED BY idx_sessions_harness_live
      WHERE newest.machine_id = r.machine_id AND newest.agent = json_extract(h.value, '$.id')
        AND newest.last_live_received_at IS NOT NULL AND newest.last_live_received_at >= ?
      ORDER BY newest.last_live_received_at DESC LIMIT 1)
      ${machineIds === undefined ? '' : 'AND r.machine_id IN (SELECT value FROM json_each(?))'}
    ORDER BY last_event_at DESC, s.machine_id, s.agent`)
    .bind(nowMs - CAPTURE_WINDOW_MS, ...(machineIds === undefined ? [] : [JSON.stringify(machineIds)]));
}

/** The rows `captureRecencyStatement` answers, as `viewerId` is shown them. */
export function captureRowsOf(rows: readonly unknown[], owners: ReadonlyMap<string, MachineOwner>, viewerId: string): CaptureRow[] {
  return (rows as Record<string, unknown>[]).map((row) => {
    const owner = owners.get(String(row.machine_id));
    return {
      machineId: String(row.machine_id),
      machineName: shownMachineName(owner, viewerId),
      member: owner === undefined ? null : { id: owner.memberId, label: owner.memberId === HARNESS_MEMBER_ID ? 'Myco' : owner.memberLabel },
      agent: row.agent === null || row.agent === undefined ? null : String(row.agent),
      lastEventAt: Number(row.last_event_at),
      projectId: String(row.project_id),
    };
  });
}

/** The latest live receipts of provisioned harnesses, most recent first, as `viewerId` is shown them. */
export async function captureRecency(db: RelationalStore, nowMs: number, viewerId: string): Promise<CaptureRow[]> {
  const [recent, claims, credentials] = await db.batch([captureRecencyStatement(db, nowMs), ...machineOwnerStatements(db, nowMs)]);
  return captureRowsOf(recent!.results, machineOwnersOf(claims!.results, credentials!.results), viewerId);
}
