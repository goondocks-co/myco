import { expect, it } from 'bun:test';
import { learningHolds } from '@myco-server-worker/core/learning-hold.js';
import { archiveRawSources } from '@myco-server-worker/core/raw-archive.js';
import { documentTurnInput } from '@myco-server-worker/content/turn-material.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { withDocumentStores, captureDocumentSession } from './helpers/document-stores.js';
import { memoryBlobStore, uuid } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;

it('holds unpublished sessions and archives live unlearned source without losing card material on both stores', async () => {
  await withDocumentStores(async db => {
    const env = { db, blobs: memoryBlobStore() };
    await db.prepare("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.scheduled_tasks_enabled','true',1,'owner')").run();
    await captureDocumentSession(db);
    await captureDocumentSession(db, 'other');
    expect(await learningHolds(db, 'project', 'session')).toBe(true);
    for (let pass = 0; pass < 6; pass++) await archiveRawSources(env, NOW, 90);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE payload_format='archived'").first()).toEqual({ n: 0 });
    await publishDocuments(env, NOW, { calls: 500, deadline: Date.now() + 60000, clock: Date.now });
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    expect(await db.prepare("SELECT pending_cards FROM learning_sessions WHERE project_id='project'").first()).toEqual({ pending_cards: 1 });
    const material = await documentTurnInput(env, 'project', 'session', uuid(20));
    expect(material).not.toBeNull();
    for (let pass = 0; pass < 8; pass++) await archiveRawSources(env, NOW, 90);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM events WHERE payload_format='inline'").first()).toEqual({ n: 0 });
    expect(await documentTurnInput(env, 'project', 'session', uuid(20))).toEqual(material);
    await db.prepare("UPDATE session_documents SET state='convert' WHERE project_id='other'").run();
    expect(await learningHolds(db, 'other', 'session')).toBe(true);
    expect(await learningHolds(db, 'project', 'session')).toBe(false);
    await tombstoneSession(env, { projectId: 'other' }, 'session', 'owner', NOW + 1);
    expect(await learningHolds(db, 'other', 'session')).toBe(false);
  });
}, 30_000);

it('retires pause state and keeps pending counts exact through the final card transition on both stores', async () => {
  await withDocumentStores(async db => {
    const { pendingCardsStatement } = await import('@myco-server-worker/core/learning-sessions.js');
    const { SCHEMA_STEPS } = await import('@myco-server-worker/db/schema.js');
    await db.prepare("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('learning_paused_at','1'),('learning_resumed_at','2')").run();
    await db.batch(SCHEMA_STEPS.at(-1)!.statements.map(sql => db.prepare(sql)));
    const turns = 1003;
    expect((await db.prepare("SELECT key FROM schema_meta WHERE key LIKE 'learning_pause%' OR key='learning_resumed_at'").all()).results).toEqual([]);
    await db.prepare("INSERT INTO learning_sessions(project_id,session_id,init_state) VALUES('project','many','ready')").run();
    await db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
      INSERT INTO turn_cards(project_id,session_id,turn_key,created_at) SELECT 'project','many',CAST(i AS TEXT),1 FROM n`)
      .bind(turns).run();
    await pendingCardsStatement(db, 'project', 'many').run();
    expect(await db.prepare("SELECT pending_cards FROM learning_sessions WHERE session_id='many'").first()).toEqual({ pending_cards: turns });
    await db.prepare("UPDATE turn_cards SET state='carded' WHERE session_id='many' AND turn_key <> '1'").run();
    expect(await db.prepare("SELECT pending_cards FROM learning_sessions WHERE session_id='many'").first()).toEqual({ pending_cards: 1 });
    await db.prepare("UPDATE turn_cards SET state='carded' WHERE session_id='many' AND turn_key='1'").run();
    expect(await db.prepare("SELECT pending_cards FROM learning_sessions WHERE session_id='many'").first()).toEqual({ pending_cards: 0 });
  }, 693);
}, 30_000);
