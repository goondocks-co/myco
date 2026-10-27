import { expect, test } from 'bun:test';
import { withViewStores } from './helpers/view-stores.js';
import { envelope, uuid, memoryBlobStore } from './helpers/fixtures.js';
import { beforeViewWriteBatch } from './helpers/view-instances.js';
import { withViewWriterDriver } from '../helpers/statement-recorder.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import {
  prepareInjectionReceipt,
  prepareContextDelivery,
  prepareSessionRecord,
} from '@myco-server-worker/core/context-writes.js';
import {
  commitPublishedContextWrite,
  restorePublishedMaterial,
} from '@myco-server-worker/core/material-fact-writer.js';
import {
  composePromptContext,
  composeSessionContext,
  recordSessionInjection,
  recallLeaves,
} from '@myco-server-worker/core/recall.js';
import { sessionWriteAdmission } from '@myco-server-worker/ingest/projections.js';
import {
  exportMaterialVersions,
  restoreMaterialVersionStatements,
} from '@myco-server-worker/core/material-version-backup.js';
import { publicationVersionStatements, finishVersionStatements } from '@myco-server-worker/core/material-versions.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { createEmptyView, requestViewRebuild, tryPublishView } from '@myco-server-worker/ingest/view-lifecycle.js';
import { claimViewBuild, SERIAL_VIEW_BUDGET } from '@myco-server-worker/ingest/view-build-queue.js';
import { tombstoneSession, tombstoneMarkStatements } from '@myco-server-worker/core/tombstones.js';

const scope = { projectId: 'project' },
  session = 'before-capture';
const admission = () => sessionWriteAdmission({ projectId: 'project', machineId: 'recall-machine' }, session);
const leaves = recallLeaves({ 'cortex.spores.inject_on_prompt_submit': false });

