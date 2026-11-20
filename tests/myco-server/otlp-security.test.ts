import { expect, it } from 'bun:test';
import { telemetryFixture as fixture } from './helpers/telemetry-fixture.js';
import { telemetryAttribute, telemetryBatch, telemetrySpan, telemetryTrace, telemetryId } from './helpers/telemetry.js';
import {
  TELEMETRY_BODY_BYTES,
  TELEMETRY_REQUESTS_PER_KEY,
  TELEMETRY_SPANS_PER_KEY,
  TELEMETRY_SPANS_PER_TRACE,
  TELEMETRY_MAX_SPAN_MS,
  TELEMETRY_MATCH_WAIT_MS,
} from '@myco-server-worker/core/telemetry-policy.js';
import { reconcileTelemetry } from '@myco-server-worker/core/telemetry-matching.js';
import { invocationsForSession, invocationForTurn } from '@myco-server-worker/core/telemetry-invocations.js';
import { lineage_sessionLineage } from '@myco-server-worker/read/catalog/lineage.js';
import { cleanRevokedTelemetry, revokedTelemetryDue } from '@myco-server-worker/db/telemetry/revocation.js';
import { eachUnit } from './helpers/two-scale.js';
const NOW = 1_800_000_000_000;

it('bounds a streaming body and defers waking until a newly retained span', async () => {
  const f = await fixture(),
    pending: Array<() => Promise<void>> = [];
  let wakes = 0;
  f.env.afterResponse = (work) => pending.push(work);
  f.env.wake = async () => {
    wakes++;
  };
  expect((await f.send({}, '/v1/traces', { 'content-type': 'text/plain' })).status).toBe(400);
  expect((await f.send('{')).status).toBe(400);
  await f.send({});
  await f.send({}, '/v1/logs');
  await f.send({}, '/v1/metrics');
  const chunk = new TextEncoder().encode(' '.repeat(8192));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > TELEMETRY_BODY_BYTES) {
        controller.close();
        return;
      }
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
  const oversized = await f.server.handleRequest(
    new Request('https://s/v1/traces', {
      method: 'POST',
      headers: { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' },
      body: stream,
    }),
    f.env,
  );
  expect(oversized.status).toBe(413);
  expect(pending).toHaveLength(0);
  const good = { ...telemetrySpan(1), startTimeUnixNano: 1_000_000, endTimeUnixNano: 2_000_000 };
  const long = {
    ...telemetrySpan(2),
    endTimeUnixNano: String((BigInt(NOW) + BigInt(TELEMETRY_MAX_SPAN_MS + 1)) * 1000000n),
  };
  expect(await (await f.send(telemetryBatch([good, long]))).json()).toMatchObject({
    partialSuccess: { rejectedSpans: '1' },
  });
  expect(pending).toHaveLength(1);
  expect(wakes).toBe(0);
  await pending.shift()!();
  expect(wakes).toBe(1);
  expect(f.e.sqlite.query('SELECT start_ns FROM telemetry_spans').get()).toEqual({ start_ns: '1000000' });
  await f.send(telemetryBatch([good]));
  expect(pending).toHaveLength(0);
  f.e.sqlite.close();
});

it('isolates key rate, span quota and trace quota from another key', async () => {
  const f = await fixture();
  let remaining = TELEMETRY_REQUESTS_PER_KEY + 1;
  f.env.tokenLimit = {
    limit: async () => {
      return { success: remaining-- > 0 };
    },
  };
  for (let i = 0; i < TELEMETRY_REQUESTS_PER_KEY; i++) expect((await f.send({}, '/v1/logs')).status).toBe(200);
  expect((await f.send({}, '/v1/logs')).status).toBe(429);
  const other = (await (await f.owner('/api/telemetry/keys', { label: 'Other sender' })).json()) as { key: string };
  expect((await f.send({}, '/v1/logs', { authorization: `Bearer ${other.key}` })).status).toBe(200);
  f.advance(NOW + 60_000);
  f.env.tokenLimit = { limit: async () => ({ success: true }) };
  await eachUnit(
    f.e.db,
    0,
    TELEMETRY_SPANS_PER_KEY,
    `INSERT INTO telemetry_spans(trace_id,span_id,key_id,name,kind,start_ns,end_ns,start_ms,end_ms,attributes,status,received_at)
 SELECT CASE WHEN i<?4 THEN printf('%032x',9000) ELSE printf('%032x',i+10000) END,printf('%016x',i+1),?3,'fixture',1,'0','0',0,0,'{}',0,?5 FROM n`,
    f.id,
    TELEMETRY_SPANS_PER_TRACE,
    NOW,
  );
  const denied = (await (await f.send(telemetryBatch([telemetrySpan(1, { trace: 99999 })]))).json()) as {
    partialSuccess: { errorMessage: string };
  };
  expect(denied.partialSuccess.errorMessage).toContain('key span quota');
  expect(
    await (
      await f.send(telemetryBatch([telemetrySpan(10000, { trace: 9000 })]), '/v1/traces', {
        authorization: `Bearer ${other.key}`,
      })
    ).json(),
  ).toEqual({});
  expect(await (await f.send(telemetryBatch([telemetrySpan(1, { trace: 9000 })]))).json()).toEqual({});
  const list = (await (await f.owner('/api/telemetry/keys')).json()) as {
    keys: Array<{ id: string; usedSpans: number; spanQuota: number; quotaReached: boolean }>;
  };
  expect(list.keys.find((row) => row.id === f.id)).toMatchObject({
    usedSpans: TELEMETRY_SPANS_PER_KEY,
    spanQuota: TELEMETRY_SPANS_PER_KEY,
    quotaReached: true,
  });
  f.e.sqlite.close();
});

