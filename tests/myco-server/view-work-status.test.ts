import { expect, test } from 'bun:test';
import { withViewStores, captureViewSession, captureViewTranscript } from './helpers/view-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { beforeViewCheckpointRead } from './helpers/view-instances.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { contentAssertion } from '@myco-server-worker/core/registered-content.js';
import { withViewWriterDriver, observedReadStoreFiles } from '../helpers/statement-recorder.js';
import { fixtureFlipEnvelope } from '../helpers/view-flip-envelope.js';
import { createEmptyView, requestViewRebuild } from '@myco-server-worker/ingest/view-lifecycle.js';
import { runViewParseJob } from '@myco-server-worker/ingest/view-run.js';
import { SERIAL_VIEW_BUDGET, claimViewBuild } from '@myco-server-worker/ingest/view-build-queue.js';
import { parseViewOnce } from '@myco-server-worker/ingest/view-parse.js';
import { beginViewSample, finishViewSample } from '@myco-server-worker/ingest/view-work-samples.js';
import {
  readViewStatus,
  VIEW_SAMPLE_MAX_AGE_MS,
  VIEW_STATUS_DETAIL_LIMIT,
} from '@myco-server-worker/read/view-status.js';
import { PARSER_VERSION } from '@myco-server-worker/ingest/parse.js';

const tx = 'tx_0123456789abcdef0123456789abcdef';
const line = (text: string) => JSON.stringify({ role: 'user', message: { content: text } }) + '\n';
const bytes = (text: string) => new TextEncoder().encode(text).length;

