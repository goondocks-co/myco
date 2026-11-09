import { assertion, commitNamed, read, readSet, refusalCode, refused, write, type Bound } from '../index.js';
import type { RelationalStore } from '../../core/adapters.js';

interface HarnessCaptureRow { machine_id: string; agent: string; at: number }
interface MachineActivityRow { machine_id: string; at: number }

/** One machine's reported harness, with the trust state the Deployment keeps for it. */
export interface HarnessReportRow {
  machine_id: string;
  harness: string;
  state: string;
  action: string | null;
  ran_at: number | null;
  hook_repair_at: number | null;
  tools_deployment: string | null;
  activity_scope: string | null;
  since_at: number;
  trust_epoch: number;
  capability_hash: string;
}

const COLUMNS = 'machine_id,harness,state,action,ran_at,hook_repair_at,tools_deployment,activity_scope,since_at,trust_epoch,capability_hash';

const machineReportRead = read<[machine: string], HarnessReportRow>({ name: 'runners.machineHarnessReport',
  sql: `SELECT ${COLUMNS} FROM machine_harness_reports WHERE machine_id=?1 ORDER BY position` });
const reportRevisionRead = read<[machine: string], { revision: number }>({ name: 'runners.harnessReportRevision',
  sql: `SELECT harness_revision AS revision FROM machine_head WHERE machine_id=?1` });

/** The machine's harnesses and the report revision they were read at, for the writer's compare-and-set. */
export async function machineHarnessState(db: RelationalStore, machineId: string): Promise<{ revision: number; rows: HarnessReportRow[] }> {
  const [rows, revision] = await readSet(db, machineReportRead.bind(machineId), reportRevisionRead.bind(machineId));
  return { revision: revision[0]?.revision ?? 0, rows };
}

const reportMoved = refusalCode('harness_report_moved');
const reportCurrent = assertion<[machine: string, revision: number]>({ name: 'runners.harnessReportCurrent', refusal: reportMoved,
  when: 'COALESCE((SELECT harness_revision FROM machine_head WHERE machine_id=?1),0)=?2' });
const advanceReport = write<[machine: string, revision: number]>({ name: 'runners.advanceHarnessReport', sql:
  `INSERT INTO machine_head(machine_id,harness_revision) VALUES(?1,?2)
    ON CONFLICT(machine_id) DO UPDATE SET harness_revision=excluded.harness_revision` });
const dropUnreported = write<[machine: string, harnesses: string]>({ name: 'runners.dropUnreportedHarnesses', sql:
  'DELETE FROM machine_harness_reports WHERE machine_id=?1 AND harness NOT IN (SELECT value FROM json_each(?2))' });

export interface HarnessRowWrite {
  harness: string;
  state: string;
  action: string | null;
  ranAt: number | null;
  hookRepairAt: number | null;
  toolsDeployment: string | null;
  activityScope: string | null;
  sinceAt: number;
  trustEpoch: number;
  capabilityHash: string;
}

const putHarness = write<[machine: string, harness: string, position: number, state: string, action: string | null, ranAt: number | null, hookRepairAt: number | null,
  toolsDeployment: string | null, activityScope: string | null, sinceAt: number, trustEpoch: number, revision: number, hash: string, now: number]>({ name: 'runners.putHarnessReport', sql:
  `INSERT INTO machine_harness_reports(machine_id,harness,position,state,action,ran_at,hook_repair_at,tools_deployment,activity_scope,since_at,trust_epoch,report_revision,capability_hash,reported_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
    ON CONFLICT(machine_id,harness) DO UPDATE SET position=excluded.position,state=excluded.state,action=excluded.action,ran_at=excluded.ran_at,
      hook_repair_at=excluded.hook_repair_at,tools_deployment=excluded.tools_deployment,activity_scope=excluded.activity_scope,since_at=excluded.since_at,
      trust_epoch=excluded.trust_epoch,report_revision=excluded.report_revision,capability_hash=excluded.capability_hash,reported_at=excluded.reported_at
    WHERE (machine_harness_reports.position,machine_harness_reports.ran_at,machine_harness_reports.since_at,machine_harness_reports.trust_epoch,machine_harness_reports.capability_hash)
      IS NOT (excluded.position,excluded.ran_at,excluded.since_at,excluded.trust_epoch,excluded.capability_hash)` });

/**
 * Replace a machine's harness rows, provided the report revision still reads `revision`. Answers false when it moved,
 * and then the rows stand as they are. A harness whose capability, order, run time and trust state are all unchanged keeps its row.
 */
export async function commitHarnessReport(db: RelationalStore, machineId: string, revision: number, rows: readonly HarnessRowWrite[], now: number): Promise<boolean> {
  const next = revision + 1;
  const statements: Record<string, Bound | readonly Bound[]> = {
    current: reportCurrent.bind(machineId, revision),
    advance: advanceReport.bind(machineId, next),
    drop: dropUnreported.bind(machineId, JSON.stringify(rows.map(row => row.harness))),
    rows: rows.map((row, position) => putHarness.bind(machineId, row.harness, position, row.state, row.action, row.ranAt, row.hookRepairAt, row.toolsDeployment,
      row.activityScope, row.sinceAt, row.trustEpoch, next, row.capabilityHash, now)),
  };
  try {
    await commitNamed(db, statements);
    return true;
  } catch (error) {
    if (refused(error, reportMoved)) return false;
    throw error;
  }
}

