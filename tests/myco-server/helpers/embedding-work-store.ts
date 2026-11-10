import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { seededSqlite, sqliteD1 } from './d1.js';
import { schemaD1Root } from './schema-template.js';

export async function withEmbeddingStore(target: string, run: (db: RelationalStore) => Promise<void>) {
  if (target === 'native') {
    const sqlite = seededSqlite();
    try {
      const db = sqliteD1(sqlite);
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await run(db);
    } finally { sqlite.close(); }
  } else {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
      compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
    try {
      const db = await mf.getD1Database('DB') as unknown as RelationalStore;
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',1)").run();
      await run(db);
    } finally { await mf.dispose(); }
  }
}