test('pre-session recall allocates at each write, round-trips its unit and survives later capture and publication', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now();
      await ensureMember(db, 'member', now, 'member');
      await commitPublishedContextWrite(
        db,
        prepareInjectionReceipt(
          db,
          {
            project: 'project',
            session,
            id: 'receipt',
            promptId: null,
            scopeReason: 'absent_key',
            protocol: 'legacy',
            askedAt: null,
            promptHash: 'first-prompt',
            spores: [],
            plans: [],
            now,
          },
          admission().admission,
        ),
      );
      const answer = await composePromptContext(
        db,
        scope,
        leaves,
        false,
        { sessionId: session, text: 'context before capture', scopeReason: 'absent_key', now, admission: admission() },
        undefined,
        undefined,
        undefined,
        commitPublishedContextWrite,
      );
      expect(answer.answerId, store).toBeString();
      await composeSessionContext(
        db,
        scope,
        leaves,
        true,
        { sessionId: session, kind: 'start', now },
        { admission: admission() },
        commitPublishedContextWrite,
      );
      const initial = (await exportMaterialVersions(db, 'project', session))!;
      expect(initial.bindings).toHaveLength(3);
      expect(initial.nextSeq).toBe(4);
      expect(initial.bindings.every((row) => row.owner === 'fact' && row.material_seq > 0)).toBe(true);
      expect(new Set(initial.bindings.map((row) => row.material_seq)).size).toBe(3);
      await commitPublishedContextWrite(
        db,
        prepareContextDelivery(
          db,
          'injection',
          {
            projectId: 'project',
            sessionId: session,
            id: 'receipt',
            at: now + 1,
            promptId: null,
            scopeReason: 'absent_key',
          },
          admission().admission,
        ),
      );
      const delivered = (await exportMaterialVersions(db, 'project', session))!;
      expect(delivered.nextSeq).toBe(initial.nextSeq + 1);
      expect(delivered.bindings).toHaveLength(3);
      expect((await db.prepare(`SELECT COUNT(*) n FROM sessions`).first<{ n: number }>())!.n).toBe(0);
      expect((await db.prepare(`SELECT COUNT(*) n FROM events`).first<{ n: number }>())!.n).toBe(0);
      await db.batch(restoreMaterialVersionStatements(db, 'other', session, delivered));
      expect(await exportMaterialVersions(db, 'other', session)).toEqual(delivered);
      for (const table of ['spore_injections', 'prompt_context_answers', 'session_injections']) {
        const rows = (
          await db
            .prepare(`SELECT * FROM ${table} WHERE project_id=? AND session_id=?`)
            .bind('project', session)
            .all<Record<string, unknown>>()
        ).results;
        for (const row of rows)
          expect(
            (await restorePublishedMaterial({ db, blobs: memoryBlobStore() }, table, { ...row, project_id: 'other' }))
              .results,
          ).toHaveLength(1);
        expect(
          (await db
            .prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=? AND session_id=?`)
            .bind('other', session)
            .first<{ n: number }>())!.n,
        ).toBe(rows.length);
      }
      expect(await exportMaterialVersions(db, 'other', session)).toEqual(delivered);
      expect((await db.prepare(`SELECT COUNT(*) n FROM sessions`).first<{ n: number }>())!.n).toBe(0);
      const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'capture-machine' }, now);
      expect(
        (
          await ingestEvent(
            db,
            { projectId: 'project', machineId: 'capture-machine', tokenId: issued.tokenId, bodyBytes: 1, now },
            envelope({
              sessionId: session,
              eventId: uuid(80),
              kind: 'session.start',
              payload: { agent: 'cursor', startedAt: now },
            }),
          )
        ).persisted,
      ).toBe(true);
      expect(await exportMaterialVersions(db, 'project', session)).toEqual(delivered);
      expect(
        (await db
          .prepare(`SELECT machine_id FROM sessions WHERE project_id=? AND session_id=?`)
          .bind('project', session)
          .first<{ machine_id: string }>())!.machine_id,
      ).toBe('capture-machine');
      await createEmptyView(db, 'project', session, now);
      await requestViewRebuild(db, 'project', session, now);
      const target = (await claimViewBuild(db, 'project', session, SERIAL_VIEW_BUDGET, now))!;
      expect((await tryPublishView(db, target, now, fixtureFlipEnvelope(store))).published).toBe(true);
      expect(await exportMaterialVersions(db, 'project', session)).toEqual(delivered);
      const capturedAdmission = sessionWriteAdmission({ projectId: 'project', machineId: 'capture-machine' }, session);
      await commitPublishedContextWrite(
        db,
        prepareContextDelivery(
          db,
          'answer',
          {
            projectId: 'project',
            sessionId: session,
            id: answer.answerId!,
            at: now + 2,
            promptId: null,
            scopeReason: 'absent_key',
          },
          capturedAdmission.admission,
        ),
      );
      const final = (await exportMaterialVersions(db, 'project', session))!;
      expect(final.nextSeq).toBe(delivered.nextSeq + 1);
      expect(final.bindings.find((row) => row.record_id === answer.answerId)!.material_seq).toBeGreaterThan(
        delivered.maxSeq,
      );
      expect((await tombstoneSession({ db }, scope, session, 'member', now + 3)).applied).toBe(true);
      for (const table of [
        'learning_sessions',
        'material_versions',
        'view_publication_material',
        'spore_injections',
        'prompt_context_answers',
        'session_injections',
      ])
        expect(
          (await db
            .prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=? AND session_id=?`)
            .bind('project', session)
            .first<{ n: number }>())!.n,
        ).toBe(0);
      expect(
        (
          await recordSessionInjection(
            db,
            scope,
            session,
            'cortex',
            now + 4,
            capturedAdmission,
            commitPublishedContextWrite,
          )
        ).outcome,
      ).toBe('refused');
    }),
  );
}, 120000);

