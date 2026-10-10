import { expect, test } from 'bun:test';
import { seededSqlite } from '../myco-server/helpers/d1.js';

test('every embedding dirty-table operation survives all schema rebuilds', () => {
  const db = seededSqlite();
  try {
    const tables = ['embedding_versions', 'embedding_receipts', 'embedding_source_failures', 'processed_resources', 'embedding_hubness_members', 'embedding_cursors'];
    const triggers = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((row) => row.name);
    for (const table of tables) for (const operation of ['insert', 'update', 'delete']) expect(triggers).toContain(`${table}_work_${operation}`);
  } finally { db.close(); }
});
