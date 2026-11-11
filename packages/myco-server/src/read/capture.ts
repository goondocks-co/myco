/**
 * Capture recency, and how every read names a machine.
 *
 * Capture recency is the newest receipt per machine and agent across every Project, including imported sessions,
 * unnamed agents and machines with no harness report. Session triggers maintain one head per machine/agent
 * across Projects.
 * Same-session receipt stamps refresh at most once per minute; newer session heads appear immediately.
 * A tombstoned session still counts: capture recency records receipt, independent of content visibility.
 *
 * A machine's name is its claim's label, or, for a machine claimed before names lived there, the label its newest live
 * credential carries. A read shows a viewer the name of the viewer's own machines alone: anyone else's machine is
 * shown as the member it belongs to, never by its host name. Only the admin pages that manage machines read every name.
 */
import type { RelationalStore } from '../core/adapters.js';
import { HARNESS_MEMBER_ID } from '../constants.js';
import { ownMachineLabels } from '../db/capture/own-machines.js';
import { shownMachineOwners } from '../db/capture/owners.js';
import { captureRecencyRows, type CaptureRecencyRow } from '../db/capture/recency.js';

/** How far back capture recency looks. A machine and agent silent for longer drop out of the answer. */
export const CAPTURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A claimed machine: its name, and the member it belongs to. */
interface MachineOwner {
  name: string | null;
  memberId: string;
  memberLabel: string | null;
}

/** What `viewerId` is shown as a machine's name: the name of a machine that is theirs, and null for anyone else's. */
function shownMachineName(owner: MachineOwner | undefined, viewerId: string): string | null {
  return owner !== undefined && owner.memberId === viewerId ? owner.name : null;
}

/**
 * The names of `viewerId`'s own machines: each claim's label, else the label its newest live credential carries. Each
 * claim seeks its newest live credential only when its label is absent.
 */
export async function ownMachineNames(db: RelationalStore, viewerId: string, nowMs: number, machineIds?: readonly string[]): Promise<Map<string, string>> {
  if (machineIds?.length === 0) return new Map();
  const rows = await ownMachineLabels(db, viewerId, nowMs, machineIds);
  return new Map(rows.flatMap(row => row.name === null ? [] : [[row.machine_id, row.name] as const]));
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

/** The newest receipt per machine and agent within the capture window, most recent first; restricted to `machineIds` when given. */
export function captureRecencyWindow(db: RelationalStore, nowMs: number, machineIds?: readonly string[]): Promise<CaptureRecencyRow[]> {
  return captureRecencyRows(db, nowMs - CAPTURE_WINDOW_MS, machineIds);
}

/** The rows `captureRecencyWindow` answers, as `viewerId` is shown them. */
function captureRowsOf(rows: readonly CaptureRecencyRow[], owners: ReadonlyMap<string, MachineOwner>, viewerId: string): CaptureRow[] {
  return rows.map((row) => {
    const owner = owners.get(row.machine_id);
    return {
      machineId: row.machine_id,
      machineName: shownMachineName(owner, viewerId),
      member: owner === undefined ? null : { id: owner.memberId, label: owner.memberId === HARNESS_MEMBER_ID ? 'Myco' : owner.memberLabel },
      agent: row.agent === null || row.agent === undefined ? null : String(row.agent),
      lastEventAt: Number(row.last_event_at),
      projectId: row.project_id,
    };
  });
}

/** Receipt-minute heads with their source receipts, most recent first, as `viewerId` is shown them. */
export async function captureRecency(db: RelationalStore, nowMs: number, viewerId: string): Promise<CaptureRow[]> {
  const recent = await captureRecencyWindow(db, nowMs);
  const owners = new Map<string, MachineOwner>();
  const ids = [...new Set(recent.map((row) => row.machine_id))];
  for (const row of await shownMachineOwners(db, nowMs, ids)) {
    owners.set(row.machine_id, { name: row.label ?? row.carried_label, memberId: row.member_id, memberLabel: row.member_label });
  }
  return captureRowsOf(recent, owners, viewerId);
}
