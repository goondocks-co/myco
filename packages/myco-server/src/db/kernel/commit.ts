import type { RelationalStore, RunResult } from '../../core/adapters.js';
import { emit, StorageContractError } from '../../telemetry.js';
import { abortSql, refusalCode } from './refusal.js';
import { prepareBound, type Bound } from './statement.js';

export type StatementResult<Row> = Omit<RunResult, 'results'> & { results: Row[] };
export type CommitResults<Statements extends readonly Bound[]> = {
  -readonly [Index in keyof Statements]: Statements[Index] extends Bound<infer Row> ? StatementResult<Row> : never;
};
export type ReadResults<Statements extends readonly Bound<unknown, 'read'>[]> = {
  -readonly [Index in keyof Statements]: Statements[Index] extends Bound<infer Row, 'read'> ? Row[] : never;
};
export type NamedStatements = Readonly<Record<string, Bound | readonly Bound[]>>;
export type NamedResults<Statements extends NamedStatements> = {
  -readonly [Key in keyof Statements]: Statements[Key] extends Bound<infer Row> ? StatementResult<Row>
    : Statements[Key] extends readonly (infer Each)[] ? (Each extends Bound<infer Row> ? StatementResult<Row> : never)[] : never;
};

/** One atomic batch, including assertions and positional results; an empty batch performs no store call. */
export async function commit<const Statements extends readonly Bound[]>(
  db: RelationalStore, ...statements: Statements
): Promise<CommitResults<Statements>> {
  if (statements.length === 0) return [] as CommitResults<Statements>;
  const results = await db.batch(statements.map(statement => prepareBound(db, statement)));
  if (results.length !== statements.length) throw new StorageContractError('batch result count differs from statement count');
  emit({
    kind: 'db_batch',
    statements: results.map((result, index) => ({
      statement: statements[index]!.name,
      meta: Object.fromEntries(Object.entries(result.meta).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))),
    })),
  });
  return results as CommitResults<Statements>;
}

/** A condition the batch must hold, still rendered as text by the family that owns it. */
export interface BatchGuard { readonly sql: string; readonly params: readonly unknown[] }

const guardRefused = refusalCode('batch_guard_refused');
const GUARD_STATEMENT = 'storage.batchGuard';

/**
 * One atomic batch in which each guard must hold before `statements` run; the results answer only `statements`, in order.
 * A guard can only be a condition: it is rendered inside a select, and text holding a second statement is refused.
 */
export async function commitAfter<const Statements extends readonly Bound[]>(
  db: RelationalStore, guards: readonly BatchGuard[], ...statements: Statements
): Promise<CommitResults<Statements>> {
  if (guards.some(guard => guard.sql.includes(';'))) throw new StorageContractError('a batch guard is one condition and cannot hold a statement separator');
  const before = guards.map(guard => db.prepare(`SELECT CASE WHEN (${guard.sql}) THEN 1 ELSE ${abortSql(guardRefused)} END`).bind(...guard.params));
  const results = await db.batch([...before, ...statements.map(statement => prepareBound(db, statement))]);
  if (results.length !== before.length + statements.length) throw new StorageContractError('batch result count differs from statement count');
  emit({
    kind: 'db_batch',
    statements: results.map((result, index) => ({
      statement: index < before.length ? GUARD_STATEMENT : statements[index - before.length]!.name,
      meta: Object.fromEntries(Object.entries(result.meta).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))),
    })),
  });
  return results.slice(before.length) as CommitResults<Statements>;
}

/**
 * One atomic batch in key order, answering each statement's result under its key, so adding a statement moves nothing.
 * A key holding a list runs those statements in place and answers their results as a list.
 */
export async function commitNamed<const Statements extends NamedStatements>(
  db: RelationalStore, statements: Statements,
): Promise<NamedResults<Statements>> {
  const entries = Object.entries(statements) as [string, Bound | readonly Bound[]][];
  const numeric = entries.find(([key]) => /^(?:0|[1-9]\d*)$/.test(key));
  if (numeric !== undefined) throw new Error(`commitNamed key ${numeric[0]} is an integer, which would reorder the batch; use a word`);
  const results: StatementResult<unknown>[] = await commit(db, ...entries.flatMap(([, value]) => value));
  let next = 0;
  const take = (count: number) => results.slice(next, next += count);
  return Object.fromEntries(entries.map(([key, value]) => [key, isList(value) ? take(value.length) : take(1)[0]])) as NamedResults<Statements>;
}
const isList = (value: Bound | readonly Bound[]): value is readonly Bound[] => Array.isArray(value);

/** The statement's rows, whether it reads or writes with RETURNING. */
export async function rows<Row>(db: RelationalStore, bound: Bound<Row, 'read' | 'write'>): Promise<Row[]> {
  const [result] = await commit(db, bound);
  return result.results;
}

/** The statement's first row, or null when it produced none. */
export async function first<Row>(db: RelationalStore, bound: Bound<Row, 'read' | 'write'>): Promise<Row | null> {
  return (await rows(db, bound))[0] ?? null;
}

/** One batch of reads, returning row arrays in argument order; an empty set returns [] without I/O. */
export async function readSet<const Statements extends readonly Bound<unknown, 'read'>[]>(
  db: RelationalStore, ...statements: Statements
): Promise<ReadResults<Statements>> {
  if (statements.some(statement => statement.kind !== 'read')) throw new Error('readSet accepts only read statements');
  const results = await commit(db, ...statements);
  return results.map(result => result.results) as ReadResults<Statements>;
}
