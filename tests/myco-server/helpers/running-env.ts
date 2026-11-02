import { budgetCompletionMessage, budgetMigration } from '@myco-server-worker/db/budget-activation.js';
import { sqliteEnv } from './fixtures.js';

/** A running Deployment fixture includes the operator's validated budget preparation. */
export function runningEnv(options: Parameters<typeof sqliteEnv>[0] = {}): ReturnType<typeof sqliteEnv> {
  const env = sqliteEnv(options);
  try {
    const migration = budgetMigration(Date.now());
    let next = migration.next();
    while (!next.done) {
      const step = next.value;
      let rows: Record<string, unknown>[];
      try { rows = step.read ? env.sqlite.query(step.sql).all() as Record<string, unknown>[] : (env.sqlite.exec(step.sql), []); }
      catch (error) { next = migration.throw(error); continue; }
      next = migration.next(rows);
    }
    if (next.value.active !== true) throw new Error(budgetCompletionMessage(next.value) ?? 'Budget preparation did not activate');
    return env;
  } catch (error) { env.sqlite.close(); throw error; }
}
