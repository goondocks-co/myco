/**
 * A store whose batches carry a guard: statements that run first and last in the same atomic batch, so a batch commits
 * only while the guard's condition holds. Callers keep writing through the store they were given; the guard travels
 * with it. Statements compile against the store supplied at execution, so decorators stack.
 */
import { inheritStoreContext, type PreparedStatement, type RelationalStore, type RunResult } from '../../core/adapters.js';
import { isSelectStatement } from '../sql-statements.js';
import { prepareBound, type Bound } from './statement.js';

export interface StoreGuard {
  /** Runs first in every guarded batch: the assertion, then whatever must precede the batch's own statements. */
  readonly before: () => readonly Bound[];
  /** Runs last in every guarded batch. */
  readonly after?: () => readonly Bound[];
  /** Reads the results of `after` once a guarded batch commits. */
  readonly observe?: (after: readonly RunResult[]) => void;
  /** `writes` guards each batch holding a write and passes reads straight through; `every` guards every batch. */
  readonly covers?: 'writes' | 'every';
  /** Answers the error a guarded batch failed with: throws the caller's own refusal, or the error itself. */
  readonly refusal: (error: unknown) => never | Promise<never>;
}

export function guardedStore(db: RelationalStore, guard: StoreGuard): RelationalStore {
  const underlying = new WeakMap<PreparedStatement, { statement: PreparedStatement; guarded: boolean }>();
  const every = guard.covers === 'every';
  const execute = async (statements: readonly PreparedStatement[]): Promise<RunResult[]> => {
    const before = guard.before().map(bound => prepareBound(db, bound));
    const after = (guard.after?.() ?? []).map(bound => prepareBound(db, bound));
    let results: RunResult[];
    try {
      results = await db.batch([...before, ...statements, ...after]);
    } catch (error) {
      return guard.refusal(error);
    }
    guard.observe?.(results.slice(before.length + statements.length));
    return results.slice(before.length, before.length + statements.length);
  };
  const wrap = (statement: PreparedStatement, guarded: boolean): PreparedStatement => {
    const wrapped: PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), guarded),
      run: async () => guarded ? (await execute([statement]))[0]! : statement.run(),
      all: async <T,>() => guarded ? { results: (await execute([statement]))[0]!.results as T[] } : statement.all<T>(),
      first: async <T,>() => guarded ? ((await execute([statement]))[0]!.results[0] as T | undefined) ?? null : statement.first<T>(),
    };
    underlying.set(wrapped, { statement, guarded });
    return wrapped;
  };
  const store: RelationalStore = {
    prepare: sql => wrap(db.prepare(sql), every || !isSelectStatement(sql)),
    batch: async statements => {
      const captured = statements.map(statement => {
        const held = underlying.get(statement);
        if (held === undefined) throw new Error('guarded batch requires statements from its own store');
        return held;
      });
      const raw = captured.map(held => held.statement);
      return captured.some(held => held.guarded) ? execute(raw) : db.batch(raw);
    },
  };
  inheritStoreContext(db, store);
  return store;
}

/**
 * Every write through the store commits only while `assertion` holds: it runs first in the write's batch, with `before`
 * after it and `after` last.
 */
export function boundWriteGuardStore(db: RelationalStore, assertion: () => Bound, refusal: (error: unknown) => never,
  options: { before?: () => readonly Bound[]; after?: () => readonly Bound[] } = {}): RelationalStore {
  return guardedStore(db, { before: () => [assertion(), ...(options.before?.() ?? [])], ...(options.after === undefined ? {} : { after: options.after }), refusal });
}
