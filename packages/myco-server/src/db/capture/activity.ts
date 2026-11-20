import { write, type Bound } from '../index.js';

/** Activity advances monotonically; prompt or tool evidence is permanent. */
export const sessionActivityAssignments = (table: string, at: string, material: string): string =>
  `latest_activity_at=MAX(COALESCE(${table}.latest_activity_at,${at}),${at}),
   has_activity=CASE WHEN ${material}=1 THEN 1 ELSE ${table}.has_activity END`;

/** An older observation with no new material leaves the row alone. */
export const sessionActivityAdvances = (table: string, at: string, material: string): string =>
  `(${table}.latest_activity_at IS NULL OR ${at}>${table}.latest_activity_at OR (${material}=1 AND ${table}.has_activity IS NOT 1))`;

const parsed = write<[project: string, session: string, at: number, material: number]>({ name: 'capture.parsedSessionActivity', sql:
  `UPDATE sessions SET ${sessionActivityAssignments('sessions', '?3', '?4')}
    WHERE project_id=?1 AND session_id=?2 AND ${sessionActivityAdvances('sessions', '?3', '?4')}` });

/** Accepted transcript records retain their evidence independently of document publication. */
export const parsedSessionActivity = (evidence: { project: string; session: string; at: number; hasActivity: boolean }): Bound =>
  parsed.bind(evidence.project, evidence.session, evidence.at, evidence.hasActivity ? 1 : 0);
