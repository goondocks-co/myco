import { it } from 'bun:test';
import { sqliteD1 } from './helpers/d1.js';
import { RECONCILIATION_CASES, runReconciliationCase } from './helpers/reconciliation-vectors.js';
import { schemaSqlite } from './helpers/schema-template.js';

for (const name of RECONCILIATION_CASES) {
  it(`native SQLite: ${name}`, async () => {
    const sqlite = schemaSqlite();
    try { await runReconciliationCase(sqliteD1(sqlite), name); } finally { sqlite.close(); }
  });
}
