import { expect, it } from 'bun:test';
import { parseTraces } from '@myco-server-worker/core/otlp.js';
import { storeTelemetrySpans } from '@myco-server-worker/db/telemetry/ingest.js';
import { insertTelemetryKey, revokeTelemetryKey } from '@myco-server-worker/db/telemetry/keys.js';
import { reconcileTelemetry } from '@myco-server-worker/core/telemetry-matching.js';
import { telemetryReconciliationDue } from '@myco-server-worker/db/telemetry/matching.js';
import { pruneTelemetry, telemetryRetentionDue } from '@myco-server-worker/db/telemetry/retention.js';
import { cleanRevokedTelemetry, revokedTelemetryDue } from '@myco-server-worker/db/telemetry/revocation.js';
import { lineage_sessionLineage } from '@myco-server-worker/read/catalog/lineage.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';
import { telemetryBatch, telemetrySpan, telemetryTrace } from './helpers/telemetry.js';
const NOW = 1_800_000_000_000;

it('ingest, lineage and an unchanged wake remain bounded as settled history grows', async () => {
  const costs = await d1TwoScale({
    sizes: [40, 4000],
    setup: async (db) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_otel','Telemetry',1)").run();
      await db
        .prepare(
          `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
   VALUES('proj_otel','lead','machine','credential',?1,?1),('proj_otel','worker','machine','credential',?1,?1),('proj_otel','history-lead','machine','credential',?1,?1)`,
        )
        .bind(NOW)
        .run();
      await insertTelemetryKey(db, {
        id: 'test-key',
        hash: 'test-hash',
        label: 'cost sender',
        actor: 'member',
        now: NOW,
      });
      for (let group = 0; group < Math.ceil(4000 / 350); group++) {
        const key = `history-${group}`;
        await insertTelemetryKey(db, { id: key, hash: key, label: 'History sender', actor: 'member', now: NOW });
      }
      await storeTelemetrySpans(db, {
        key: 'test-key',
        spans: parseTraces(telemetryTrace('lead', 'worker')).spans,
        now: NOW,
      });
      await reconcileTelemetry(db, NOW);
    },
    grow: async (db, from, to) => {
      await eachUnit(
        db,
        from,
        to,
        `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
   SELECT 'proj_otel','other-'||i,'machine','credential',?3,?3 FROM n`,
        NOW,
      );
      for (let offset = from; offset < to; ) {
        const group = Math.floor(offset / 350),
          key = `history-${group}`,
          count = Math.min(100, to - offset, 350 - (offset % 350));
        const body = Array.from({ length: count }, (_, i) => telemetryTrace('history-lead', `other-${offset + i}`));
        const spans = body.flatMap((batch, i) =>
          batch.resourceSpans[0]!.scopeSpans[0]!.spans.filter((_, index) => index !== 1).map((span) => ({
            ...span,
            traceId: (offset + i + 100).toString(16).padStart(32, '0'),
          })),
        );
        await storeTelemetrySpans(db, { key, spans: parseTraces(telemetryBatch(spans)).spans, now: NOW });
        offset += count;
      }
      while (await telemetryReconciliationDue(db, NOW)) await reconcileTelemetry(db, NOW);
    },
    cases: [
      {
        name: 'ingest one new span',
        run: async (db, { scale }) =>
          expect(
            (
              await storeTelemetrySpans(db, {
                key: 'test-key',
                spans: parseTraces(telemetryBatch([telemetrySpan(1, { trace: 100000 + scale })])).spans,
                now: NOW,
              })
            ).retained,
          ).toBeGreaterThan(0),
      },
      {
        name: 'read recorded lineage',
        run: async (db) =>
          expect((await lineage_sessionLineage(db, { projectId: 'proj_otel' }, 'worker'))?.edges).toContainEqual(
            expect.objectContaining({ parentId: 'lead', childId: 'worker', source: 'telemetry' }),
          ),
      },
      {
        name: 'settled wake',
        run: async (db, { store }) => {
          while (await telemetryReconciliationDue(store, NOW)) await reconcileTelemetry(store, NOW);
          await cleanRevokedTelemetry(db);
          await pruneTelemetry(db, NOW, 64);
          await reconcileTelemetry(db, NOW);
          expect(await telemetryReconciliationDue(db, NOW)).toBe(false);
          expect(await telemetryRetentionDue(db, NOW)).toBe(false);
        },
      },
    ],
  });
  expectTwoScale(costs.filter((cost) => cost.name !== 'settled wake'));
  const wake = costs.find((cost) => cost.name === 'settled wake')!;
  expect(wake.reads[1]).toBeLessThanOrEqual(wake.reads[0]);
  expect(wake.writes.some(Boolean)).toBe(false);
}, 300000);

