/**
 * Restoring a moved body's reference on its natural key.
 *
 * A restored reference is meaningful only where its bytes are not already on the row it names. Instruction rows are
 * keyed by run; a report row's id is local to the database that wrote it, so the reference lands only where that
 * report exists and its column is empty, and a destination that kept its own copy of the body keeps it.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type Bound } from '../index.js';

type Params = [project: string, run: string, kind: string, item: number, key: string, size: number, moved: number];
const restore = (name: string, target: string) => write<Params, { rowid: number }>({ name: `runs.restoreBody${name}`, sql:
  `INSERT OR IGNORE INTO run_bodies (project_id, run_id, body_kind, item_id, key, size, moved_at)
   SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE EXISTS (${target}) RETURNING rowid` });
const reportEmpty = (column: string) => `SELECT 1 FROM agent_reports WHERE project_id = ?1 AND run_id = ?2 AND id = ?4 AND ${column} IS NULL`;
const RESTORES: Readonly<Record<string, ReturnType<typeof restore>>> = {
  instruction: restore('Instruction', `SELECT 1 FROM agent_runs WHERE project_id = ?1 AND id = ?2 AND ?4 = 0 AND instruction IS NULL`),
  report_details: restore('Details', reportEmpty('details')),
  report_audit: restore('Audit', reportEmpty('audit')),
};

/** The statement restoring one artifact row into the restore's batch; a row naming no known body kind is refused. */
export function restoreRunBodyStatement(row: Readonly<Record<string, unknown>>): Bound<{ rowid: number }, 'write'> {
  const statement = typeof row.body_kind === 'string' ? RESTORES[row.body_kind] : undefined;
  if (statement === undefined) throw new Error('Invalid restored run body');
  return statement.bind(row.project_id as string, row.run_id as string, row.body_kind as string, row.item_id as number,
    row.key as string, row.size as number, row.moved_at as number);
}

const PRESENT_PAGE = 64;
const present = read<[project: string, runs: string], { id: string }>({ name: 'runs.restorePresent', sql:
  `SELECT id FROM agent_runs WHERE project_id = ?1 AND id IN (SELECT value FROM json_each(?2))` });

const unheld = read<[project: string, runs: string], { id: string }>({ name: 'runs.restoreInstructionUnheld', sql:
  `SELECT r.id FROM agent_runs r WHERE r.project_id = ?1 AND r.id IN (SELECT value FROM json_each(?2)) AND r.instruction IS NULL
     AND NOT EXISTS (SELECT 1 FROM run_bodies b WHERE b.project_id = r.project_id AND b.run_id = r.id AND b.body_kind = 'instruction')
     AND NOT EXISTS (SELECT 1 FROM run_retirements m WHERE m.project_id = r.project_id AND m.run_id = r.id)` });

/** Those of `runs` this Deployment holds with no instruction body at all and no retirement under way. */
export async function runsWithoutInstruction(db: RelationalStore, project: string, runs: readonly string[]): Promise<number> {
  let count = 0;
  for (let at = 0; at < runs.length; at += PRESENT_PAGE) count += (await readSet(db, unheld.bind(project, JSON.stringify(runs.slice(at, at + PRESENT_PAGE)))))[0].length;
  return count;
}

/** Those of `runs` this Deployment holds. */
export async function runsPresentAmong(db: RelationalStore, project: string, runs: readonly string[]): Promise<Set<string>> {
  const held = new Set<string>();
  for (let at = 0; at < runs.length; at += PRESENT_PAGE) {
    const [rows] = await readSet(db, present.bind(project, JSON.stringify(runs.slice(at, at + PRESENT_PAGE))));
    for (const row of rows) held.add(row.id);
  }
  return held;
}
