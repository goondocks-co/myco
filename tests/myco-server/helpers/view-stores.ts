import { Database } from 'bun:sqlite';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { BlobStore, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { envelope, uuid } from './fixtures.js';

export async function withViewStores(run: (db: RelationalStore, target: string) => Promise<void>, through = Infinity): Promise<void> {
  const native = new Database(':memory:');
  native.exec('PRAGMA foreign_keys=ON');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const stores = [sqliteRelationalStore(native), await mf.getD1Database('DB')];
    for (const [index, db] of stores.entries()) {
      for (const step of SCHEMA_STEPS.filter(step => step.version <= through)) await db.batch(step.statements.map(sql => db.prepare(sql)));
      await db.batch(['project', 'other'].map(project => db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project)));
      await run(db, index === 0 ? 'native' : 'D1');
    }
  } finally { native.close(); await mf.dispose(); }
}

/** Captured facts use the admitted ingest writer on either relational adapter. */
export async function captureViewSession(db: RelationalStore, projectId = 'project', sessionId = 'session', options: { toolInput?: { path: string }; blobs?: BlobStore } = {}): Promise<void> {
  const now = options.blobs === undefined ? 1 : Date.now();
  await ensureMember(db, 'member', now, 'member');
  const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now);
  const ctx = { projectId, machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now };
  for (const event of [
    envelope({ eventId: uuid(1), sessionId, kind: 'session.start', payload: { agent: 'claude-code', startedAt: 1 } }),
    envelope({ eventId: uuid(2), sessionId, kind: 'prompt', payload: { promptId: uuid(20), text: 'factcanary', origin: 'user' } }),
    envelope({ eventId: uuid(3), sessionId, kind: 'response', payload: { responseId: uuid(30), promptId: uuid(20), text: 'factcanary' } }),
    envelope({ eventId: uuid(4), sessionId, kind: 'tool.use', payload: { toolCallId: uuid(40), toolName: 'Read', input: options.toolInput ?? { path: 'test' }, success: true } }),
    envelope({ eventId: uuid(5), sessionId, kind: 'plan', payload: { planKey: uuid(50), content: 'factcanary', status: 'active' } }),
  ]) {
    const result = await ingestEvent(db, ctx, event, options.blobs === undefined ? undefined : { db, blobs: options.blobs });
    if (!result.persisted) throw new Error(`fixture capture refused: ${JSON.stringify(result)}`);
  }
}