it('appending a full batch does not rescan the held trace per span', async () => {
  let key = '',
    trace = 0;
  const costs = await d1TwoScale({
    sizes: [0, 256],
    grow: async (db, _from, to) => {
      key = `append-${to}`;
      trace = 20000 + to;
      await insertTelemetryKey(db, { id: key, hash: key, label: 'Append sender', actor: 'member', now: NOW });
      if (to > 0)
        await storeTelemetrySpans(db, {
          key,
          spans: parseTraces(telemetryBatch(Array.from({ length: to }, (_, i) => telemetrySpan(i + 1, { trace }))))
            .spans,
          now: NOW,
        });
    },
    cases: [
      {
        name: 'append 256 spans',
        extra: 16,
        run: async (db) => {
          const spans = parseTraces(
            telemetryBatch(Array.from({ length: 256 }, (_, i) => telemetrySpan(1000 + i, { trace }))),
          ).spans;
          expect((await storeTelemetrySpans(db, { key, spans, now: NOW })).retained).toBe(spans.length);
        },
      },
    ],
  });
  expectTwoScale(costs);
}, 120000);

it('revocation writes one authority row and cleanup takes a fixed page', async () => {
  let key = '';
  const costs = await d1TwoScale({
    sizes: [100, 700],
    setup: async (db) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_rev','Revocation',1)").run();
      await db
        .prepare(
          "INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_rev','worker','machine','credential',1,1)",
        )
        .run();
      for (const size of [100, 700]) {
        const id = `revoke-${size}`;
        await insertTelemetryKey(db, { id, hash: id, label: 'Revoked sender', actor: 'member', now: NOW });
      }
    },
    grow: async (db, _from, to) => {
      key = `revoke-${to}`;
      await eachUnit(
        db,
        0,
        to,
        `INSERT INTO telemetry_spans(trace_id,span_id,key_id,name,kind,start_ns,end_ns,start_ms,end_ms,attributes,status,received_at)
   SELECT printf('%032x',i+?4),printf('%016x',i+1),?3,'fixture',1,'0','0',0,0,'{}',0,?5 FROM n`,
        key,
        to * 1000,
        NOW,
      );
      await db
        .prepare(
          "INSERT INTO telemetry_resolutions(trace_id,span_id,key_id,project_id,session_id,matched_by,invocation,evidence) SELECT trace_id,span_id,key_id,'proj_rev','worker','exact',1,json_array(key_id) FROM telemetry_spans WHERE key_id=?1",
        )
        .bind(key)
        .run();
      await db
        .prepare(
          'INSERT INTO telemetry_resolution_keys(trace_id,span_id,key_id) SELECT trace_id,span_id,key_id FROM telemetry_resolutions WHERE key_id=?1',
        )
        .bind(key)
        .run();
    },
    cases: [
      {
        name: 'end key authority',
        run: async (db) => expect(await revokeTelemetryKey(db, { id: key, actor: 'member', now: NOW })).toBe(true),
      },
      {
        name: 'remove one revoked page',
        run: async (db, { store }) => {
          expect(await cleanRevokedTelemetry(db)).toBeGreaterThan(0);
          while (await revokedTelemetryDue(store)) await cleanRevokedTelemetry(store);
        },
      },
    ],
  });
  expectTwoScale(costs);
}, 120000);
