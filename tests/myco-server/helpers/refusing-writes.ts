import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';

/** A store that answers every read and fails every batch that carries a write. */
export function refusingWrites(db: RelationalStore, message: string): RelationalStore {
  const writing = new WeakSet<PreparedStatement>();
  const track = (statement: PreparedStatement, write: boolean): PreparedStatement => {
    const tracked: PreparedStatement = { ...statement, bind: (...values) => track(statement.bind(...values), write) };
    if (write) writing.add(tracked);
    return tracked;
  };
  return { ...db,
    prepare: (sql) => track(db.prepare(sql), /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)),
    batch: async (statements) => {
      if (statements.some(statement => writing.has(statement))) throw new Error(message);
      return db.batch(statements);
    },
  };
}
