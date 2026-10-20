import { Database } from 'bun:sqlite';
import { it } from 'bun:test';
import { sqliteD1 } from './helpers/d1.js';
import { RECONCILIATION_FIXTURE, runReconciliationCase } from './helpers/reconciliation-vectors.js';

import { RECONCILIATION_CASES } from './helpers/reconciliation-cases.js';

for (const name of RECONCILIATION_CASES) {
  it(`native reconciliation: ${name}`, async () => {
    const sqlite = new Database(':memory:');
    try {
      for (const sql of RECONCILIATION_FIXTURE) sqlite.exec(sql);
      await runReconciliationCase(sqliteD1(sqlite), name);
    } finally { sqlite.close(); }
  });
}
