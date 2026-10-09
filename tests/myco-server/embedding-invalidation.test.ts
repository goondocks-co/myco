import { describe, expect, test } from 'bun:test';
import { withEmbeddingStore } from './helpers/embedding-work-store.js';
import { WORK_PREDICATE_VERSION } from '@myco-server-worker/core/embedding/work-state.js';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';

const NOW = 10 ** 12;
const TABLES = ['embedding_versions', 'embedding_receipts', 'embedding_source_failures', 'processed_resources', 'embedding_hubness_members', 'embedding_cursors'];

describe.each(['native', 'D1'])('%s embedding invalidation paths', (target) => {
  test('the final schema retains every dirty table operation', async () => {
    await withEmbeddingStore(target, async (db) => {
      const triggers = (await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all<{ name: string }>()).results.map((row) => row.name);
      for (const table of TABLES) for (const operation of ['insert', 'update', 'delete']) expect(triggers).toContain(`${table}_work_${operation}`);
    });
  }, 30_000);

  test('each mutable journal operation independently invalidates its marker', async () => {
    await withEmbeddingStore(target, async (db) => {
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW)).toBe(false);
      const paths = [
        ['embedding', "INSERT INTO embedding_versions(project_id,type,record_id,revision) VALUES('p','plan','v','r')"],
        ['embedding', "UPDATE embedding_versions SET revision='r2' WHERE project_id='p' AND record_id='v'"],
        ['embedding', "DELETE FROM embedding_versions WHERE project_id='p' AND record_id='v'"],
        ['embedding', "INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at) VALUES('p','m','r','plan','r','v',1,1)"],
        ['embedding', "UPDATE embedding_receipts SET ready=-1 WHERE project_id='p' AND id='r'"],
        ['embedding', "DELETE FROM embedding_receipts WHERE project_id='p' AND id='r'"],
        ['embedding', "INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at) VALUES('p','plan','f','m','v','refused',1)"],
        ['embedding', "UPDATE embedding_source_failures SET recorded_at=2 WHERE project_id='p'"],
        ['embedding', "DELETE FROM embedding_source_failures WHERE project_id='p'"],
        ['embedding', "INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id) VALUES('p','plan','proof','blob','t','e')"],
        ['embedding', "DELETE FROM processed_resources WHERE project_id='p' AND resource_id='proof'"],
        ['hubness', "INSERT INTO embedding_hubness_members(project_id,model_key,id,n,vector) VALUES('p','m','member',1,'AACAPw==')"],
        ['hubness', "UPDATE embedding_hubness_members SET n=2 WHERE project_id='p'"],
        ['hubness', "DELETE FROM embedding_hubness_members WHERE project_id='p'"],
        ['hubness', "INSERT INTO embedding_cursors(project_id) VALUES('p')"],
        ['hubness', "UPDATE embedding_cursors SET hubness_count=2 WHERE project_id='p'"],
        ['hubness', "DELETE FROM embedding_cursors WHERE project_id='p'"],
      ] as const;
      for (const [kind, sql] of paths) {
        await db.prepare("UPDATE embedding_work_state SET checked_revision=revision,pending=0 WHERE project_id='p'").run();
        const before = await db.prepare("SELECT revision FROM embedding_work_state WHERE project_id='p' AND model_key='m' AND kind=?").bind(kind).first<{ revision: number }>();
        await db.batch([db.prepare(sql)]);
        const after = await db.prepare("SELECT revision,pending FROM embedding_work_state WHERE project_id='p' AND model_key='m' AND kind=?").bind(kind).first<{ revision: number; pending: number }>();
        expect({ sql, changed: after!.revision > before!.revision, pending: after!.pending }).toEqual({ sql, changed: true, pending: 1 });
      }
    });
  }, 30_000);

  test('predicate upgrades recheck clean markers and session eligibility transitions remain atomic', async () => {
    await withEmbeddingStore(target, async (db) => {
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW)).toBe(false);
      const scopes = (await db.prepare("SELECT scope FROM embedding_work_state WHERE project_id='p'").all<{ scope: string }>()).results;
      for (const row of scopes) expect(JSON.parse(row.scope).predicate).toBe(WORK_PREDICATE_VERSION);
      await db.prepare("UPDATE embedding_work_state SET scope='old-predicate' WHERE project_id='p'").run();
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW + 1)).toBe(false);
      for (const row of (await db.prepare("SELECT scope FROM embedding_work_state WHERE project_id='p'").all<{ scope: string }>()).results) {
        expect(JSON.parse(row.scope).predicate).toBe(WORK_PREDICATE_VERSION);
      }
      await db.prepare("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('p','s','machine','token',1,1)").run();
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW + 2)).toBe(false);
      await db.batch([db.prepare("UPDATE sessions SET summary='eligible' WHERE project_id='p' AND session_id='s'")]);
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW + 3)).toBe(true);
      await db.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,'m',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='p'`).run();
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW + 4)).toBe(false);
      await db.batch([db.prepare("UPDATE sessions SET summary=NULL WHERE project_id='p' AND session_id='s'")]);
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW + 5)).toBe(true);
    });
  }, 30_000);

  test('a standalone plan proof creates work without changing its source revision', async () => {
    await withEmbeddingStore(target, async (db) => {
      await db.prepare(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,blob_key,content_hash,status,created_at,updated_at,token_id,received_at)
        VALUES('p','blobbed','s','e','machine',NULL,'blob','h','active',1,1,'token',1)`).run();
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW)).toBe(false);
      const version = () => db.prepare("SELECT revision FROM embedding_versions WHERE project_id='p' AND type='plan' AND record_id='blobbed'").first();
      const before = await version();
      await db.batch([db.prepare("INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id) VALUES('p','plan','blobbed','blob','token','e')")]);
      expect(await version()).toEqual(before);
      expect(await hasEmbeddingWork(db, 'p', 'm', NOW + 1)).toBe(true);
    });
  }, 30_000);
});
