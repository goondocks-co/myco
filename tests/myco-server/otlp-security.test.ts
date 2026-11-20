import { publishFixture, uuid } from './helpers/fixtures.js';
import { expect, it } from 'bun:test';
import { telemetryFixture as fixture } from './helpers/telemetry-fixture.js';
import {
  telemetryAttribute,
  telemetryBatch,
  telemetrySpan,
  telemetryTrace,
  telemetryId,
} from './helpers/telemetry.js';
import {
  TELEMETRY_BODY_BYTES,
  TELEMETRY_REQUESTS_PER_KEY,
  TELEMETRY_KEY_LIMIT,
  TELEMETRY_SPAN_LIMIT,
  TELEMETRY_FUTURE_MS,
  TELEMETRY_MATCH_WAIT_MS,
} from '@myco-server-worker/core/telemetry-policy.js';
import { reconcileTelemetry } from '@myco-server-worker/core/telemetry-matching.js';
import { invocationsForSession } from '@myco-server-worker/core/telemetry-invocations.js';
import { lineage_sessionLineage } from '@myco-server-worker/read/catalog/lineage.js';
import { eachUnit } from './helpers/two-scale.js';
const NOW = 1_800_000_000_000;

it('bounds streaming bodies and coalesces new spans behind one deferred work wake', async () => {
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
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent > TELEMETRY_BODY_BYTES) {
        controller.close();
        return;
      }
      sent += chunk.length;
      controller.enqueue(chunk);
    },
  });
  expect(
    (
      await f.server.handleRequest(
        new Request('https://s/v1/traces', {
          method: 'POST',
          headers: { authorization: `Bearer ${f.key}`, 'content-type': 'application/json' },
          body,
        }),
        f.env,
      )
    ).status,
  ).toBe(413);
  expect(pending).toHaveLength(0);
  const good = telemetrySpan(1, { at: NOW + 120000 }),
    old = { ...telemetrySpan(2), startTimeUnixNano: 1_000_000, endTimeUnixNano: 2_000_000 };
  const future = telemetrySpan(3, { at: NOW + TELEMETRY_FUTURE_MS + 1 });
  expect(await (await f.send(telemetryBatch([good, old, future]))).json()).toMatchObject({
    partialSuccess: { rejectedSpans: '2' },
  });
  expect(
    ((await (await f.owner('/api/telemetry/keys')).json()) as { keys: Array<{ clockSkewMs: number }> })
      .keys[0]!.clockSkewMs,
  ).toBe(-121000);
  expect(pending).toHaveLength(1);
  expect(wakes).toBe(0);
  await pending.shift()!();
  expect(wakes).toBe(1);
  await f.send(telemetryBatch([good, telemetrySpan(4)]));
  expect(pending).toHaveLength(0);
  f.e.sqlite.close();
});

it('checks the smaller key bucket first and recomputes live-key quotas', async () => {
  const f = await fixture(),
    used = new Map<string, number>();
  let remaining = TELEMETRY_REQUESTS_PER_KEY + 1;
  f.env.tokenLimit = {
    limit: async ({ key }) => {
      const n = (used.get(key) ?? 0) + 1;
      used.set(key, n);
      return { success: n <= TELEMETRY_REQUESTS_PER_KEY };
    },
  };
  f.env.sourceLimit = {
    limit: async ({ key }) => ({ success: key !== 'telemetry:deployment' || remaining-- > 0 }),
  };
  for (let i = 0; i < TELEMETRY_REQUESTS_PER_KEY; i++)
    expect((await f.send({}, '/v1/logs')).status).toBe(200);
  expect((await f.send({}, '/v1/logs')).status).toBe(429);
  expect(
    ((await (await f.owner('/api/telemetry/keys')).json()) as { keys: Array<{ spanQuota: number }> }).keys[0]!
      .spanQuota,
  ).toBe(TELEMETRY_SPAN_LIMIT);
  const other = (await (await f.owner('/api/telemetry/keys', { label: 'Other sender' })).json()) as {
    key: string;
    id: string;
  };
  expect((await f.send({}, '/v1/logs', { authorization: `Bearer ${other.key}` })).status).toBe(200);
  f.env.sourceLimit = { limit: async () => ({ success: true }) };
  f.env.tokenLimit = { limit: async () => ({ success: true }) };
  const quota = Math.floor(TELEMETRY_SPAN_LIMIT / TELEMETRY_KEY_LIMIT);
  await eachUnit(
    f.e.db,
    0,
    quota + 1,
    `INSERT INTO telemetry_spans(key_id,trace_id,span_id,name,kind,start_ns,end_ns,start_ms,end_ms,attributes,status,received_at)
 SELECT ?3,printf('%032x',i/512+9000),printf('%016x',i+1),'fixture',1,'0','0',0,0,'{}',0,?4 FROM n`,
    f.id,
    NOW,
  );
  for (let i = 2; i < TELEMETRY_KEY_LIMIT; i++)
    expect((await f.owner('/api/telemetry/keys', { label: `Sender ${i}` })).status).toBe(201);
  expect((await f.owner('/api/telemetry/keys', { label: 'One too many' })).status).toBe(409);
  const list = (await (await f.owner('/api/telemetry/keys')).json()) as {
    keys: Array<{
      id: string;
      usedSpans: number;
      spanQuota: number;
      dailySpans: number;
      quotaReached: boolean;
    }>;
  };
  expect(list.keys.find((row) => row.id === f.id)).toMatchObject({
    usedSpans: quota + 1,
    spanQuota: quota,
    dailySpans: Math.floor(quota / 30),
    quotaReached: true,
  });
  expect(await (await f.send(telemetryBatch([telemetrySpan(1, { trace: 99999 })]))).json()).toMatchObject({
    partialSuccess: { errorMessage: expect.stringContaining('key span quota') },
  });
  expect(
    await (
      await f.send(telemetryBatch([telemetrySpan(1, { trace: 99999 })]), '/v1/traces', {
        authorization: `Bearer ${other.key}`,
      })
    ).json(),
  ).toEqual({});
  await f.owner(`/api/telemetry/keys/${other.id}/revoke`, {});
  expect(await (await f.send(telemetryBatch([telemetrySpan(1, { trace: 99999 })]))).json()).toEqual({});
  f.e.sqlite.close();
});

