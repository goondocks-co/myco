/**
 * Capture recency: when each machine's agents last sent anything, across every Project.
 *
 * Read off the sessions a capture keeps current (`last_received_at` moves with every event a session receives), per
 * machine and agent, over a recent window. `idx_sessions_capture` leads with that receipt, so the read covers the
 * window's sessions alone and never a session row. A deleted session still counts: what this answers is whether a
 * machine's capture reaches the Deployment, and deleting a session afterwards does not change that it did.
 */
import type { RelationalStore } from '../core/adapters.js';

/** How far back capture recency looks. A machine and agent silent for longer drop out of the answer. */
export const CAPTURE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** One machine and agent: when it last sent anything, and the Project that capture landed in. */
export interface CaptureRow {
  machineId: string;
  /** The label the machine's newest live credential carries; null while none carries one. */
  machineName: string | null;
  /** The agent the sessions record; null for sessions that name none. */
  agent: string | null;
  lastEventAt: number;
  projectId: string;
}

/** The latest receipt per machine and agent over the window, most recent first. */
export async function captureRecency(db: RelationalStore, nowMs: number): Promise<CaptureRow[]> {
  const [recent, names] = await db.batch([
    // `project_id` is a bare column beside MAX(): SQLite takes it from the row that holds the maximum.
    db.prepare(
      `SELECT machine_id, agent, MAX(last_received_at) AS last_event_at, project_id FROM sessions
        WHERE last_received_at >= ? AND machine_id IS NOT NULL
        GROUP BY machine_id, agent
        ORDER BY last_event_at DESC, machine_id, agent`,
    ).bind(nowMs - CAPTURE_WINDOW_MS),
    db.prepare(
      `SELECT machine_id, runtime_label FROM member_credentials
        WHERE revoked_at IS NULL AND expires_at > ? AND machine_id IS NOT NULL AND runtime_label IS NOT NULL
        ORDER BY issued_at DESC, id DESC`,
    ).bind(nowMs),
  ]);
  const machineNames = new Map<string, string>();
  for (const row of names.results as { machine_id: string; runtime_label: string }[]) {
    if (!machineNames.has(row.machine_id)) machineNames.set(row.machine_id, row.runtime_label);
  }
  return (recent.results as Record<string, unknown>[]).map((row) => ({
    machineId: String(row.machine_id),
    machineName: machineNames.get(String(row.machine_id)) ?? null,
    agent: row.agent === null || row.agent === undefined ? null : String(row.agent),
    lastEventAt: Number(row.last_event_at),
    projectId: String(row.project_id),
  }));
}