/** Live session starts created after a machine's oldest pending trust confirmation. */
export async function machineHarnessCaptureSince(db: RelationalStore, machineId: string, since: number): Promise<Array<{ agent: string; at: number }>> {
  return (await readSet(db, machineHarnessCaptureSinceRead.bind(machineId, since, since, since)))[0];
}

/** Live session starts created after an outstanding trust report, without a silence lookback cutoff. */
export async function trustConfirmationCapture(db: RelationalStore, since: number): Promise<HarnessCaptureRow[]> {
  return (await readSet(db, trustConfirmationCaptureRead.bind(since, since, since)))[0];
}

const machineHarnessCaptureSinceRead = read<[string, number, number, number], { agent: string; at: number }>({ name: 'runners.machineHarnessCaptureSince', sql: `SELECT s.agent, MAX(e.created_at) AS at FROM sessions s
      JOIN events e ON e.project_id = s.project_id AND e.session_id = s.session_id
      WHERE s.machine_id = ? AND s.agent IS NOT NULL AND s.last_received_at > ?
        AND e.received_at > ? AND e.created_at > ? AND e.kind = 'session.start' AND e.channel <> 'import' GROUP BY s.agent` });

const provisionedRowsRead = read<[], HarnessReportRow>({ name: 'runners.provisionedHarnessReportRows', sql: `SELECT ${COLUMNS.split(',').map(column => `r.${column}`).join(',')} FROM machine_harness_reports r
    JOIN machine_claims mc ON mc.machine_id = r.machine_id
    JOIN members m ON m.id = mc.member_id WHERE m.revoked_at IS NULL ORDER BY r.machine_id, r.position` });

const latestHarnessCaptureRead = read<[], Omit<HarnessCaptureRow, 'at'> & { at: number | null }>({ name: 'runners.latestHarnessCapture', sql: `SELECT r.machine_id, r.harness AS agent,
      (SELECT s.last_live_received_at FROM sessions s
       WHERE s.machine_id = r.machine_id AND s.agent = r.harness
         AND s.last_live_received_at IS NOT NULL ORDER BY s.last_live_received_at DESC LIMIT 1) AS at
      FROM machine_harness_reports r
      JOIN machine_claims mc ON mc.machine_id = r.machine_id
      JOIN members m ON m.id = mc.member_id WHERE m.revoked_at IS NULL` });

/** Each provisioned machine/harness pair's latest live receipt. */
export async function latestHarnessCapture(db: RelationalStore): Promise<HarnessCaptureRow[]> {
  const rows = (await readSet(db, latestHarnessCaptureRead.bind()))[0];
  return rows.filter((row): row is HarnessCaptureRow => row.at !== null);
}

const recentMachineCaptureRead = read<[number], MachineActivityRow>({ name: 'runners.recentMachineCapture', sql: `SELECT machine_id, MAX(last_live_received_at) AS at FROM sessions INDEXED BY idx_sessions_machine_live
    WHERE last_live_received_at >= ? AND machine_id IS NOT NULL GROUP BY machine_id` });

/** Recent live receipts from any harness establish machine activity through the time-range index. */
export const recentMachineCapture = async (db: RelationalStore, since: number): Promise<MachineActivityRow[]> => (await readSet(db, recentMachineCaptureRead.bind(since)))[0];

const trustConfirmationCaptureRead = read<[number, number, number], HarnessCaptureRow>({ name: 'runners.trustConfirmationCapture', sql: `SELECT s.machine_id, s.agent, MAX(e.created_at) AS at FROM sessions s
    JOIN events e ON e.project_id = s.project_id AND e.session_id = s.session_id
    WHERE s.machine_id IS NOT NULL AND s.agent IS NOT NULL AND s.last_received_at > ?
      AND e.received_at > ? AND e.created_at > ? AND e.kind = 'session.start' AND e.channel <> 'import'
    GROUP BY s.machine_id, s.agent` });

const workerMachineActivityRead = read<[since: number], MachineActivityRow>({ name: 'runners.workerMachineActivity', sql:
  `SELECT machine_id,latest_contact_at AS at FROM machine_head WHERE latest_contact_at>=?1` });

const claimedMachineNamesRead = read<[], { machine_id: string; label: string | null }>({ name: 'runners.claimedMachineNames', sql: `SELECT machine_id, label FROM machine_claims` });

/** Reported harnesses, each pair's latest live capture, machine activity from capture and contact, and names, in one snapshot. */
export async function harnessAttentionRows(db: RelationalStore, since: number) {
  return readSet(db, provisionedRowsRead.bind(), latestHarnessCaptureRead.bind(), recentMachineCaptureRead.bind(since),
    workerMachineActivityRead.bind(since), claimedMachineNamesRead.bind());
}

export async function harnessHealthRows(db: RelationalStore) {
  return readSet(db, provisionedRowsRead.bind(), claimedMachineNamesRead.bind());
}
