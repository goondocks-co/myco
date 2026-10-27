import { expect, test } from 'bun:test';
import { withViewStores, withViewStorePair, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { memoryBlobStore, envelope, uuid } from './helpers/fixtures.js';
import { setViewParserVersion } from './helpers/view-instances.js';
import { withViewWriterDriver, statementRecorder } from '../helpers/statement-recorder.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';
import { ingestPublishedMaterialEvent } from '@myco-server-worker/core/material-fact-writer.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';

const prompt = uuid(90),
  transcript = 'tx_0123456789abcdef0123456789abcdef';
const text = (now: number) =>
  JSON.stringify({ v: 1, type: 'prompt', promptId: prompt, text: 'view-only prompt', at: now }) + '\n';
async function ready(
  db: RelationalStore,
  store: 'native' | 'D1',
  blobs: ReturnType<typeof memoryBlobStore>,
  now: number,
) {
  await captureViewSession(db);
  await createEmptyView(db, 'project', 'session', now);
  const env = await captureViewTranscript(db, blobs, 'session', transcript, text(now), now, 0, 'opencode');
  const build = async () => {
    const id = await requestViewRebuild(db, 'project', 'session', now),
      target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
    await parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 15000, clock: Date.now });
    return { id, target };
  };
  const first = await build();
  expect((await tryPublishView(db, first.target, now, fixtureFlipEnvelope(store))).published).toBe(true);
  return { env, build, live: first.id };
}

for (const mode of ['live', 'stale', 'frozen'] as const)
  test(
    'a fact reply naming only a ' + mode + ' view prompt versions itself and leaves that representation unchanged',
    async () => {
      await withViewStores(async (db, store) =>
        withViewWriterDriver(async () => {
          const now = Date.now(),
            blobs = memoryBlobStore(),
            source = await ready(db, store, blobs, now);
          if (mode === 'stale') await setViewParserVersion(db, 'project', source.live, PARSER_VERSION - 1);
          if (mode === 'frozen') {
            const tail = crypto.randomUUID();
            await db.batch([
              db
                .prepare(`UPDATE view_prompts SET material_seq=NULL WHERE project_id=? AND instance_id=?`)
                .bind('project', source.live),
              db
                .prepare(`UPDATE view_instances SET base='frozen',state='frozen' WHERE project_id=? AND instance_id=?`)
                .bind('project', source.live),
              db
                .prepare(
                  `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,parent_instance,state,created_at)
      VALUES(?,?,'session',?,'tail',?,'live',?)`,
                )
                .bind('project', tail, PARSER_VERSION, source.live, now),
              db
                .prepare(`UPDATE session_views SET live_instance=? WHERE project_id=? AND session_id=?`)
                .bind(tail, 'project', 'session'),
              db
                .prepare(`UPDATE view_visible SET role='parent',precedence=1 WHERE project_id=? AND instance_id=?`)
                .bind('project', source.live),
              db
                .prepare(
                  `INSERT INTO view_visible(project_id,instance_id,session_id,role,precedence) VALUES(?,?,'session','live',0)`,
                )
                .bind('project', tail),
            ]);
          }
          const snapshot = async () => ({
            row: await db
              .prepare(`SELECT * FROM view_prompts WHERE project_id=? AND instance_id=? AND prompt_id=?`)
              .bind('project', source.live, prompt)
              .first(),
            binding: await db
              .prepare(
                `SELECT * FROM material_versions WHERE project_id=? AND session_id=? AND kind='prompt' AND record_id=?`,
              )
              .bind('project', 'session', prompt)
              .first(),
          });
          const before = await snapshot(),
            counter = (await db
              .prepare(`SELECT next_seq FROM learning_sessions WHERE project_id=? AND session_id=?`)
              .bind('project', 'session')
              .first<{ next_seq: number }>())!.next_seq;
          const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'machine' }, now),
            observed = statementRecorder(db, { accounting: store === 'D1' ? 'd1' : 'native' });
          expect(
            (
              await ingestPublishedMaterialEvent(
                { db: observed.db, blobs },
                { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now },
                envelope({
                  eventId: uuid(901),
                  sessionId: 'session',
                  kind: 'response',
                  createdAt: now + 1,
                  payload: { responseId: uuid(902), promptId: prompt, text: 'fact reply' },
                }),
              )
            ).persisted,
          ).toBe(true);
          expect(await snapshot(), store).toEqual(before);
          expect(
            (await db
              .prepare(`SELECT next_seq FROM learning_sessions WHERE project_id=? AND session_id=?`)
              .bind('project', 'session')
              .first<{ next_seq: number }>())!.next_seq,
          ).toBe(counter + 1);
          expect(
            (await db
              .prepare(
                `SELECT material_seq FROM material_versions WHERE project_id=? AND kind='response' AND record_id=?`,
              )
              .bind('project', uuid(902))
              .first<{ material_seq: number }>())!.material_seq,
          ).toBe(counter);
          const writes = observed.statements.filter((row) =>
            /^(?:WITH[\s\S]*?\b)?(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(row.sql.trim()),
          );
          expect(
            writes.some((row) => /\b(?:INTO|UPDATE|FROM)\s+view_(?!publication_material\b)[a-z_]+/i.test(row.sql)),
          ).toBe(false);
        }),
      );
    },
    120000,
  );

test('a hook reply between the final rebuild pass and publication changes no prompt hash or carry decision', async () => {
  for (const store of ['native', 'D1'] as const) {
    if (process.env.MYCO_VIEW_TEST_STORE && process.env.MYCO_VIEW_TEST_STORE !== store) continue;
    await withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore();
      let held: Awaited<ReturnType<typeof ready>>;
      let target: Awaited<ReturnType<Awaited<ReturnType<typeof ready>>['build']>>;
      await withViewStorePair(
        store,
        async (db) => {
          held = await ready(db, store, blobs, now);
          target = await held.build();
        },
        async (baseline, candidate) => {
          const binding = (db: RelationalStore) =>
            db
              .prepare(
                `SELECT content_hash,hash_scheme,material_seq FROM material_versions WHERE project_id=? AND session_id=? AND kind='prompt' AND record_id=?`,
              )
              .bind('project', 'session', prompt)
              .first();
          const before = await binding(candidate);
          expect((await tryPublishView(baseline, target.target, now, fixtureFlipEnvelope(store))).published).toBe(true);
          const issued = await issueMemberToken(candidate, { memberId: 'member', machineId: 'machine' }, now);
          expect(
            (
              await ingestPublishedMaterialEvent(
                { db: candidate, blobs },
                { projectId: 'project', machineId: 'machine', tokenId: issued.tokenId, bodyBytes: 1, now },
                envelope({
                  eventId: uuid(903),
                  sessionId: 'session',
                  kind: 'response',
                  createdAt: now + 1,
                  payload: { responseId: uuid(904), promptId: prompt, text: 'concurrent fact reply' },
                }),
              )
            ).persisted,
          ).toBe(true);
          expect((await tryPublishView(candidate, target.target, now, fixtureFlipEnvelope(store))).published).toBe(
            true,
          );
          expect(await binding(candidate), store).toEqual(before);
          expect(await binding(candidate)).toEqual(await binding(baseline));
        },
      );
    });
  }
}, 120000);
