/**
 * Residency stub-attribution check — the ONE surviving query of the retired
 * detach page-pull. The hybrid detach moves data as a whole-project artifact
 * (`backup/engine.ts` — no per-machine row selection; R1), but the host still
 * needs machine ATTRIBUTION to answer "does any member other than the host and
 * the departing machine still have rows here" before it stub-deregisters a
 * hosted project. Attribution is a legitimate read of `machine_id`; what R1
 * forbids is machine-filtered data MOVEMENT.
 */
import type { Database } from '../client.js';
import { RESIDENCY_TABLE_ORDER } from './residency-apply.js';

/**
 * The done-page stub test: does the project still hold rows from any machine NOT in
 * `excludeMachineIds`? The caller passes the host's own machine id (its
 * intelligence-stamped rows never make a project a live member project) and,
 * per D-F-3, the departing member's machine id — so the answer is "does any OTHER
 * member still have rows here". Checks the machine-scoped residency tables; a true
 * on any one short-circuits. A project with no such rows is a true stub the caller
 * may deregister.
 */
export function projectHasForeignMachineRows(
  db: Database,
  projectId: string,
  excludeMachineIds: string[],
): boolean {
  // Every residency table that carries BOTH project_id and machine_id —
  // content_publications carries neither a project column nor per-machine
  // attribution semantics (project-shared truth), so it never counts.
  const machineTables = RESIDENCY_TABLE_ORDER.filter((t) => t !== 'content_publications');
  const exclude = excludeMachineIds.length > 0
    ? `AND machine_id NOT IN (${excludeMachineIds.map(() => '?').join(', ')})`
    : '';
  const parts = machineTables.map(
    (t) => `SELECT 1 FROM ${t} WHERE project_id = ? ${exclude}`,
  );
  const params: unknown[] = [];
  for (const _ of machineTables) params.push(projectId, ...excludeMachineIds);
  const row = db.prepare(
    `SELECT EXISTS(${parts.join(' UNION ALL ')}) AS has_rows`,
  ).get(...params) as { has_rows: number } | undefined;
  return (row?.has_rows ?? 0) !== 0;
}
