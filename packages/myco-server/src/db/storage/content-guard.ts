/**
 * The content guard a content transition holds in its own batch: a row the guard table refuses unless the condition
 * holds, then cleared, so a batch whose evidence moved fails whole. Each condition text is its own statement.
 */
import { composedStatements } from '../composed-statements.js';
import { write, type BindValue, type Bound } from '../index.js';

const holds = composedStatements<never, 'write'>('storage.contentGuard');
const clear = write<[]>({ name: 'storage.contentGuardClear', sql: 'DELETE FROM storage_content_guard' });

/** The batch fails unless `sql` holds; with `when`, the guard is checked only where `when` holds. */
export function contentGuard(sql: string, params: readonly unknown[], when?: { sql: string; params: readonly unknown[] }): Bound<never, 'write'>[] {
  const text = `INSERT INTO storage_content_guard(ok) SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END
    ${when === undefined ? '' : `WHERE (${when.sql})`}`;
  const guard = holds(text, name => write<BindValue[]>({ name, sql: text }));
  return [guard.bind(...([...params, ...(when?.params ?? [])] as BindValue[])), clear.bind()];
}

/**
 * A content guard whose condition is fixed when its module loads, defined once under `name`: binding it answers the
 * guard row and its clear, failing the batch on the guard table's own CHECK unless `condition` holds.
 */
export function namedContentGuard<Params extends BindValue[]>(name: string, condition: string): (...params: Params) => Bound<never, 'write'>[] {
  const guard = write<Params>({ name, sql: `INSERT INTO storage_content_guard(ok) SELECT CASE WHEN (${condition}) THEN 1 ELSE 0 END` });
  return (...params) => [guard.bind(...params), clear.bind()];
}