test('published work samples survive queue removal and subtract offered growth without replay credit', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore(),
        initial = line('initial'),
        growth = line('offered capture');
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const env = await captureViewTranscript(db, blobs, 'session', tx, initial, now);
      await requestViewRebuild(db, 'project', 'session', now);
      let appended = false;
      const concurrent = beforeViewCheckpointRead(db, async () => {
        if (!appended) {
          appended = true;
          await captureViewTranscript(db, blobs, 'session', tx, growth, Date.now(), bytes(initial));
        }
      });
      const report = await runViewParseJob({ ...env, db: concurrent }, now, {
        profile: SERIAL_VIEW_BUDGET,
        envelope: fixtureFlipEnvelope(store),
      });
      expect(report.published, store).toBe(1);
      const sample = await db
        .prepare(`SELECT * FROM view_work_samples WHERE project_id=? AND session_id=?`)
        .bind('project', 'session')
        .first();
      expect(sample).toMatchObject({
        initial_bytes: bytes(initial),
        offered_bytes: bytes(initial + growth),
        useful_bytes: bytes(initial + growth),
        published_bytes: bytes(initial + growth),
        wakes: 1,
        valid: 1,
        observation_token: null,
        store: store === 'native' ? 'native' : 'remote',
      });
      expect((await db.prepare(`SELECT COUNT(*) n FROM view_build_work`).first<{ n: number }>())!.n).toBe(0);
      const status = await readViewStatus(db, ['project'], Date.now());
      const work = status.states[0]!.work;
      expect(work.state).toBe('measured');
      if (work.state === 'measured') {
        expect(work.netBytes).toBe(bytes(initial));
        expect(work.netBytesPerSecond).toBeGreaterThan(0);
        expect(work.elapsedMs).toBeGreaterThanOrEqual(2000);
        expect(work.rowsRead).toBeNull();
        expect(work.statements).toBe(report.usage.statements);
        expect(work.roundTrips).toBe(report.usage.roundTrips);
        expect(work.blobCalls).toBe(report.usage.blobCalls);
      }
      expect(status.throughput.state).toBe('unavailable');
      expect(
        observedReadStoreFiles()
          .get('tests/myco-server/view-work-status.test.ts')
          ?.has(store === 'native' ? 'native' : 'd1'),
      ).toBe(true);
      await runViewParseJob(env, Date.now(), { profile: SERIAL_VIEW_BUDGET, envelope: fixtureFlipEnvelope(store) });
      expect(
        await db
          .prepare(`SELECT * FROM view_work_samples WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first(),
      ).toEqual(sample);
      expect(
        (await readViewStatus(db, ['project'], Date.now() + VIEW_SAMPLE_MAX_AGE_MS + 1)).states[0]!.work.state,
      ).toBe('unavailable');
    }),
  );
}, 120000);

test('checkpoint rollback gives no progress and interrupted observation remains unavailable', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now(),
        blobs = memoryBlobStore();
      await captureViewSession(db);
      await createEmptyView(db, 'project', 'session', now);
      const env = await captureViewTranscript(db, blobs, 'session', tx, line('checkpoint sample'), now);
      await requestViewRebuild(db, 'project', 'session', now);
      const target = (await claimViewBuild(db, 'project', 'session', SERIAL_VIEW_BUDGET, now))!;
      const token = await beginViewSample(db, target, fixtureFlipEnvelope(store).store, 'serial', now);
      const statements = new WeakMap<PreparedStatement, { raw: PreparedStatement; sql: string }>();
      const wrap = (raw: PreparedStatement, sql: string): PreparedStatement => {
        const held: PreparedStatement = {
          bind: (...values) => wrap(raw.bind(...values), sql),
          first: <T>() => raw.first<T>(),
          all: <T>() => raw.all<T>(),
          run: () => raw.run(),
        };
        statements.set(held, { raw, sql });
        return held;
      };
      const broken: RelationalStore = {
        prepare: (sql) => wrap(db.prepare(sql), sql),
        batch: (held) => {
          const selected = held.map((statement) => {
            const found = statements.get(statement);
            if (!found) throw new Error('unknown statement');
            return found;
          });
          return db.batch([
            ...selected.map((statement) => statement.raw),
            ...(selected.some((statement) => statement.sql.includes('UPDATE view_checkpoints SET parsed_offset='))
              ? contentAssertion(db, '0', [])
              : []),
          ]);
        },
      };
      await expect(
        parseViewOnce({ ...env, db: broken }, target, now, {
          calls: 500,
          deadline: Date.now() + 15000,
          clock: Date.now,
        }),
      ).rejects.toThrow();
      expect(
        (await db
          .prepare(`SELECT useful_bytes FROM view_work_samples WHERE project_id=? AND session_id=?`)
          .bind('project', 'session')
          .first<{ useful_bytes: number }>())!.useful_bytes,
      ).toBe(0);
      await parseViewOnce(env, target, now, { calls: 500, deadline: Date.now() + 15000, clock: Date.now });
      const replacement = await beginViewSample(db, target, fixtureFlipEnvelope(store).store, 'serial', now);
      await finishViewSample(db, target, token, { statements: 1, roundTrips: 1, blobCalls: 0 }, 1, 1, null);
      await finishViewSample(db, target, replacement, { statements: 1, roundTrips: 1, blobCalls: 0 }, 1, 1, null);
      const status = await readViewStatus(db, ['project'], Date.now());
      expect(status.states[0]!.work).toEqual({ state: 'unavailable', reason: 'rebuild measurement is incomplete' });
    }),
  );
}, 120000);

test('status bounds session details and scopes cleanup and findings while propagating read failures', async () => {
  await withViewStores(async (db, store) =>
    withViewWriterDriver(async () => {
      const now = Date.now();
      await captureViewSession(db);
      await captureViewSession(db, 'other', 'private');
      const live = await createEmptyView(db, 'project', 'session', now);
      const hidden = await createEmptyView(db, 'other', 'private', now);
      await db.batch([
        db
          .prepare(
            `INSERT INTO view_instances(project_id,instance_id,session_id,parser_version,base,state,created_at,retired_at)
     VALUES('project','retired','session',?,'full','retired',1,1)`,
          )
          .bind(PARSER_VERSION),
        db
          .prepare(
            `INSERT INTO view_findings(project_id,instance_id,session_id,kind,record_id,n,count) VALUES(?,?,?,'unattributed','record',1,?)`,
          )
          .bind('project', live, 'session', 3),
        db
          .prepare(
            `INSERT INTO view_findings(project_id,instance_id,session_id,kind,record_id,n,count) VALUES(?,?,?,'unattributed','private',1,?)`,
          )
          .bind('other', hidden, 'private', 91),
        db
          .prepare(
            `INSERT INTO sessions(project_id,session_id,machine_id,agent,started_at,created_by_token_id,first_received_at,last_received_at)
     SELECT 'project','detail-'||value,'machine','cursor',1,s.created_by_token_id,1,1 FROM sessions s CROSS JOIN json_each(?)
     WHERE s.project_id='project' AND s.session_id='session'`,
          )
          .bind(JSON.stringify(Array.from({ length: VIEW_STATUS_DETAIL_LIMIT + 1 }, (_, i) => i))),
      ]);
      const readonly = {
        ...db,
        prepare: (sql: string) => {
          if (/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) throw new Error('status wrote');
          return db.prepare(sql);
        },
      };
      const status = await readViewStatus(readonly, ['project', 'project'], now);
      expect(status.details, store).toEqual({
        limit: VIEW_STATUS_DETAIL_LIMIT,
        total: VIEW_STATUS_DETAIL_LIMIT + 2,
        complete: false,
      });
      expect(status.states).toHaveLength(VIEW_STATUS_DETAIL_LIMIT);
      expect(status.cleanup).toEqual({ retired: 1, abandoned: 0, eligibleRetired: 1, heldRetired: 0 });
      expect(status.findings).toEqual([{ kind: 'unattributed', count: 3 }]);
      expect(status.unplaced.state).toBe('unavailable');
      expect(status.coverageNotCarried.state).toBe('unavailable');
      expect(status.states.every((row) => row.project_id === 'project')).toBe(true);
      expect(status.states.every((row) => row.service_ms === null)).toBe(true);
      const failed = {
        ...readonly,
        prepare: () => {
          throw new Error('status read failed');
        },
      };
      await expect(readViewStatus(failed, ['project'], now)).rejects.toThrow('status read failed');
    }),
  );
}, 120000);
