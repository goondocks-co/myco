/**
 * The self-hosted relational store: `RelationalStore` over `bun:sqlite`.
 *
 * This is the adapter the server test suite has always run against, promoted to
 * production. Tests construct it over `:memory:`; a Compose deployment constructs
 * it over a file on the mounted volume. Both run the same code, which is what
 * makes the contract suite's second adapter set real rather than a mock.
 */
import type { Database } from 'bun:sqlite';
import type { PreparedStatement, RelationalStore, RunResult } from '../../core/adapters.js';

interface Captured extends PreparedStatement {
  sql: string;
  params: unknown[];
}

/**
 * Whether a statement produces rows, asked of the prepared statement rather than
 * guessed from its text. A leading-`SELECT` regex misses a CTE and an
 * `INSERT … RETURNING`, and the cost of missing one is silence: the caller reads
 * an empty result set from a statement that returned rows.
 */
const producesRows = (statement: { columnNames: string[] }): boolean => statement.columnNames.length > 0;

/**
 * `batch` runs inside one SQLite transaction, satisfying the contract's atomicity
 * requirement: the ingest path depends on a batch being all-or-nothing so a receipt
 * can never be committed without the row it attests to.
 */
export function sqliteRelationalStore(sqlite: Database): RelationalStore {
  const execute = (sql: string, params: unknown[]): RunResult => {
    const prepared = sqlite.query(sql);
    return producesRows(prepared)
      ? { results: prepared.all(...(params as never[])) as unknown[], meta: { changes: 0 } }
      : { results: [], meta: { changes: prepared.run(...(params as never[])).changes } };
  };

  const statement = (sql: string, params: unknown[]): Captured => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => execute(sql, params),
    all: async <T = Record<string, unknown>>(): Promise<{ results: T[] }> => ({
      results: sqlite.query(sql).all(...(params as never[])) as T[],
    }),
    first: async <T,>() => (sqlite.query(sql).get(...(params as never[])) as T | null) ?? null,
  });

  // Prepared lazily: building the store must not touch the handle, so a deployment
  // whose database is absent reports the miss through `missingBindings()` rather
  // than throwing while its environment is still being assembled.
  let runBatch: ((stmts: Captured[]) => RunResult[]) | null = null;

  return {
    prepare: (sql: string) => statement(sql, []),
    batch: async (stmts: PreparedStatement[]) => {
      runBatch ??= sqlite.transaction((batched: Captured[]): RunResult[] => batched.map((one) => execute(one.sql, one.params)));
      return runBatch(stmts as Captured[]);
    },
  };
}

/** SQLite reports constraint failures with `SQLITE_CONSTRAINT`, which the shared classifier already recognises; anything else naming the driver is this store's own. */
export const classifySqliteError = (message: string): 'db' | null => (/^SQLiteError|SQLITE_/i.test(message) ? 'db' : null);
