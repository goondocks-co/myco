import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession } from './helpers/view-stores.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { viewContentHash } from '@myco-server-worker/core/material-content.js';
import { readMaterialVersion } from '@myco-server-worker/read/view-material-version.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { sha256Hex } from '@myco-server-worker/hash.js';

test('frozen content stays unstamped and reappears with a fresh binding while retired tail stamps remain readable', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        scope = { projectId: 'project' },
        identity = JSON.stringify(['prompt', 'frozen-prompt', 'stamp']);
      await captureViewSession(db);
      const parent = await createEmptyView(db, 'project', 'session', now),
        tail = crypto.randomUUID();
      const hash = async (text: string) =>
        viewContentHash('prompt', { prompt_id: 'frozen-prompt', origin: 'user', text, created_at: 1 });
      const row = async (instance: string, text: string) =>
        db
          .prepare(
            `INSERT INTO view_prompts(project_id,instance_id,session_id,prompt_id,origin,text,content_hash,
    created_at,updated_at,received_at,source_transcript_id,source_offset,source_end,canonical_identity,view_content_hash,hash_scheme,material_seq)
    VALUES(?,?,'session','frozen-prompt','user',?,?,1,1,1,'frozen-source',0,1,?,?,'view-content-v1',NULL)`,
          )
          .bind('project', instance, text, await sha256Hex(text), identity, await hash(text));
      await db.batch([
        db
          .prepare(`UPDATE view_instances SET base='frozen',state='frozen' WHERE project_id=? AND instance_id=?`)
          .bind('project', parent),
        await row(parent, 'H1'),
        db
          .prepare(
            `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at,published_at)
     VALUES(?,?,'session',?,'tail',?,'live',?,?)`,
          )
          .bind('project', tail, PARSER_VERSION, parent, now, now),
        db
          .prepare(`UPDATE session_views SET live_instance=? WHERE project_id=? AND session_id=?`)
          .bind(tail, 'project', 'session'),
        db
          .prepare(`UPDATE view_visible SET role='parent',precedence=1 WHERE project_id=? AND instance_id=?`)
          .bind('project', parent),
        db
          .prepare(
            `INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES(?,?,'session','live',0)`,
          )
          .bind('project', tail),
      ]);
      const frozen = async () =>
        (
          await db
            .prepare(`SELECT * FROM view_prompts WHERE project_id=? AND instance_id=? ORDER BY prompt_id`)
            .bind('project', parent)
            .all()
        ).results;
      const original = await frozen();
      expect(original).toHaveLength(1);
      expect(original[0]).toMatchObject({ material_seq: null });
      const publish = async (shadow?: string) => {
        const instance = await requestViewRebuild(db, 'project', 'session', now);
        if (shadow !== undefined) await db.batch([await row(instance, shadow)]);
        const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
        expect((await tryPublishView(db, target, now, fixtureFlipEnvelope(store))).published).toBe(true);
        expect(await frozen()).toEqual(original);
        return instance;
      };
      const binding = async () =>
        db
          .prepare(
            `SELECT content_hash,material_seq FROM material_versions WHERE project_id=? AND session_id=? AND kind='prompt' AND identity=?`,
          )
          .bind('project', 'session', identity)
          .first<{ content_hash: string; material_seq: number }>();
      const frozenSelection = {
        kind: 'prompt',
        identity,
        contentHash: await hash('H1'),
        hashScheme: 'view-content-v1',
        materialSeq: null,
      };
      await publish();
      const first = (await binding())!;
      expect(first.material_seq, store).toBe(1);
      expect(await readMaterialVersion(db, scope, 'session', frozenSelection)).toEqual({
        state: 'versioned',
        materialSeq: first.material_seq,
      });
      const shadow = await publish('H2'),
        second = (await binding())!;
      expect(second.material_seq).toBeGreaterThan(first.material_seq);
      expect(await readMaterialVersion(db, scope, 'session', frozenSelection)).toEqual({ state: 'superseded' });
      const captured = (await db
        .prepare(`SELECT material_seq,view_content_hash FROM view_prompts WHERE project_id=? AND instance_id=?`)
        .bind('project', shadow)
        .first<{ material_seq: number; view_content_hash: string }>())!;
      const before = (await db
        .prepare(`SELECT next_seq FROM learning_sessions WHERE project_id=? AND session_id=?`)
        .bind('project', 'session')
        .first<{ next_seq: number }>())!.next_seq;
      await publish();
      const third = (await binding())!;
      expect(third.content_hash).toBe(first.content_hash);
      expect(third.material_seq).toBeGreaterThan(second.material_seq);
      expect(third.material_seq).not.toBe(first.material_seq);
      expect(
        (await db
          .prepare(`SELECT next_seq FROM learning_sessions WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first<{ next_seq: number }>())!.next_seq,
      ).toBe(before + 1);
      expect(await readMaterialVersion(db, scope, 'session', frozenSelection)).toEqual({
        state: 'versioned',
        materialSeq: third.material_seq,
      });
      expect(
        await readMaterialVersion(db, scope, 'session', {
          ...frozenSelection,
          contentHash: captured.view_content_hash,
          materialSeq: captured.material_seq,
        }),
      ).toEqual({ state: 'versioned', materialSeq: second.material_seq });
      expect(
        (await db
          .prepare(`SELECT material_seq FROM view_prompts WHERE project_id=? AND instance_id=?`)
          .bind('project', shadow)
          .first<{ material_seq: number }>())!.material_seq,
      ).toBe(second.material_seq);
    }),
  );
}, 120000);
