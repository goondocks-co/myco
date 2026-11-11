import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { savePlan, changePlanStatus } from '@myco-server-worker/core/plans.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { sqliteD1 } from './helpers/d1.js';
import { schemaSqlite, schemaD1Root } from './helpers/schema-template.js';
import { issueMemberToken } from './helpers/member-token.js';
import { changingAtStatement } from './helpers/store-faults.js';

it('a title-only save retains a concurrent administrator status, on native SQLite and D1', async () => {
  const sqlite = schemaSqlite();
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    for (const db of [sqliteD1(sqlite), await mf.getD1Database('DB')]) {
      await db.batch([
        db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','Project',1)"),
        db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','Member',1)"),
        db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)"),
      ]);
      const token = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, 1);
      const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: memoryBlobStore(), SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
      const scope = { projectId: 'proj_1' };
      const member = { machineId: 'machine', tokenId: token.tokenId };
      const created = await savePlan(env, member, scope, { sessionId: 's', planKey: 'key', content: 'body', title: 'Old' }, 100);
      if (!created.ok) throw new Error(created.error);
      const race = changingAtStatement(db, 'capture.planUpsert', () => changePlanStatus(env, scope, created.row.planKey, 'completed', 'admin', 150));
      const updated = await savePlan({ ...env, db: race.store }, member, scope, { id: created.row.planKey, sessionId: 's', title: 'New' }, 200);
      expect(race.landed()).toBe(true);
      expect(updated.ok && { title: updated.row.title, status: updated.row.status }).toEqual({ title: 'New', status: 'completed' });
      const explicit = await savePlan(env, member, scope, { id: created.row.planKey, sessionId: 's', status: 'in_progress' }, 201);
      expect(explicit.ok && explicit.row.status).toBe('in_progress');
    }
  } finally { sqlite.close(); await mf.dispose(); }
}, 120_000);