it('keeps parent ids independent by key, accepts long leads and restores the other report on revocation', async () => {
  const f = await fixture();
  await f.start('lead');
  await f.start('decoy', 'proj_2');
  await f.start('worker');
  await f.capture('worker', 'prompt', { promptId: uuid(125), text: 'A relayed instruction', origin: 'user' });
  await publishFixture(f.e, NOW);
  const other = (await (await f.owner('/api/telemetry/keys', { label: 'Other sender' })).json()) as {
    key: string;
    id: string;
  };
  const child = telemetrySpan(3, { parent: 1, conversation: 'worker', operation: 'invoke_agent' });
  await f.send(telemetryBatch([child]));
  await f.send(telemetryBatch([telemetrySpan(1, { conversation: 'decoy' })]), '/v1/traces', {
    authorization: `Bearer ${other.key}`,
  });
  await reconcileTelemetry(f.e.db, NOW);
  expect(
    (await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker', { all: true }))?.edges,
  ).toEqual([]);
  const long = {
    ...telemetrySpan(1, { conversation: 'lead', at: NOW - 2 * 60 * 60 * 1000 }),
    endTimeUnixNano: String(BigInt(NOW + 1000) * 1000000n),
  };
  expect(await (await f.send(telemetryBatch([long]))).json()).toEqual({});
  await reconcileTelemetry(f.e.db, NOW);
  expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker'))?.edges).toContainEqual(
    expect.objectContaining({ parentId: 'lead', keyLabel: 'test sender' }),
  );
  expect(
    await (
      await f.send(telemetryBatch([child]), '/v1/traces', { authorization: `Bearer ${other.key}` })
    ).json(),
  ).toEqual({});
  await reconcileTelemetry(f.e.db, NOW);
  const lineage = await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker', { all: true });
  expect(lineage?.edges).toEqual([]);
  expect(lineage?.reports?.map((row) => row.keyLabel).sort()).toEqual(['Other sender', 'test sender']);
  f.advance(NOW + TELEMETRY_MATCH_WAIT_MS + 10_000);
  await f.owner(`/api/telemetry/keys/${other.id}/revoke`, {});
  expect((await invocationsForSession(f.e.db, 'proj_1', 'worker')).rows).toHaveLength(1);
  expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker'))?.edges).toContainEqual(
    expect.objectContaining({ parentId: 'lead', keyLabel: 'test sender' }),
  );
  await f.send(
    telemetryBatch([
      telemetrySpan(1, { trace: 2, conversation: 'decoy', at: NOW + TELEMETRY_MATCH_WAIT_MS + 10_000 }),
      telemetrySpan(3, {
        trace: 2,
        parent: 1,
        conversation: 'worker',
        operation: 'invoke_agent',
        at: NOW + TELEMETRY_MATCH_WAIT_MS + 10_000,
      }),
    ]),
  );
  await reconcileTelemetry(f.e.db, NOW + TELEMETRY_MATCH_WAIT_MS + 10_000);
  const latest = await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'worker', { all: true });
  expect(latest?.reports).toBeUndefined();
  expect(latest?.edges).toContainEqual(
    expect.objectContaining({ parentId: 'decoy', keyLabel: 'test sender' }),
  );

  f.e.sqlite.close();
});
