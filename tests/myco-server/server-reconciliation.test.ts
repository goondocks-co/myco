import { Database } from 'bun:sqlite';
import { it } from 'bun:test';
import { sqliteD1 } from './helpers/d1.js';
import { RECONCILIATION_FIXTURE, runReconciliationCase, type ReconciliationCase } from './helpers/reconciliation-vectors.js';

for (const name of ['plan', 'provenance', 'roots', 'embedding', 'catalog', 'runner'] satisfies ReconciliationCase[]) {
  it(`native reconciliation: ${name}`, async () => {
    const sqlite = new Database(':memory:');
    try {
      for (const sql of RECONCILIATION_FIXTURE) sqlite.exec(sql);
      await runReconciliationCase(sqliteD1(sqlite), name);
    } finally { sqlite.close(); }
  });
}
