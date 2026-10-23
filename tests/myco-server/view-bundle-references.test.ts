import { expect, it } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { prepareArchiveBundle, bundleArchiveStatements } from '@myco-server-worker/core/archive-bundle.js';
import { backupArtifact, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import type { ContentRow } from '@myco-server-worker/core/event-content.js';
import { memoryBlobStore, uuid } from './helpers/fixtures.js';
import { captureViewSession, withViewStores } from './helpers/view-stores.js';
import { seedViewInstance, setViewToolBundle } from './helpers/view-instances.js';

it('bundle release is refused while a view row names it during rewrite and restore on native and D1', async () => {
  await withViewStores(async (db, target) => {
    const blobs = memoryBlobStore();
    const toolInput = { path: 'test'.repeat(800) };
    await captureViewSession(db, 'project', 'session', { toolInput, blobs });
    const tool = (await db.prepare(`SELECT t.project_id,t.tool_call_id AS resource_id,t.session_id,t.event_id,t.token_id,
      e.envelope_hash,t.content_revision,t.input_bytes AS bytes,t.received_at,e.raw_revision
      FROM tool_calls t JOIN events e ON e.project_id=t.project_id AND e.event_id=t.event_id
      WHERE t.project_id=? AND t.tool_call_id=?`).bind('project', uuid(40)).first<ContentRow>())!;
    const event = (await db.prepare(`SELECT project_id,event_id AS resource_id,session_id,event_id,token_id,
      envelope_hash,content_revision,length(CAST(payload AS BLOB)) AS bytes,received_at,raw_revision,payload AS text
      FROM events WHERE project_id=? AND event_id=?`).bind('project', uuid(4)).first<ContentRow & { text: string }>())!;
    const old = (await db.prepare(`SELECT a.id,a.archive_key,a.receipt_key FROM tool_calls t
      JOIN archive_bundles a ON a.project_id=t.project_id AND a.id=t.input_bundle_id WHERE t.project_id=? AND t.tool_call_id=?`)
      .bind('project', uuid(40)).first<{ id: number; archive_key: string; receipt_key: string }>())!;
    const saved = await createBackup(db, blobs, { producer: 'view-bundle-test', now: Date.now() });
    const artifact = (await backupArtifact(db, blobs, saved.id))!.text;
    await seedViewInstance(db, { projectId: 'project', sessionId: 'session', instanceId: 'holder', state: 'building', toolCallId: uuid(40) });
    await setViewToolBundle(db, 'project', 'holder', old.id);
    const next = await prepareArchiveBundle({ db, blobs }, [
      { kind: 'tool-input', row: { ...tool, input_bundle_id: old.id, input_bundle_entry: 0,
        input_archive_key: old.archive_key, input_receipt_key: old.receipt_key }, text: JSON.stringify(toolInput) },
      { kind: 'event', row: event, text: event.text },
    ], Date.now());
    let release: PreparedStatement | undefined;
    const capture: RelationalStore = { ...db, prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('DELETE FROM archive_bundles WHERE rowid IN')) return statement;
      return { ...statement, bind(...values) { release = statement.bind(...values); return release; } };
    }, batch: statements => db.batch(statements) };
    await db.batch(bundleArchiveStatements(capture, next));
    const held = () => db.prepare('SELECT id FROM archive_bundles WHERE project_id=? AND id=?').bind('project', old.id).first();
    expect({ target, row: await held() }).toEqual({ target, row: { id: old.id } });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE project_id=? AND input_bundle_id=?')
      .bind('project', old.id).first()).toEqual({ n: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM events WHERE project_id=? AND bundle_id=?')
      .bind('project', old.id).first()).toEqual({ n: 0 });
    await setViewToolBundle(db, 'project', 'holder', null);
    expect(release).toBeDefined();
    await release!.run();
    expect(await held()).toBeNull();

    const inserts = new WeakSet<PreparedStatement>();
    let restoredId: number | undefined;
    const interleaved: RelationalStore = {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.startsWith('INSERT OR IGNORE INTO archive_bundles (')) return statement;
        return { ...statement, bind(...values) {
          const bound = statement.bind(...values); inserts.add(bound); return bound;
        } };
      },
      async batch(statements) {
        const results = await db.batch(statements);
        for (const [index, statement] of statements.entries()) {
          if (!inserts.has(statement)) continue;
          for (const row of results[index]!.results) {
            if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'number') throw new Error('missing inserted bundle identity');
            restoredId = row.id;
            await setViewToolBundle(db, 'project', 'holder', row.id);
          }
        }
        return results;
      },
    };
    await restoreArtifact(interleaved, { blobs, text: artifact, authorization: { kind: 'recovery' } });
    expect(restoredId).toBeDefined();
    expect(await db.prepare('SELECT id FROM archive_bundles WHERE project_id=? AND id=?')
      .bind('project', restoredId).first()).toEqual({ id: restoredId! });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM registered_content_proofs WHERE project_id=? AND source_kind IN ('bundle','receipt') AND key IN (?,?)")
      .bind('project', old.archive_key, old.receipt_key).first()).toEqual({ n: 2 });
  });
}, 60_000);
