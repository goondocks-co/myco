import type { D1Like } from '@myco-server-worker/env.js';
import { readSchemaVersion } from '@myco-server-worker/db/migrate.js';
import { SCHEMA_STEPS, type SchemaStep } from '@myco-server-worker/db/schema.js';

/** Test-side applier mirroring what `wrangler d1 migrations apply` does: every step above the database's stamped version, each step as one batch. Returns the versions applied. */
export async function applySchemaSteps(db: D1Like, steps: readonly SchemaStep[] = SCHEMA_STEPS): Promise<number[]> {
  const current = await readSchemaVersion(db);
  const applied: number[] = [];
  for (const step of steps) {
    if (step.version <= current) continue;
    await db.batch(step.statements.map((sql) => db.prepare(sql)));
    applied.push(step.version);
  }
  return applied;
}
