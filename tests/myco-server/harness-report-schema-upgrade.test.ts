import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_S1C } from '@myco-server-worker/db/schema-vNEXT-s1c.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { applySchemaSteps } from './helpers/migrate.ts';

/** The step that turns a machine's one harness report into a row per harness. */
const PER_HARNESS = SCHEMA_STEPS.find((step) => step.version === NEXT_S1C)!;

it('the per-harness step turns each machine report into one row per harness with its state, and passes over an entry it cannot read', async () => {
  const sqlite = new Database(':memory:');
  const db = sqliteRelationalStore(sqlite);
  await applySchemaSteps(db, SCHEMA_STEPS.filter((step) => step.version < PER_HARNESS.version));
  const harnesses = [
    { id: 'claude-code', state: 'ready', ranAt: 30, sinceAt: 10 },
    { id: 'codex', state: 'trust_required', action: 'trust', hookRepairAt: 25, sinceAt: 12 },
    { id: 'cursor', state: 'ready' },
  ];
  sqlite.run(`INSERT INTO machine_harness_reports(machine_id,harnesses,reported_at) VALUES ('mach_a',?1,40), ('mach_b','not json',41)`, [JSON.stringify(harnesses)]);

  await applySchemaSteps(db, [PER_HARNESS]);

  expect(sqlite.query(`SELECT machine_id,harness,position,state,action,ran_at,hook_repair_at,since_at,trust_epoch,reported_at
    FROM machine_harness_reports ORDER BY machine_id,position`).all()).toEqual([
    { machine_id: 'mach_a', harness: 'claude-code', position: 0, state: 'ready', action: null, ran_at: 30, hook_repair_at: null, since_at: 10, trust_epoch: 0, reported_at: 40 },
    { machine_id: 'mach_a', harness: 'codex', position: 1, state: 'trust_required', action: 'trust', ran_at: null, hook_repair_at: 25, since_at: 12, trust_epoch: 1, reported_at: 40 },
  ]);
});
