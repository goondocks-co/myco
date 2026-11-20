import { expect, it } from 'bun:test';
import { receiveTelemetry } from '@myco-server-worker/core/telemetry-receiver.js';
import { deploymentIdentity } from '@myco-server-worker/auth/authorization.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { parseTraces as parseAtReceipt } from '@myco-server-worker/core/otlp.js';
import {
  countTelemetry,
  storeTelemetrySpans,
  telemetryCounts,
} from '@myco-server-worker/db/telemetry/ingest.js';
import {
  insertTelemetryKey,
  revokeTelemetryKey,
  telemetryKeys,
} from '@myco-server-worker/db/telemetry/keys.js';
import { runTelemetryWork } from '@myco-server-worker/core/telemetry-work.js';
import { reconcileTelemetry } from '@myco-server-worker/core/telemetry-matching.js';
import { telemetryReconciliationDue } from '@myco-server-worker/db/telemetry/matching.js';
import { pruneTelemetry, telemetryRetentionDue } from '@myco-server-worker/db/telemetry/retention.js';
import { cleanRevokedTelemetry, revokedTelemetryDue } from '@myco-server-worker/db/telemetry/revocation.js';
import { telemetrySessionChangesDue } from '@myco-server-worker/db/telemetry/changes.js';
import { lineage_sessionLineage } from '@myco-server-worker/read/catalog/lineage.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';
import { telemetryBatch, telemetrySpan, telemetryTrace } from './helpers/telemetry.js';
const NOW = 1_800_000_000_000;
const parseTraces = (raw: unknown) => parseAtReceipt(raw, NOW);

it('ingest, lineage and an unchanged wake remain bounded as settled history grows', async () => {
  const costs = await d1TwoScale({
    sizes: [40, 4000],
    setup: async (db) => {
      await db
        .prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_otel','Telemetry',1)")
        .run();
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
      await insertTelemetryKey(db, {
        id: 'history',
        hash: 'history',
        label: 'History sender',
        actor: 'member',
        now: NOW,
      });
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
        const key = 'history',
          count = Math.min(100, to - offset);
        const body = Array.from({ length: count }, (_, i) =>
          telemetryTrace('history-lead', `other-${offset + i}`),
        );
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
          expect(
            (await lineage_sessionLineage(db, { projectId: 'proj_otel' }, 'worker'))?.edges,
          ).toContainEqual(
            expect.objectContaining({ parentId: 'lead', childId: 'worker', source: 'telemetry' }),
          ),
      },
      {
        name: 'settled wake',
        run: async (db, { store }) => {
          while (await telemetryReconciliationDue(store, NOW)) await reconcileTelemetry(store, NOW);
          expect(await runTelemetryWork(db, NOW)).toEqual({ changed: 0, more: false });
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
          spans: parseTraces(
            telemetryBatch(Array.from({ length: to }, (_, i) => telemetrySpan(i + 1, { trace }))),
          ).spans,
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
      await db
        .prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_rev','Revocation',1)")
        .run();
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
          "INSERT INTO telemetry_resolutions(trace_id,span_id,key_id,project_id,session_id,matched_by,invocation) SELECT trace_id,span_id,key_id,'proj_rev','worker','exact',1 FROM telemetry_spans WHERE key_id=?1",
        )
        .bind(key)
        .run();
    },
    cases: [
      {
        name: 'end key authority',
        run: async (db) =>
          expect(await revokeTelemetryKey(db, { id: key, actor: 'member', now: NOW })).toBe(true),
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

it('receiver no-ops write nothing and idle work reads one flag as live keys grow', async () => {
  const base = sqliteEnv(),
    key = 'mycootel_' + 'A'.repeat(43);
  const pending: Array<() => Promise<void>> = [];
  let scale = 0;
  const costs = await d1TwoScale({
    sizes: [1, 8],
    setup: async (db) => {
      await deploymentIdentity(db);
    },
    grow: async (db, from, to) => {
      for (let i = from; i < to; i++)
        await insertTelemetryKey(db, {
          id: `http-${i}`,
          hash: i === 0 ? await sha256Hex(key) : `hash-${i}`,
          label: 'Cost sender',
          actor: 'member',
          now: NOW,
        });
      if (from === 0) {
        await countTelemetry(db, { key: 'http-0', now: NOW - 2 * 86400000, rejected: 1 });
        await runTelemetryWork(db, NOW);
        expect(await telemetryCounts(db, NOW - 3 * 86400000)).toEqual([]);
      }
      await storeTelemetrySpans(db, {
        key: 'http-0',
        spans: parseTraces(telemetryBatch([telemetrySpan(1, { trace: 9999 })])).spans,
        now: NOW,
      });
      await reconcileTelemetry(db, NOW);
    },
    cases: [
      ...[
        ['malformed JSON', '{', 'traces'],
        ['logs', { resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] }, 'logs'],
        ['empty export', {}, 'traces'],
        ['identical retry', telemetryBatch([telemetrySpan(1, { trace: 9999 })]), 'traces'],
        ['one new span', null, 'traces'],
        ['256 new spans', null, 'traces'],
      ].map(([name, body, signal], index) => ({
        name: String(name),
        extra: 16,
        run: async (db: Parameters<typeof receiveTelemetry>[0]['db'], at: { scale: number }) => {
          scale = at.scale;
          const payload =
            body ??
            telemetryBatch(
              Array.from({ length: index === 4 ? 1 : 256 }, (_, i) =>
                telemetrySpan(i + 1, { trace: 20000 + index * 10 + scale }),
              ),
            );
          const response = await receiveTelemetry(
            { ...base.serverEnv, db, afterResponse: (work) => pending.push(work), wake: async () => {} },
            new Request(`https://s/v1/${signal}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
              body: typeof payload === 'string' ? payload : JSON.stringify(payload),
            }),
            NOW + (scale * 3 + (index >= 4 ? index - 3 : 0)) * 60000,
            'cost',
          );
          expect(response.status).toBe(index === 0 ? 400 : 200);
          while (pending.length) await pending.shift()!();
        },
      })),
      {
        name: 'repeated rejection in one minute',
        extra: 16,
        run: async (db, { store, scale }) => {
          const receipt = NOW + (scale * 3 + 3) * 60000;
          const reject = (target: typeof db, now: number) =>
            receiveTelemetry(
              { ...base.serverEnv, db: target },
              new Request('https://s/v1/traces', {
                method: 'POST',
                headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
                body: JSON.stringify(telemetryBatch([{ ...telemetrySpan(1), name: '' }])),
              }),
              now,
              'cost',
            );
          expect((await reject(store, receipt)).status).toBe(200);
          expect((await reject(db, receipt + 1)).status).toBe(200);
          expect((await telemetryKeys(store)).find((held) => held.id === 'http-0')?.last_used_at).toBe(receipt);
        },
      },
      {
        name: 'idle work flag',
        run: async (db, { store }) => {
          while ((await runTelemetryWork(store, NOW)).more) {}
          expect(await runTelemetryWork(db, NOW)).toEqual({ changed: 0, more: false });
        },
      },
    ],
  });
  base.sqlite.close();
  expectTwoScale(costs);
  for (const cost of costs.slice(0, 4)) expect(cost.writes.some(Boolean)).toBe(false);
}, 120000);
