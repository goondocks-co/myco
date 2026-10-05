/**
 * Capture recency, and how every read names a machine.
 *
 * Capture recency is when each machine's agents last sent anything, across every Project. It is read off the sessions
 * a capture keeps current (`last_received_at` moves with every event a session receives), per machine and agent, over
 * a recent window. `idx_sessions_capture` leads with that receipt, so the read covers the window's sessions alone and
 * never a session row. A deleted session still counts: what this answers is whether a machine's capture reaches the
 * Deployment, and deleting a session afterwards does not change that it did.
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

/** Every claimed machine's name and member. */
export async function readMachineOwners(db: RelationalStore, nowMs: number): Promise<Map<string, MachineOwner>> {
  const [claims, credentials] = await db.batch(machineOwnerStatements(db, nowMs));
  return machineOwnersOf(claims!.results, credentials!.results);
}

/** What `viewerId` is shown as a machine's name: the name of a machine that is theirs, and null for anyone else's. */
export function shownMachineName(owner: MachineOwner | undefined, viewerId: string): string | null {
  return owner !== undefined && owner.memberId === viewerId ? owner.name : null;
}

/**
 * The names of `viewerId`'s own machines: each claim's label, else the label its newest live credential carries. Both
 * reads seek the viewer's rows alone.
 */
export async function ownMachineNames(db: RelationalStore, viewerId: string, nowMs: number): Promise<Map<string, string>> {
  const [claims, credentials] = await db.batch([
    db.prepare(`SELECT machine_id, label FROM machine_claims WHERE member_id = ?`).bind(viewerId),
    db.prepare(
      `SELECT machine_id, runtime_label FROM member_credentials
        WHERE member_id = ? AND revoked_at IS NULL AND expires_at > ? AND machine_id IS NOT NULL AND runtime_label IS NOT NULL
        ORDER BY issued_at DESC, id DESC`,
    ).bind(viewerId, nowMs),
  ]);
  const carried = new Map<string, string>();
  for (const row of credentials!.results as { machine_id: string; runtime_label: string }[]) {
    if (!carried.has(row.machine_id)) carried.set(row.machine_id, row.runtime_label);
  }
  const names = new Map<string, string>();
  for (const row of claims!.results as { machine_id: string; label: string | null }[]) {
    const name = row.label ?? carried.get(row.machine_id);
    if (name !== undefined) names.set(row.machine_id, name);
  }
  return names;
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

/** The latest receipt per machine and agent over the window, most recent first. */
export function captureRecencyStatement(db: RelationalStore, nowMs: number): PreparedStatement {
  // `project_id` is a bare column beside MAX(): SQLite takes it from the row that holds the maximum.
  return db.prepare(
    `SELECT machine_id, agent, MAX(last_received_at) AS last_event_at, project_id FROM sessions
      WHERE last_received_at >= ? AND machine_id IS NOT NULL
      GROUP BY machine_id, agent
      ORDER BY last_event_at DESC, machine_id, agent`,
  ).bind(nowMs - CAPTURE_WINDOW_MS);
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

/** The latest receipt per machine and agent over the window, most recent first, as `viewerId` is shown it. */
export async function captureRecency(db: RelationalStore, nowMs: number, viewerId: string): Promise<CaptureRow[]> {
  const [recent, claims, credentials] = await db.batch([captureRecencyStatement(db, nowMs), ...machineOwnerStatements(db, nowMs)]);
  return captureRowsOf(recent!.results, machineOwnersOf(claims!.results, credentials!.results), viewerId);
}
