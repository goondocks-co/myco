import type { PreparedStatement, RelationalStore, RunResult } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import type { RunWrite } from './evidence.js';
import { assertion, write, commit, refusalCode, refused, type Bound } from '../index.js';
import { bindSlots } from '../kernel/limits.js';
import { prepareBound } from '../kernel/statement.js';

/** A mutation carries its admission predicate and the resulting state required before attribution. */
export interface AttributedMutation { readonly guard: Bound; readonly mutation: Bound; readonly landed: Bound }
const mutations = new WeakSet<AttributedMutation>();
const RUN_WRITE_NOT_ADMITTED = refusalCode('run_write_not_admitted');

/** Fixed definitions assert admission before the write and its resulting state before attribution. */
export function attributedStatement<Params extends readonly unknown[]>(name: string, sql: string, admitted: string, landed: string) {
  const slots = bindSlots(sql);
  const check = (suffix: string, predicate: string) => assertion<Params>({ name: `${name}${suffix}`, refusal: RUN_WRITE_NOT_ADMITTED, when: `
    ${slots > 0 ? `?${slots} IS ?${slots} AND ` : ''}(${predicate})` });
  const guard = check('Admission', admitted);
  const effect = check('Landed', landed);
  const mutation = write<Params, unknown>({ name, sql });
  return { bind: (...values: Params): AttributedMutation => {
    const bound = Object.freeze({ guard: guard.bind(...values), mutation: mutation.bind(...values), landed: effect.bind(...values) });
    mutations.add(bound);
    return bound;
  } };
}

/** An update records attribution only after its resulting state is present. */
export function attributedUpdate<Params extends readonly unknown[]>(name: string, table: string, set: string, where: string, returning: string, landed: string) {
  return attributedStatement<Params>(name, `UPDATE ${table} SET ${set} WHERE ${where} RETURNING ${returning}`,
    `EXISTS(SELECT 1 FROM ${table} WHERE ${where})`, `EXISTS(SELECT 1 FROM ${table} WHERE ${landed})`);
}

const event = write<[string, string, string, string, number]>({ name: 'runs.attributeWrite', sql: `INSERT INTO agent_run_events
  (project_id,run_id,phase_name,event_type,tool_name,outcome,duration_ms,payload,recorded_at)
  VALUES(?1,?2,NULL,'run_write',?3,'written',NULL,?4,?5)` });

type Companions = readonly Bound[] | readonly PreparedStatement[];
const named = (after: Companions): after is readonly Bound[] => after.every(statement => 'kind' in statement);

/** A refused mutation rolls back its companions and records no attribution. */
export async function commitAttributedWrite(db: RelationalStore, scope: ReadScope, change: AttributedMutation, attribution?: RunWrite,
  after: Companions = []): Promise<RunResult> {
  if (!mutations.has(change)) throw new Error('Attribution requires an admitted mutation definition');
  const statements = [change.guard, change.mutation, change.landed, ...(attribution === undefined ? [] : [event.bind(scope.projectId,
    attribution.runId, attribution.toolName, JSON.stringify({ op: attribution.op, ...(attribution.detail ?? {}) }), attribution.recordedAt)])];
  try {
    const results = named(after) ? await commit(db, ...statements, ...after)
      : await db.batch([...statements.map(statement => prepareBound(db, statement)), ...after]);
    return results[1]!;
  } catch (error) {
    if (refused(error, RUN_WRITE_NOT_ADMITTED)) return { results: [], meta: { changes: 0 } };
    throw error;
  }
}
