import type { RelationalStore } from '../core/adapters.js';

export interface HarnessCaptureRow { machine_id: string; agent: string; at: number }
export interface MachineActivityRow { machine_id: string; at: number }
export interface HarnessReportRow { machine_id: string; harnesses: string; reported_at: number }

/** The current snapshot for one machine, for the report writer's state transition. */
export async function machineHarnessReport(db: RelationalStore, machineId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT harnesses FROM machine_harness_reports WHERE machine_id = ?`).bind(machineId).first<{ harnesses: string }>();
  return row?.harnesses ?? null;
}

/** Live session starts created after a machine's oldest pending trust confirmation. */
export async function machineHarnessCaptureSince(db: RelationalStore, machineId: string, since: number): Promise<Array<{ agent: string; at: number }>> {
  const rows = await db.prepare(`SELECT s.agent, MAX(e.created_at) AS at FROM sessions s
      JOIN events e ON e.project_id = s.project_id AND e.session_id = s.session_id
      WHERE s.machine_id = ? AND s.agent IS NOT NULL AND s.last_received_at > ?
        AND e.received_at > ? AND e.created_at > ? AND e.kind = 'session.start' AND e.channel <> 'import' GROUP BY s.agent`)
    .bind(machineId, since, since, since).all<{ agent: string; at: number }>();
  return rows.results;
}

/** Snapshots for claimed machines whose member remains active. */
export async function provisionedHarnessReportRows(db: RelationalStore): Promise<HarnessReportRow[]> {
  const rows = await db.prepare(`SELECT r.machine_id, r.harnesses, r.reported_at FROM machine_harness_reports r
    JOIN machine_claims mc ON mc.machine_id = r.machine_id
    JOIN members m ON m.id = mc.member_id WHERE m.revoked_at IS NULL`).all<HarnessReportRow>();
  return rows.results;
}

/** Session capture within the silence lookback, excluding imported history. */
export async function recentHarnessCapture(db: RelationalStore, since: number): Promise<HarnessCaptureRow[]> {
  const rows = await db.prepare(`SELECT s.machine_id, s.agent, MAX(e.received_at) AS at FROM sessions s
      JOIN events e ON e.project_id = s.project_id AND e.session_id = s.session_id
      WHERE s.machine_id IS NOT NULL AND s.agent IS NOT NULL AND s.last_received_at >= ?
        AND e.received_at >= ? AND e.channel <> 'import'
      GROUP BY s.machine_id, s.agent`).bind(since, since).all<HarnessCaptureRow>();
  return rows.results;
}

/** Live session starts created after an outstanding trust report, without a silence lookback cutoff. */
export async function trustConfirmationCapture(db: RelationalStore, since: number): Promise<HarnessCaptureRow[]> {
  const rows = await db.prepare(`SELECT s.machine_id, s.agent, MAX(e.created_at) AS at FROM sessions s
    JOIN events e ON e.project_id = s.project_id AND e.session_id = s.session_id
    WHERE s.machine_id IS NOT NULL AND s.agent IS NOT NULL AND s.last_received_at > ?
      AND e.received_at > ? AND e.created_at > ? AND e.kind = 'session.start' AND e.channel <> 'import'
    GROUP BY s.machine_id, s.agent`).bind(since, since, since).all<HarnessCaptureRow>();
  return rows.results;
}

/** Recent worker contact can establish that a machine is active while one harness is quiet. */
export async function workerMachineActivity(db: RelationalStore): Promise<MachineActivityRow[]> {
  const rows = await db.prepare(`SELECT machine_id, MAX(last_seen_at) AS at FROM worker_contacts WHERE machine_id IS NOT NULL GROUP BY machine_id`)
    .all<MachineActivityRow>();
  return rows.results;
}

/** A claimed machine's own label, shown on the administrator's Health page. */
export async function claimedMachineNames(db: RelationalStore): Promise<Array<{ machine_id: string; label: string | null }>> {
  const rows = await db.prepare(`SELECT machine_id, label FROM machine_claims`).all<{ machine_id: string; label: string | null }>();
  return rows.results;
}