test('recall admission rejects tombstones, another machine and a tombstone committed immediately before its batch', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now();
      await ensureMember(db, 'member', now, 'member');
      const issued = await issueMemberToken(db, { memberId: 'member', machineId: 'owner' }, now);
      await ingestEvent(
        db,
        { projectId: 'project', machineId: 'owner', tokenId: issued.tokenId, bodyBytes: 1, now },
        envelope({
          sessionId: session,
          eventId: uuid(81),
          kind: 'session.start',
          payload: { agent: 'cursor', startedAt: now },
        }),
      );
      expect(
        (await recordSessionInjection(db, scope, session, 'cortex', now, admission(), commitPublishedContextWrite))
          .outcome,
        store,
      ).toBe('refused');
      const refused = admission().admission,
        attempt = 'admission-probe';
      await db.batch([
        ...prepareSessionRecord(db, 'project', session, 'cortex', now, refused).statements,
        ...publicationVersionStatements(
          db,
          'project',
          session,
          attempt,
          {
            items: [{ kind: 'session-record', identity: 'probe', recordId: 'cortex', hash: 'probe', owner: 'fact' }],
            when: refused,
          },
          false,
        ),
        ...finishVersionStatements(db, 'project', session, attempt),
      ]);
      const absent = async () => {
        for (const table of ['learning_sessions', 'material_versions', 'view_publication_material'])
          expect(
            (await db
              .prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?`)
              .bind('project')
              .first<{ n: number }>())!.n,
          ).toBe(0);
      };
      await absent();
      const raceSession = 'racing';
      const raceAdmission = sessionWriteAdmission({ projectId: 'project', machineId: 'recall-machine' }, raceSession);
      const raced = beforeViewWriteBatch(
        db,
        (sql) => sql.includes('INSERT OR IGNORE INTO session_injections'),
        async () => {
          await db.batch(tombstoneMarkStatements(db, 'project', raceSession, 'member', now));
        },
        true,
      );
      expect(
        (
          await recordSessionInjection(
            raced,
            scope,
            raceSession,
            'cortex',
            now,
            raceAdmission,
            commitPublishedContextWrite,
          )
        ).outcome,
      ).toBe('refused');
      expect(
        (
          await recordSessionInjection(
            db,
            scope,
            raceSession,
            'cortex',
            now,
            raceAdmission,
            commitPublishedContextWrite,
          )
        ).outcome,
      ).toBe('refused');
      await absent();
    }),
  );
}, 120000);

test('answer retention deletes current bindings atomically with its bounded answer batch', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const { preparePromptAnswer } = await import('@myco-server-worker/core/context-writes.js');
      const { prunePromptAnswers } = await import('@myco-server-worker/core/recall.js');
      const { contentAssertion } = await import('@myco-server-worker/core/registered-content.js');
      for (let i = 0; i < 3; i++)
        await commitPublishedContextWrite(
          db,
          preparePromptAnswer(
            db,
            {
              project: 'project',
              session: 'before-capture',
              id: 'retained-' + i,
              promptId: null,
              scopeReason: 'absent_key',
              protocol: 'legacy',
              askedAt: null,
              receiptId: null,
              outcome: 'empty',
              chars: 0,
              parts: [],
              skipped: [],
              failures: [],
              selection: {},
              now: i + 1,
            },
            { sql: '1', params: [] },
          ),
        );
      const snapshot = async () => ({
        answers: (await db.prepare('SELECT id FROM prompt_context_answers ORDER BY id').all()).results,
        bindings: (
          await db
            .prepare('SELECT record_id FROM material_versions WHERE kind=? ORDER BY record_id')
            .bind('answer')
            .all()
        ).results,
      });
      const before = await snapshot();
      const broken = {
        prepare: db.prepare.bind(db),
        batch: (statements: Parameters<typeof db.batch>[0]) =>
          db.batch([...statements, ...contentAssertion(db, '0', [])]),
      };
      await expect(prunePromptAnswers(broken, 3, 1)).rejects.toThrow();
      expect(await snapshot(), store).toEqual(before);
      expect(await prunePromptAnswers(db, 3, 1)).toBe(1);
      const after = await snapshot();
      expect(after.answers).toHaveLength(2);
      expect(after.bindings.map((row) => row.record_id)).toEqual(after.answers.map((row) => row.id));
      expect(await prunePromptAnswers(db, 3, 10)).toBe(1);
      expect((await snapshot()).bindings).toEqual([{ record_id: 'retained-2' }]);
    }),
  );
}, 120000);

test('partial answer retention keeps row and binding targets identical across Projects and sessions', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const { preparePromptAnswer } = await import('@myco-server-worker/core/context-writes.js');
      const { prunePromptAnswers } = await import('@myco-server-worker/core/recall.js');
      for (const [project, session, id, at] of [
        ['project', 'first', 'one', 1],
        ['other', 'second', 'two', 1],
        ['project', 'third', 'three', 1],
        ['other', 'fourth', 'four', 100],
      ] as const) {
        await commitPublishedContextWrite(
          db,
          preparePromptAnswer(
            db,
            {
              project,
              session,
              id,
              promptId: null,
              scopeReason: 'absent_key',
              protocol: 'legacy',
              askedAt: null,
              receiptId: null,
              outcome: 'empty',
              chars: 0,
              parts: [],
              skipped: [],
              failures: [],
              selection: {},
              now: at,
            },
            { sql: '1', params: [] },
          ),
        );
      }
      for (let pass = 0; pass < 3; pass++) {
        expect(await prunePromptAnswers(db, 10, 1)).toBe(1);
        const rows = (
          await db
            .prepare('SELECT project_id,session_id,id FROM prompt_context_answers ORDER BY project_id,session_id,id')
            .all()
        ).results;
        const bindings = (
          await db
            .prepare(
              "SELECT project_id,session_id,record_id id FROM material_versions WHERE kind='answer' ORDER BY project_id,session_id,record_id",
            )
            .all()
        ).results;
        expect(bindings, store).toEqual(rows);
      }
      expect(await prunePromptAnswers(db, 10, 1)).toBe(0);
    }),
  );
}, 120000);
