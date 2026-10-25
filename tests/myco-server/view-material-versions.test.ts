import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession } from './helpers/view-stores.js';
import { publicationVersionStatements, finishVersionStatements } from '@myco-server-worker/core/material-versions.js';
import { contentAssertion } from '@myco-server-worker/core/registered-content.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';

test('published sequences serialize, carry only current identity/hash, and roll back together on native and D1', async () => {
  await withViewStores(async (db, target) =>
    withViewWriterDriver(async () => {
      await captureViewSession(db);
      const conditional = 'refused-material';
      await db.batch([
        ...publicationVersionStatements(
          db,
          'project',
          'session',
          conditional,
          {
            items: [{ kind: 'prompt', identity: 'refused', recordId: 'refused', hash: 'refused', owner: 'fact' }],
            when: { sql: '0', params: [] },
          },
          true,
        ),
        ...finishVersionStatements(db, 'project', 'session', conditional),
      ]);
      expect((await db.prepare(`SELECT COUNT(*) n FROM learning_sessions`).first<{ n: number }>())?.n).toBe(0);
      expect((await db.prepare(`SELECT COUNT(*) n FROM material_versions`).first<{ n: number }>())?.n).toBe(0);
      const publish = async (hash: string, identity = 'one', replace = true) => {
        const attempt = crypto.randomUUID();
        await db.batch([
          ...publicationVersionStatements(
            db,
            'project',
            'session',
            attempt,
            [{ kind: 'prompt', identity, recordId: identity, hash }],
            replace,
          ),
          ...finishVersionStatements(db, 'project', 'session', attempt),
        ]);
        return db
          .prepare(
            `SELECT material_seq FROM material_versions WHERE project_id='project' AND session_id='session' AND identity=?`,
          )
          .bind(identity)
          .first<{ material_seq: number }>();
      };
      expect((await publish('a'))?.material_seq, target).toBe(1);
      expect((await publish('a'))?.material_seq).toBe(1);
      expect((await publish('b'))?.material_seq).toBe(2);
      expect((await publish('a'))?.material_seq).toBe(3);
      await Promise.all([publish('x', 'x', false), publish('y', 'y', false)]);
      const before = (await db.prepare(`SELECT * FROM learning_sessions`).all()).results;
      await expect(
        db.batch([
          ...publicationVersionStatements(
            db,
            'project',
            'session',
            'failed',
            [{ kind: 'prompt', identity: 'bad', recordId: 'bad', hash: 'bad' }],
            false,
          ),
          ...contentAssertion(db, '0', []),
        ]),
      ).rejects.toThrow();
      expect((await db.prepare(`SELECT * FROM learning_sessions`).all()).results).toEqual(before);
      const seqs = (
        await db
          .prepare(`SELECT material_seq FROM material_versions ORDER BY material_seq`)
          .all<{ material_seq: number }>()
      ).results.map((r) => r.material_seq);
      expect(new Set(seqs).size).toBe(seqs.length);
      await publish('final', 'only');
      expect((await db.prepare(`SELECT COUNT(*) n FROM material_versions`).first<{ n: number }>())?.n).toBe(1);
      const fact = 'fact-attempt';
      await db.batch([
        ...publicationVersionStatements(
          db,
          'project',
          'session',
          fact,
          [{ kind: 'prompt', identity: 'fact', recordId: 'fact', hash: 'fact body', owner: 'fact' }],
          false,
        ),
        ...finishVersionStatements(db, 'project', 'session', fact),
      ]);
      const current = await db.prepare(`SELECT * FROM material_versions WHERE identity='fact'`).first();
      await publish('replacement', 'new-view');
      expect(await db.prepare(`SELECT * FROM material_versions WHERE identity='fact'`).first()).toEqual(current);
      const beforeRefusal = {
        bindings: (await db.prepare(`SELECT * FROM material_versions ORDER BY identity`).all()).results,
        counter: await db.prepare(`SELECT * FROM learning_sessions`).first(),
      };
      await db.batch([
        ...publicationVersionStatements(
          db,
          'project',
          'session',
          conditional,
          { items: [], when: { sql: '0', params: [] } },
          true,
        ),
        ...finishVersionStatements(db, 'project', 'session', conditional),
      ]);
      expect((await db.prepare(`SELECT * FROM material_versions ORDER BY identity`).all()).results).toEqual(
        beforeRefusal.bindings,
      );
      expect(await db.prepare(`SELECT * FROM learning_sessions`).first()).toEqual(beforeRefusal.counter);
      const hidden = 'hidden-view';
      await db.batch(
        publicationVersionStatements(
          db,
          'project',
          'session',
          hidden,
          [{ kind: 'prompt', identity: 'fact', recordId: 'fact', hash: 'different hidden view' }],
          false,
        ),
      );
      const decision = await db
        .prepare(`SELECT material_seq FROM view_publication_material WHERE attempt_id=?`)
        .bind(hidden)
        .first<{ material_seq: number }>();
      expect(decision?.material_seq).toBeGreaterThan(0);
      expect(await db.prepare(`SELECT * FROM material_versions WHERE identity='fact'`).first()).toEqual(current);
      await db.batch(finishVersionStatements(db, 'project', 'session', hidden));
    }),
  );
}, 60000);
