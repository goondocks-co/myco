import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { seededSqlite, sqliteD1 } from './d1.js';

export async function withEmbeddingStore(target: string, run: (db: RelationalStore) => Promise<void>) {
  if (target === 'native') {
    const sqlite = seededSqlite();
    try {
      const db = sqliteD1(sqlite);
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await run(db);
    } finally { sqlite.close(); }
  } else {
    const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01', d1Databases: ['DB'] });
    try {
      const d1 = await mf.getD1Database('DB');
      for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
      const db = d1 as unknown as RelationalStore;
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await run(db);
    } finally { await mf.dispose(); }
  }
}

