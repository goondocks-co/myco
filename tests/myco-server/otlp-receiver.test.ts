import { describe, expect, it } from 'bun:test';
import { createServer } from '@myco-server-worker/pipeline.js';
import { reconcileTelemetry } from '@myco-server-worker/core/telemetry-matching.js';
import { invocationsForSession, invocationForTurn } from '@myco-server-worker/core/telemetry-invocations.js';
import { pruneTelemetry } from '@myco-server-worker/db/telemetry/retention.js';
import { TELEMETRY_BODY_BYTES, TELEMETRY_MATCH_WAIT_MS, TELEMETRY_RETENTION_MS, TELEMETRY_SPANS_PER_REQUEST, TELEMETRY_SPANS_PER_TRACE, TELEMETRY_TEXT_BYTES } from '@myco-server-worker/core/telemetry-policy.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { lineage_sessionLineage } from '@myco-server-worker/read/catalog/lineage.js';
import { seedCredential } from './helpers/d1.js';
import { sqliteEnv, envelope, noOutboundFetch, uuid } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie, seedMemberRoleAccount, MEMBER_SUB } from './helpers/owner.js';
import { telemetryAttribute, telemetryBatch, telemetryId, telemetrySpan, telemetryTrace } from './helpers/telemetry.js';

const NOW = 1_800_000_000_000;
async function fixture() {
  const e = sqliteEnv();
  Object.assign(e.env, OWNER_ENV);
  const env = e.serverEnv;
  let now = NOW;
  const server = createServer({ now: () => now, sourceOf: () => 'loopback', fetchImpl: noOutboundFetch });
  const owner = async (path: string, body?: unknown) => server.handleRequest(new Request(`https://s${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie: await ownerCookie(e.db, now), origin: 'https://s', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const issued = await owner('/api/telemetry/keys', { label: 'test sender' });
  expect(issued.status).toBe(201);
  const { key, id } = await issued.json() as { key: string; id: string };
  const send = (body: unknown, path = '/v1/traces', headers: Record<string, string> = {}) => server.handleRequest(new Request(`https://s${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  }), env);
  seedCredential(e.sqlite, { expiresAt: NOW + 10_000 });
  let event = 1;
  const start = async (sessionId: string, projectId = 'proj_1', payload: Record<string, unknown> = {}) => {
    const result = await ingestEvent(e.db, { projectId, machineId: 'machine_1', tokenId: 'mt_1', bodyBytes: 100, now }, envelope({
      eventId: uuid(event++), sessionId, kind: 'session.start', createdAt: now, payload: { agent: 'codex', startedAt: now, branch: 'feature', ...payload },
    }));
    expect(result.persisted).toBe(true);
  };
  return { e, env, server, owner, key, id, send, start, advance: (at: number) => { now = at; } };
}

describe('OpenTelemetry receiver', () => {
  it('issues a named hashed ingest-only key, shows it once, and meters successful connections', async () => {
    const f = await fixture();
    expect(JSON.stringify(f.e.sqlite.query('SELECT * FROM telemetry_keys').all())).not.toContain(f.key);
    const before = await (await f.owner('/api/telemetry/keys')).json();
    expect(JSON.stringify(before)).not.toContain(f.key);
    expect((await f.send(telemetryTrace('lead', 'worker'))).status).toBe(200);
    expect((await f.send({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] }, '/v1/logs')).status).toBe(200);
    expect((await f.send({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ gauge: { dataPoints: [{ asDouble: 0.5 }] } }] }] }] }, '/v1/metrics')).status).toBe(200);
    const listed = await (await f.owner('/api/telemetry/keys')).json() as { keys: Record<string, unknown>[] };
    expect(listed.keys).toEqual([expect.objectContaining({ label: 'test sender', lastUsedAt: NOW, accepted: 3, rejected: 0, logs: 1, metrics: 1 })]);
    const read = await f.server.handleRequest(new Request('https://s/api/projects', { headers: { authorization: `Bearer ${f.key}` } }), f.env);
    expect(read.status).toBe(401);
    seedMemberRoleAccount(f.e.sqlite);
    const member = await f.server.handleRequest(new Request('https://s/api/telemetry/keys', { headers: { cookie: await ownerCookie(f.e.db, NOW, MEMBER_SUB) } }), f.env);
    expect(member.status).toBe(403);
    f.e.sqlite.close();
  });

  it('answers malformed, unauthorized, oversized, rate-limited and partial requests as OTLP without redirects', async () => {
    const f = await fixture();
    expect((await f.send({}, '/v1/traces', { authorization: '' })).status).toBe(401);
    expect((await f.send('broken')).status).toBe(400);
    expect((await f.send({ resourceSpans: 1 })).status).toBe(400);
    expect((await f.send({ resourceLogs: [{ scopeLogs: [{ logRecords: [null] }] }] }, '/v1/logs')).status).toBe(400);
    expect((await f.send({}, '/v1/traces', { 'content-length': String(TELEMETRY_BODY_BYTES + 1) })).status).toBe(413);
    const oversized = telemetrySpan(2, { attributes: [telemetryAttribute('unknown.note', 'x'.repeat(TELEMETRY_TEXT_BYTES + 1))] });
    const partial = await f.send(telemetryBatch([telemetrySpan(1), oversized]));
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
    const excess = await f.send(telemetryBatch(Array.from({ length: TELEMETRY_SPANS_PER_REQUEST + 1 }, (_, index) => telemetrySpan(index + 10, { trace: index + 10 }))));
    expect(await excess.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
    for (let offset = 0; offset < TELEMETRY_SPANS_PER_TRACE; offset += TELEMETRY_SPANS_PER_REQUEST) {
      await f.send(telemetryBatch(Array.from({ length: TELEMETRY_SPANS_PER_REQUEST }, (_, index) => telemetrySpan(offset + index + 1, { trace: 10_000 }))));
    }
    expect(await (await f.send(telemetryBatch([telemetrySpan(TELEMETRY_SPANS_PER_TRACE + 1, { trace: 10_000 })]))).json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
    f.env.tokenLimit = { limit: async () => ({ success: false }) };
    const limited = await f.send({});
    expect([limited.status, limited.headers.get('retry-after'), limited.headers.get('location')]).toEqual([429, '60', null]);
    f.e.sqlite.close();
  });

  it('keeps compact immutable spans, derives cross-Project lineage and invocation windows, and removes a revoked key’s assertions', async () => {
    const f = await fixture();
    await f.start('lead'); await f.start('worker /β', 'proj_2');
    const body = telemetryTrace('lead', 'worker /β');
    body.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.attributes.push(telemetryAttribute('unknown.content', 'must be discarded'));
    expect(await (await f.send(body)).json()).toEqual({});
    expect(await (await f.send(body)).json()).toEqual({});
    expect(JSON.stringify(f.e.sqlite.query('SELECT * FROM telemetry_spans').all())).not.toContain('must be discarded');
    await reconcileTelemetry(f.e.db, NOW);
    const lineage = await lineage_sessionLineage(f.e.db, { projectId: 'proj_2' }, 'worker /β');
    expect(lineage?.edges).toContainEqual(expect.objectContaining({ parentId: 'lead', childId: 'worker /β', parentProjectId: 'proj_1', source: 'telemetry', serviceName: 'dispatch-service', inferred: false }));
    const facts = await invocationsForSession(f.e.db, 'proj_2', 'worker /β');
    expect(facts.rows).toEqual([expect.objectContaining({ agentName: 'worker', startAt: NOW, endAt: NOW + 1000, matchedBy: 'exact' })]);
    expect(invocationForTurn(facts.rows, { startAt: NOW - 500, endAt: NOW + 100 })).toEqual(facts.rows[0]!);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'worker /β')).rows).toEqual([]);
    expect(await (await f.owner(`/api/telemetry/keys/${f.id}/revoke`, {})).json()).toEqual({ revoked: true });
    expect((await f.send(body)).status).toBe(401);
    expect((await invocationsForSession(f.e.db, 'proj_2', 'worker /β')).rows).toEqual([]);
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_2' }, 'worker /β'))?.edges).toEqual([]);
    f.e.sqlite.close();
  });

  it('matches a session arriving after its span, but captured baggage outranks telemetry and retention expires spans', async () => {
    const f = await fixture();
    await f.start('lead');
    await f.send(telemetryTrace('lead', 'later'));
    await reconcileTelemetry(f.e.db, NOW);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'later')).rows).toEqual([]);
    await f.start('later', 'proj_1', { launchParentSessionId: 'captured-parent' });
    await reconcileTelemetry(f.e.db, NOW + 60_000);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'later')).rows).toHaveLength(1);
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'later'))?.edges).toEqual([{ parentId: 'captured-parent', childId: 'later', kind: 'launched', reason: null }]);
    await pruneTelemetry(f.e.db, NOW + TELEMETRY_RETENTION_MS + 1, 500);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'later')).rows).toEqual([]);
    f.e.sqlite.close();
  });

  it('infers only one repository/branch/time candidate and exact evidence replaces it', async () => {
    const f = await fixture();
    await f.start('lead'); await f.start('candidate');
    f.e.sqlite.query('INSERT INTO project_remotes(remote,project_id,first_seen_at) VALUES(?,?,?)').run('example.test/team/repo', 'proj_1', NOW);
    const inferred = (trace: number, branch = 'feature', agent = 'worker') => telemetryBatch([telemetrySpan(1, { trace, conversation: 'lead' }), telemetrySpan(3, { trace, parent: 1, agent, operation: 'invoke_agent', attributes: [
      telemetryAttribute('vcs.repository.url.full', 'https://example.test/team/repo.git'), telemetryAttribute('vcs.ref.head.name', branch),
    ] })]);
    await f.send(inferred(1)); await reconcileTelemetry(f.e.db, NOW);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'candidate')).rows).toEqual([expect.objectContaining({ matchedBy: 'inferred' })]);
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'candidate'))?.edges).toContainEqual(expect.objectContaining({ inferred: true }));
    await f.send(telemetryBatch([telemetrySpan(1, { trace: 2, conversation: 'lead' }), telemetrySpan(3, { trace: 2, parent: 1, conversation: 'candidate', operation: 'invoke_agent' })]));
    await reconcileTelemetry(f.e.db, NOW);
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'candidate'))?.edges).toContainEqual(expect.objectContaining({ inferred: false }));
    await f.start('other'); await f.send(inferred(3, 'feature', 'other-agent'));  await f.send(inferred(4, 'no-such-branch')); await reconcileTelemetry(f.e.db, NOW);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'other')).rows).toEqual([]);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'candidate')).rows.map(row => row.traceId)).toEqual([telemetryId(1, 32), telemetryId(2, 32)]);
    f.e.sqlite.close();
  });
  it('drops a named session that never arrives after the bounded match wait', async () => {
    const f = await fixture();
    await f.start('lead');
    await f.send(telemetryTrace('lead', 'never-arrives'));
    await reconcileTelemetry(f.e.db, NOW + TELEMETRY_MATCH_WAIT_MS + 1);
    expect(f.e.sqlite.query('SELECT conversation_id FROM telemetry_spans WHERE conversation_id=?').all('never-arrives')).toEqual([]);
    f.e.sqlite.close();
  });

  it('attaches later terminal sends to one established lead/agent/repository/ref link without a new start-time match', async () => {
    const f = await fixture();
    await f.start('lead'); await f.start('terminal-worker');
    f.e.sqlite.query('INSERT INTO project_remotes(remote,project_id,first_seen_at) VALUES(?,?,?)').run('example.test/team/terminal', 'proj_1', NOW);
    const delivery = (trace: number, at: number) => telemetryBatch([
      telemetrySpan(1, { trace, conversation: 'lead', at }),
      telemetrySpan(3, { trace, parent: 1, operation: 'invoke_agent', at, attributes: [telemetryAttribute('vcs.repository.url.full', 'https://example.test/team/terminal'), telemetryAttribute('vcs.ref.head.name', 'feature')] }),
    ]);
    await f.send(delivery(10, NOW)); await reconcileTelemetry(f.e.db, NOW);
    f.advance(NOW + 60_000);
    await f.send(delivery(11, NOW + 60_000)); await reconcileTelemetry(f.e.db, NOW + 60_000);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'terminal-worker')).rows.map(row => [row.traceId, row.startAt, row.matchedBy]))
      .toEqual([[telemetryId(10, 32), NOW, 'inferred'], [telemetryId(11, 32), NOW + 60_000, 'inferred']]);
    f.e.sqlite.close();
  });

});
