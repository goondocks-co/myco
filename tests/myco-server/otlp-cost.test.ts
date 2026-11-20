import { expect, it } from 'bun:test';
import { TELEMETRY_SPAN_LIMIT } from '@myco-server-worker/core/telemetry-policy.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { parseTraces } from '@myco-server-worker/core/otlp.js';
import { storeTelemetrySpans } from '@myco-server-worker/db/telemetry/ingest.js';
import { insertTelemetryKey } from '@myco-server-worker/db/telemetry/keys.js';
import { reconcileTelemetry } from '@myco-server-worker/core/telemetry-matching.js';
import { lineage_sessionLineage } from '@myco-server-worker/read/catalog/lineage.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';
import { telemetryBatch, telemetrySpan, telemetryTrace } from './helpers/telemetry.js';

const NOW = 1_800_000_000_000;
it('OTLP ingest and lineage cost stay bounded as unrelated Deployment history grows', async () => {
  const costs = await d1TwoScale({
    sizes: [20, 2_000],
    setup: async db => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_otel','Telemetry',1)").run();
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES('proj_otel','lead','machine','credential',?1,?1),('proj_otel','worker','machine','credential',?1,?1)`).bind(NOW).run();
      await insertTelemetryKey(db, { id: 'test-key', hash: 'test-hash', label: 'cost sender', actor: 'member', now: NOW });
      await storeTelemetrySpans(db, { key: 'test-key', spans: parseTraces(telemetryTrace('lead', 'worker')).spans, now: NOW });
      await reconcileTelemetry(db, NOW);
    },
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT 'proj_otel','other-'||i,'machine','credential',?3,?3 FROM n`, NOW);
      for (let offset = from; offset < to; offset += 200) {
        const spans = Array.from({ length: Math.min(200, to - offset) }, (_, index) => telemetrySpan(index + 1, { trace: offset + index + 100, conversation: `other-${offset + index}`, operation: 'invoke_agent' }));
        await storeTelemetrySpans(db, { key: 'test-key', spans: parseTraces(telemetryBatch(spans)).spans, now: NOW });
        await db.prepare(`INSERT INTO telemetry_resolutions(trace_id,span_id,key_id,project_id,session_id,matched_by,invocation)
          SELECT s.trace_id,s.span_id,s.key_id,'proj_otel',s.conversation_id,'exact',1 FROM json_each(?1) j CROSS JOIN telemetry_spans s
          ON s.trace_id=json_extract(j.value,'$.traceId') AND s.span_id=json_extract(j.value,'$.spanId')`).bind(JSON.stringify(spans)).run();
      }
    },
    cases: [
      { name: 'ingest one new span', run: async (db, { scale }) => {
        expect(await storeTelemetrySpans(db, { key: 'test-key', spans: parseTraces(telemetryBatch([telemetrySpan(1, { trace: 100_000 + scale })])).spans, now: NOW })).toBeGreaterThan(0);
      } },
      { name: 'read the recorded lineage', run: async db => {
        expect((await lineage_sessionLineage(db, { projectId: 'proj_otel' }, 'worker'))?.edges).toContainEqual(expect.objectContaining({ parentId: 'lead', childId: 'worker', source: 'telemetry' }));
      } },
    ],
  });
  expectTwoScale(costs);
}, 120_000);

it('a full Deployment refuses a new span and still acknowledges an immutable retry', async () => {
  const e = sqliteEnv();
  try {
    await insertTelemetryKey(e.db, { id: 'capacity-key', hash: 'capacity-hash', label: 'capacity sender', actor: 'member', now: NOW });
    await eachUnit(e.db, 0, TELEMETRY_SPAN_LIMIT, `INSERT INTO telemetry_spans(trace_id,span_id,key_id,name,kind,start_ns,end_ns,start_ms,end_ms,attributes,status,received_at)
      SELECT printf('%032x',i+1),printf('%016x',i+1),'capacity-key','fixture',1,'0','0',0,0,'{}',0,?3 FROM n`, NOW);
    expect(await storeTelemetrySpans(e.db, { key: 'capacity-key', spans: parseTraces(telemetryBatch([telemetrySpan(1, { trace: 1_000_000 })])).spans, now: NOW })).toBe(0);
    expect(await storeTelemetrySpans(e.db, { key: 'capacity-key', spans: parseTraces(telemetryBatch([telemetrySpan(1)])).spans, now: NOW })).toBe(1);
  } finally { e.sqlite.close(); }
}, 60_000);
