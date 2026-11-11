/**
 * The reads a pulled claim makes over the stages it may pull from: their switches together, and the Projects with an
 * item due at one stage. Each stage owns its predicates, so each distinct composition is its own statement.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { composedStatements } from '../composed-statements.js';
import { first, read, readSet, type BindValue } from '../index.js';

const switchReads = composedStatements<Record<string, number>, 'read'>('pull.stageSwitches');
const dueReads = composedStatements<{ projectId: string }, 'read'>('pull.dueProjects');

/** Each switch's value under `enabled<i>`, in the order given, in one read; null when the read answers no row. */
export async function stageSwitches(db: RelationalStore, switches: readonly string[]): Promise<Record<string, number> | null> {
  const sql = `SELECT ${switches.map((sql, i) => `(${sql}) AS enabled${i}`).join(',')}`;
  return first(db, switchReads(sql, name => read<BindValue[], Record<string, number>>({ name, sql })).bind());
}

/** The Projects among `candidates` (binding the Project as `p`) that `accepts` the stage's work and have an item `due`. */
export async function dueProjects(db: RelationalStore, candidates: string, accepts: string, due: { sql: string; params: unknown[] }): Promise<string[]> {
  const sql = `SELECT p.project_id AS projectId FROM ${candidates} WHERE ${accepts} AND ${due.sql}`;
  const [rows] = await readSet(db, dueReads(sql, name => read<BindValue[], { projectId: string }>({ name, sql })).bind(...(due.params as BindValue[])));
  return rows.map(row => row.projectId);
}
