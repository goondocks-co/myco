import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

export interface CaptureRecencyRow { machine_id: string; agent: string | null; last_event_at: number; project_id: string }

/** Canonical receipt-minute heads resolve their exact session receipt by primary key. */
const SELECT = `SELECT machine_id,json_extract(agent_json,'$') AS agent,MAX(last_received_at) AS last_event_at,project_id
    FROM (
      SELECT h.machine_id,h.agent_json,h.project_id,s.last_received_at
      FROM machine_capture_heads h CROSS JOIN sessions s ON s.project_id=h.project_id AND s.session_id=h.session_id
    ) WHERE last_received_at >= ?1`;
const GROUP = `GROUP BY machine_id,agent_json ORDER BY last_event_at DESC,machine_id,agent`;
const everyMachine = read<[since: number], CaptureRecencyRow>({ name: 'captureRecency.all', sql: `${SELECT} ${GROUP}` });
const someMachines = read<[since: number, machines: string], CaptureRecencyRow>({ name: 'captureRecency.machines', sql:
  `${SELECT} AND machine_id IN (SELECT value FROM json_each(?2)) ${GROUP}` });

/** The newest receipt per machine and agent since `since`, most recent first; restricted to `machineIds` when given. */
export async function captureRecencyRows(db: RelationalStore, since: number, machineIds?: readonly string[]): Promise<CaptureRecencyRow[]> {
  const [rows] = await readSet(db, machineIds === undefined ? everyMachine.bind(since) : someMachines.bind(since, JSON.stringify(machineIds)));
  return rows;
}
