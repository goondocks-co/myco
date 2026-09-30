/**
 * The machines of a Deployment: every machine identity a member claims, with what it last did.
 *
 * A machine is its claim (`machine_claims`): the identity it joined with, and the member it belongs to. Its name is the
 * claim's label, the host name `myco login` sent when it first joined unless someone renamed it, or for a machine
 * claimed before names lived there, the label its newest live credential carries. What it last
 * did comes from two places: the sessions its agents capture into, and the reports its worker makes with the runs
 * those reporting credentials leased. A member reads only their own machines; an admin reads every one, names
 * included, as the one who manages them.
 */
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { machineContactsOf, machineContactsStatement, type ReportedHarness } from '../core/worker-contacts.js';
import { captureRecencyStatement } from './capture.js';

/** One agent's capture on a machine: when it last sent anything, and the Project that capture landed in. */
export interface MachineCapture {
  /** The agent the sessions record; null for sessions that name none. */
  agent: string | null;
  lastEventAt: number;
  projectId: string;
}

export interface MachineRow {
  machineId: string;
  /** The claim's label, else the label its newest live credential carries; null while neither holds one. */
  name: string | null;
  /** Whether any credential of the machine authenticates now. */
  live: boolean;
  member: { id: string; label: string | null; revoked: boolean };
  claimedAt: number;
  /** The harnesses the machine's worker last offered; null when it never reported, or its report cannot be read. */
  offers: ReportedHarness[] | null;
  /** When the machine's worker last reported in; null when it never has. */
  lastContactAt: number | null;
  /** Each agent's capture over the capture window, most recent first. */
  capture: MachineCapture[];
  /** The latest capture in `capture`; null when the window holds none. */
  lastCaptureAt: number | null;
  /**
   * When a run the machine's worker leased last started, over the credentials it reported from within
   * `WORKER_CONTACT_RETENTION_MS`; null when none has.
   */
  lastRunAt: number | null;
}

/** Whose machines a read answers: every member's, or one member's own. */
export type MachineScope = { all: true } | { all: false; memberId: string };

function claimsStatement(db: RelationalStore, scope: MachineScope): PreparedStatement {
  const sql = `SELECT mc.machine_id, mc.member_id, mc.claimed_at, mc.label, m.label AS member_label, m.revoked_at AS member_revoked_at
                 FROM machine_claims mc CROSS JOIN members m ON m.id = mc.member_id`;
  return scope.all ? db.prepare(sql) : db.prepare(`${sql} WHERE mc.member_id = ?`).bind(scope.memberId);
}

/** Every live credential that names a machine, newest first. */
function liveCredentialsStatement(db: RelationalStore, nowMs: number): PreparedStatement {
  return db.prepare(
    `SELECT machine_id, runtime_label FROM member_credentials
      WHERE revoked_at IS NULL AND expires_at > ? AND machine_id IS NOT NULL
      ORDER BY issued_at DESC, id DESC`,
  ).bind(nowMs);
}

const newestFirst = (a: MachineRow, b: MachineRow): number => {
  const latest = (row: MachineRow): number => Math.max(row.lastCaptureAt ?? 0, row.lastContactAt ?? 0, row.lastRunAt ?? 0);
  return latest(b) - latest(a) || (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0);
};

/** The machines `scope` reaches, the one active most recently first. */
export async function listMachines(db: RelationalStore, nowMs: number, scope: MachineScope): Promise<MachineRow[]> {
  const [claims, credentials, recent, contacts] = await db.batch([
    claimsStatement(db, scope),
    liveCredentialsStatement(db, nowMs),
    captureRecencyStatement(db, nowMs),
    machineContactsStatement(db),
  ]);
  const names = new Map<string, string>();
  const live = new Set<string>();
  for (const row of credentials!.results as { machine_id: string; runtime_label: string | null }[]) {
    live.add(row.machine_id);
    if (row.runtime_label !== null && !names.has(row.machine_id)) names.set(row.machine_id, row.runtime_label);
  }
  const capture = new Map<string, MachineCapture[]>();
  for (const row of recent!.results as Record<string, unknown>[]) {
    const machineId = String(row.machine_id);
    const held = capture.get(machineId) ?? [];
    held.push({ agent: row.agent == null ? null : String(row.agent), lastEventAt: Number(row.last_event_at), projectId: String(row.project_id) });
    capture.set(machineId, held);
  }
  const contact = machineContactsOf(contacts!.results);
  return (claims!.results as Record<string, unknown>[]).map((row): MachineRow => {
    const machineId = String(row.machine_id);
    const captured = capture.get(machineId) ?? [];
    return {
      machineId,
      name: row.label == null ? names.get(machineId) ?? null : String(row.label),
      live: live.has(machineId),
      member: { id: String(row.member_id), label: row.member_label == null ? null : String(row.member_label), revoked: row.member_revoked_at != null },
      claimedAt: Number(row.claimed_at),
      offers: contact.get(machineId)?.offers ?? null,
      lastContactAt: contact.get(machineId)?.lastSeenAt ?? null,
      lastRunAt: contact.get(machineId)?.lastRunAt ?? null,
      capture: captured,
      lastCaptureAt: captured[0]?.lastEventAt ?? null,
    };
  }).sort(newestFirst);
}

/** The machines `memberId` claims. */
export async function machinesOf(db: RelationalStore, memberId: string): Promise<Set<string>> {
  const { results } = await db.prepare(`SELECT machine_id FROM machine_claims WHERE member_id = ?`).bind(memberId).all<{ machine_id: string }>();
  return new Set((results ?? []).map((row) => row.machine_id));
}