it('lists disagreeing exact parents with administrator key labels and attributes no invocation', async () => {
  const f = await fixture();
  await f.start('lead');
  await f.start('decoy', 'proj_2');
  await f.start('worker');
  const actual = telemetryTrace('lead', 'worker');
  for (const span of actual.resourceSpans[0]!.scopeSpans[0]!.spans) span.traceId = telemetryId(10, 32);
  await f.send(actual);
  const other = (await (await f.owner('/api/telemetry/keys', { label: 'Other sender' })).json()) as { key: string };
  await f.send(telemetryTrace('decoy', 'worker'), '/v1/traces', { authorization: `Bearer ${other.key}` });
  await reconcileTelemetry(f.e.db, NOW);
  const lineage = await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker', { all: true });
  expect(lineage?.edges).toEqual([]);
  expect(lineage?.reports?.map((row) => row.keyLabel).sort()).toEqual(['Other sender', 'test sender']);
  const facts = await invocationsForSession(f.e.db, 'proj_1', 'worker');
  expect(facts.rows.map((row) => row.keyLabel).sort()).toEqual(['Other sender', 'test sender']);
  expect(invocationForTurn(facts.rows, { startAt: NOW, endAt: NOW + 1000 })).toBeNull();
  const hidden = await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker');
  expect(JSON.stringify(hidden)).not.toContain('decoy');
  expect(JSON.stringify(hidden)).not.toContain('proj_2');
  f.e.sqlite.close();
});

it('invalidates stored-link and ancestor dependencies immediately after revocation beyond the wait', async () => {
  const f = await fixture();
  await f.start('lead');
  await f.start('worker');
  f.e.sqlite
    .query('INSERT INTO project_remotes(remote,project_id,first_seen_at) VALUES(?,?,?)')
    .run('example.test/team/revocation', 'proj_1', NOW);
  const delivery = (trace: number, at: number) =>
    telemetryBatch([
      telemetrySpan(1, { trace, conversation: 'lead', at }),
      telemetrySpan(3, {
        trace,
        parent: 1,
        agent: 'worker',
        operation: 'invoke_agent',
        at,
        attributes: [
          telemetryAttribute('vcs.repository.url.full', 'https://example.test/team/revocation'),
          telemetryAttribute('vcs.ref.head.name', 'feature'),
        ],
      }),
    ]);
  await f.send(delivery(10, NOW));
  await reconcileTelemetry(f.e.db, NOW);
  f.advance(NOW + 3000);
  await f.start('other');
  const other = (await (await f.owner('/api/telemetry/keys', { label: 'Dependent sender' })).json()) as { key: string };
  await f.send(delivery(11, NOW + 1500), '/v1/traces', { authorization: `Bearer ${other.key}` });
  await reconcileTelemetry(f.e.db, NOW + 3000);
  expect((await invocationsForSession(f.e.db, 'proj_1', 'worker')).rows).toHaveLength(2);
  await f.send(telemetryBatch([telemetrySpan(2, { trace: 12, parent: 1 })]));
  await f.send(
    telemetryBatch([
      telemetrySpan(1, { trace: 12, conversation: 'lead' }),
      telemetrySpan(3, { trace: 12, parent: 2, conversation: 'worker', operation: 'invoke_agent' }),
    ]),
    '/v1/traces',
    { authorization: `Bearer ${other.key}` },
  );
  await reconcileTelemetry(f.e.db, NOW + 3000);
  f.advance(NOW + TELEMETRY_MATCH_WAIT_MS + 10_000);
  await f.owner(`/api/telemetry/keys/${f.id}/revoke`, {});
  expect((await invocationsForSession(f.e.db, 'proj_1', 'worker')).rows).toEqual([]);
  while (await revokedTelemetryDue(f.e.db)) await cleanRevokedTelemetry(f.e.db);
  await reconcileTelemetry(f.e.db, NOW + TELEMETRY_MATCH_WAIT_MS + 10_000);
  expect((await invocationsForSession(f.e.db, 'proj_1', 'worker')).rows.map((row) => row.traceId)).toEqual([
    telemetryId(12, 32),
  ]);
  expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker'))?.edges).toEqual([]);
  f.e.sqlite.close();
});
