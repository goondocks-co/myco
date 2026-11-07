import type { PreparedStatement, RelationalStore, RunResult } from '../../core/adapters.js';

const returningChanges = new WeakSet<PreparedStatement>();

/** Run changes return their direct row identities, independently of trigger writes. */
export function runChangeStatement(db: RelationalStore, sql: string, values: unknown[]): PreparedStatement {
  const statement = db.prepare(`${sql} RETURNING id`).bind(...values);
  returningChanges.add(statement);
  return statement;
}

/** Only changes constructed with RETURNING may determine whether the run changed. */
export async function commitRunChange(db: RelationalStore, statement: PreparedStatement, after: PreparedStatement[] = []):
Promise<{ changed: number; following: RunResult[] }> {
  if (!returningChanges.has(statement)) throw new Error('commitRunChange requires a runChangeStatement with RETURNING id');
  const [changed, ...following] = await db.batch([statement, ...after]);
  if (changed === undefined) throw new Error('Run change result is missing');
  return { changed: changed.results.length, following };
}
