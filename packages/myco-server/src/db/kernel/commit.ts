import type { RelationalStore, RunResult } from '../../core/adapters.js';
import { emit, StorageContractError } from '../../telemetry.js';
import { prepareBound, type Bound } from './statement.js';

export type StatementResult<Row> = Omit<RunResult, 'results'> & { results: Row[] };
export type CommitResults<Statements extends readonly Bound[]> = {
  -readonly [Index in keyof Statements]: Statements[Index] extends Bound<infer Row> ? StatementResult<Row> : never;
};
export type ReadResults<Statements extends readonly Bound<unknown, 'read'>[]> = {
  -readonly [Index in keyof Statements]: Statements[Index] extends Bound<infer Row, 'read'> ? Row[] : never;
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

/** One batch of reads, returning row arrays in argument order; an empty set returns [] without I/O. */
export async function readSet<const Statements extends readonly Bound<unknown, 'read'>[]>(
  db: RelationalStore, ...statements: Statements
): Promise<ReadResults<Statements>> {
  if (statements.some(statement => statement.kind !== 'read')) throw new Error('readSet accepts only read statements');
  const results = await commit(db, ...statements);
  return results.map(result => result.results) as ReadResults<Statements>;
}
