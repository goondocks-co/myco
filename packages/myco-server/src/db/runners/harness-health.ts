import { read, readSet } from '../index.js';
import type { RelationalStore } from '../../core/adapters.js';

interface HarnessCaptureRow { machine_id: string; agent: string; at: number }
interface MachineActivityRow { machine_id: string; at: number }
interface HarnessReportRow { machine_id: string; harnesses: string; reported_at: number }

/** The current snapshot for one machine, for the report writer's state transition. */
export async function machineHarnessReport(db: RelationalStore, machineId: string): Promise<string | null> {
  const row = (await readSet(db, machineHarnessReportRead.bind(machineId)))[0][0] ?? null;
  return row?.harnesses ?? null;
}

/** Live session starts created after a machine's oldest pending trust confirmation. */
export async function machineHarnessCaptureSince(db: RelationalStore, machineId: string, since: number): Promise<Array<{ agent: string; at: number }>> {
  const rows = (await readSet(db, machineHarnessCaptureSinceRead.bind(machineId, since, since, since)))[0];
  return rows;
}

/** Each provisioned machine/harness pair's latest live receipt, sought through the covering sessions index. */
export async function latestHarnessCapture(db: RelationalStore): Promise<HarnessCaptureRow[]> {
  const rows = (await readSet(db, latestHarnessCaptureRead.bind()))[0];
  return rows.filter((row): row is HarnessCaptureRow => row.at !== null);
}

/** Recent live receipts from any harness establish machine activity through the time-range index. */
export async function recentMachineCapture(db: RelationalStore, since: number): Promise<MachineActivityRow[]> {
  const rows = (await readSet(db, recentMachineCaptureRead.bind(since)))[0];
  return rows;
}

/** Live session starts created after an outstanding trust report, without a silence lookback cutoff. */
export async function trustConfirmationCapture(db: RelationalStore, since: number): Promise<HarnessCaptureRow[]> {
  const rows = (await readSet(db, trustConfirmationCaptureRead.bind(since, since, since)))[0];
  return rows;
}

const machineHarnessReportRead = read<[string], { harnesses: string }>({ name: 'runners.machineHarnessReport', sql: `SELECT harnesses FROM machine_harness_reports WHERE machine_id = ?` });

const machineHarnessCaptureSinceRead = read<[string, number, number, number], { agent: string; at: number }>({ name: 'runners.machineHarnessCaptureSince', sql: `SELECT s.agent, MAX(e.created_at) AS at FROM sessions s
      JOIN events e ON e.project_id = s.project_id AND e.session_id = s.session_id
      WHERE s.machine_id = ? AND s.agent IS NOT NULL AND s.last_received_at > ?
        AND e.received_at > ? AND e.created_at > ? AND e.kind = 'session.start' AND e.channel <> 'import' GROUP BY s.agent` });

const provisionedHarnessReportRowsRead = read<[], HarnessReportRow>({ name: 'runners.provisionedHarnessReportRows', sql: `SELECT r.machine_id, r.harnesses, r.reported_at FROM machine_harness_reports r
    JOIN machine_claims mc ON mc.machine_id = r.machine_id
    JOIN members m ON m.id = mc.member_id WHERE m.revoked_at IS NULL` });

const latestHarnessCaptureRead = read<[], Omit<HarnessCaptureRow, 'at'> & { at: number | null }>({ name: 'runners.latestHarnessCapture', sql: `SELECT r.machine_id, json_extract(j.value, '$.id') AS agent,
      (SELECT s.last_live_received_at FROM sessions s
       WHERE s.machine_id = r.machine_id AND s.agent = json_extract(j.value, '$.id')
         AND s.last_live_received_at IS NOT NULL ORDER BY s.last_live_received_at DESC LIMIT 1) AS at
      FROM machine_harness_reports r
      JOIN machine_claims mc ON mc.machine_id = r.machine_id
      JOIN members m ON m.id = mc.member_id
      JOIN json_each(r.harnesses) j WHERE m.revoked_at IS NULL` });

const recentMachineCaptureRead = read<[number], MachineActivityRow>({ name: 'runners.recentMachineCapture', sql: `SELECT machine_id, MAX(last_live_received_at) AS at FROM sessions INDEXED BY idx_sessions_machine_live
    WHERE last_live_received_at >= ? AND machine_id IS NOT NULL GROUP BY machine_id` });

const trustConfirmationCaptureRead = read<[number, number, number], HarnessCaptureRow>({ name: 'runners.trustConfirmationCapture', sql: `SELECT s.machine_id, s.agent, MAX(e.created_at) AS at FROM sessions s
    JOIN events e ON e.project_id = s.project_id AND e.session_id = s.session_id
    WHERE s.machine_id IS NOT NULL AND s.agent IS NOT NULL AND s.last_received_at > ?
      AND e.received_at > ? AND e.created_at > ? AND e.kind = 'session.start' AND e.channel <> 'import'
    GROUP BY s.machine_id, s.agent` });

const workerMachineActivityRead = read<[], MachineActivityRow>({ name: 'runners.workerMachineActivity', sql: `SELECT machine_id, MAX(last_seen_at) AS at FROM worker_contacts WHERE machine_id IS NOT NULL GROUP BY machine_id` });

const claimedMachineNamesRead = read<[], { machine_id: string; label: string | null }>({ name: 'runners.claimedMachineNames', sql: `SELECT machine_id, label FROM machine_claims` });
export async function harnessAttentionRows(db: RelationalStore, since: number) {
  return readSet(db, provisionedHarnessReportRowsRead.bind(), latestHarnessCaptureRead.bind(), recentMachineCaptureRead.bind(since),
    workerMachineActivityRead.bind(), claimedMachineNamesRead.bind());
}
export async function harnessHealthRows(db: RelationalStore) {
  return readSet(db, provisionedHarnessReportRowsRead.bind(), claimedMachineNamesRead.bind());
}
