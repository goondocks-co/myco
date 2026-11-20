import { schemaSqlite } from './helpers/schema-template.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { seedCredential, sqliteD1 } from './helpers/d1.js';
import { LAST_TELEMETRY } from '@myco-server-worker/db/schema-vNEXT-telemetry.js';
import { TELEMETRY_EXACT_STEPS } from '@myco-server-worker/db/schema-steps-telemetry-exact.js';
import { recordProjectRemote } from '@myco-server-worker/core/remotes.js';
import { telemetryFixture as fixture } from './helpers/telemetry-fixture.js';
import { describe, expect, it } from 'bun:test';
import { runTelemetryWork } from '@myco-server-worker/core/telemetry-work.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { reconcileTelemetry } from '@myco-server-worker/core/telemetry-matching.js';
import { invocationsForSession } from '@myco-server-worker/core/telemetry-invocations.js';
import { pruneTelemetry } from '@myco-server-worker/db/telemetry/retention.js';
import {
  TELEMETRY_BODY_BYTES,
  TELEMETRY_INVOCATIONS_PER_PAGE,
  TELEMETRY_MATCH_WAIT_MS,
  TELEMETRY_RETENTION_MS,
  TELEMETRY_SPANS_PER_REQUEST,
  TELEMETRY_SPANS_PER_TRACE,
  TELEMETRY_TEXT_BYTES,
} from '@myco-server-worker/core/telemetry-policy.js';
import { lineage_sessionLineage } from '@myco-server-worker/read/catalog/lineage.js';
import { uuid, publishFixture } from './helpers/fixtures.js';
import { ownerCookie, seedMemberRoleAccount, MEMBER_SUB } from './helpers/owner.js';
import {
  telemetryAttribute,
  telemetryBatch,
  telemetryId,
  telemetrySpan,
  telemetryTrace,
} from './helpers/telemetry.js';

const NOW = 1_800_000_000_000;

describe('OpenTelemetry receiver', () => {
  it('issues a named hashed ingest-only key, shows it once, and meters successful connections', async () => {
    const f = await fixture();
    expect(JSON.stringify(f.e.sqlite.query('SELECT * FROM telemetry_keys').all())).not.toContain(f.key);
    const before = await (await f.owner('/api/telemetry/keys')).json();
    expect(JSON.stringify(before)).not.toContain(f.key);
    expect((await f.send(telemetryTrace('lead', 'worker'))).status).toBe(200);
    expect((await f.send({ resourceLogs: [{ scopeLogs: [{ logRecords: [{}] }] }] }, '/v1/logs')).status).toBe(
      200,
    );
    expect(
      (
        await f.send(
          {
            resourceMetrics: [
              { scopeMetrics: [{ metrics: [{ gauge: { dataPoints: [{ asDouble: 0.5 }] } }] }] },
            ],
          },
          '/v1/metrics',
        )
      ).status,
    ).toBe(200);
    const listed = (await (await f.owner('/api/telemetry/keys')).json()) as {
      keys: Record<string, unknown>[];
    };
    expect(listed.keys).toEqual([
      expect.objectContaining({
        label: 'test sender',
        lastUsedAt: NOW,
        accepted: 3,
        rejected: 0,
        logs: 0,
        metrics: 0,
      }),
    ]);
    const read = await f.server.handleRequest(
      new Request('https://s/api/projects', { headers: { authorization: `Bearer ${f.key}` } }),
      f.env,
    );
    expect(read.status).toBe(401);
    seedMemberRoleAccount(f.e.sqlite);
    const member = await f.server.handleRequest(
      new Request('https://s/api/telemetry/keys', {
        headers: { cookie: await ownerCookie(f.e.db, NOW, MEMBER_SUB) },
      }),
      f.env,
    );
    expect(member.status).toBe(403);
    f.e.sqlite.close();
  });

  it('answers malformed, unauthorized, oversized, rate-limited and partial requests as OTLP without redirects', async () => {
    const f = await fixture();
    expect((await f.send({}, '/v1/traces', { authorization: '' })).status).toBe(401);
    expect((await f.send('broken')).status).toBe(400);
    expect((await f.send({ resourceSpans: 1 })).status).toBe(400);
    expect(
      (await f.send({ resourceLogs: [{ scopeLogs: [{ logRecords: [null] }] }] }, '/v1/logs')).status,
    ).toBe(400);
    expect(
      (await f.send({}, '/v1/traces', { 'content-length': String(TELEMETRY_BODY_BYTES + 1) })).status,
    ).toBe(413);
    const oversized = telemetrySpan(2, {
      attributes: [telemetryAttribute('unknown.note', 'x'.repeat(TELEMETRY_TEXT_BYTES + 1))],
    });
    const partial = await f.send(telemetryBatch([telemetrySpan(1), oversized]));
    expect(partial.status).toBe(200);
    expect(await partial.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
    const excess = await f.send(
      telemetryBatch(
        Array.from({ length: TELEMETRY_SPANS_PER_REQUEST + 1 }, (_, index) =>
          telemetrySpan(index + 10, { trace: index + 10 }),
        ),
      ),
    );
    expect(await excess.json()).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
    for (let offset = 0; offset < TELEMETRY_SPANS_PER_TRACE; offset += TELEMETRY_SPANS_PER_REQUEST) {
      await f.send(
        telemetryBatch(
          Array.from({ length: TELEMETRY_SPANS_PER_REQUEST }, (_, index) =>
            telemetrySpan(offset + index + 1, { trace: 10_000 }),
          ),
        ),
      );
    }
    expect(
      await (
        await f.send(telemetryBatch([telemetrySpan(TELEMETRY_SPANS_PER_TRACE + 1, { trace: 10_000 })]))
      ).json(),
    ).toMatchObject({ partialSuccess: { rejectedSpans: '1' } });
    f.env.tokenLimit = { limit: async () => ({ success: false }) };
    const limited = await f.send({});
    expect([limited.status, limited.headers.get('retry-after'), limited.headers.get('location')]).toEqual([
      429,
      '60',
      null,
    ]);
    f.e.sqlite.close();
  });

  it('keeps compact immutable spans, derives cross-Project lineage and invocation windows, and removes a revoked key’s assertions', async () => {
    const f = await fixture();
    await f.start('lead');
    await f.start('worker /β', 'proj_2');
    await f.capture(
      'worker /β',
      'prompt',
      { promptId: uuid(123), text: 'A worker turn', origin: 'user' },
      'proj_2',
    );
    await publishFixture(f.e, NOW);
    const body = telemetryTrace('lead', 'worker /β');
    body.resourceSpans[0]!.scopeSpans[0]!.spans[2]!.attributes.push(
      telemetryAttribute('unknown.content', 'must be discarded'),
    );
    expect(await (await f.send(body)).json()).toEqual({});
    expect(await (await f.send(body)).json()).toEqual({});
    expect(JSON.stringify(f.e.sqlite.query('SELECT * FROM telemetry_spans').all())).not.toContain(
      'must be discarded',
    );
    await reconcileTelemetry(f.e.db, NOW);
    const lineage = await lineage_sessionLineage(f.e.db, { projectId: 'proj_2' }, 'worker /β', { all: true });
    expect(lineage?.edges).toContainEqual(
      expect.objectContaining({
        parentId: 'lead',
        childId: 'worker /β',
        parentProjectId: 'proj_1',
        source: 'telemetry',
        serviceName: 'dispatch-service',
      }),
    );
    const hidden = await lineage_sessionLineage(f.e.db, { projectId: 'proj_2' }, 'worker /β');
    expect(JSON.stringify(hidden)).not.toContain('lead');
    expect(hidden?.nodes.find((node) => !node.captured)?.label).toBeNull();
    const facts = await invocationsForSession(f.e.db, 'proj_2', 'worker /β');
    expect(facts.rows).toEqual([
      expect.objectContaining({ agentName: 'worker', startAt: NOW, endAt: NOW + 1000, matchedBy: 'exact' }),
    ]);
    const path = '/api/projects/proj_2/sessions/worker%20%2F%CE%B2/invocations';
    expect(await (await f.owner(path)).json()).toEqual(facts);
    expect((await f.owner(`${path}?cursor=invalid`)).status).toBe(400);
    expect((await f.owner('/api/projects/proj_1/sessions/worker%20%2F%CE%B2/invocations')).status).toBe(404);
    expect(
      (
        await f.server.handleRequest(
          new Request(`https://s${path}`, { headers: { authorization: `Bearer ${f.key}` } }),
          f.env,
        )
      ).status,
    ).toBe(401);

    expect((await invocationsForSession(f.e.db, 'proj_1', 'worker /β')).rows).toEqual([]);
    expect(await (await f.owner(`/api/telemetry/keys/${f.id}/revoke`, {})).json()).toEqual({ revoked: true });
    expect((await f.send(body)).status).toBe(401);
    expect((await invocationsForSession(f.e.db, 'proj_2', 'worker /β')).rows).toEqual([]);
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_2' }, 'worker /β'))?.edges).toEqual([]);
    f.e.sqlite.close();
  });

  it('pages every stored invocation once through the Project-scoped session read', async () => {
    const f = await fixture();
    await f.start('worker');
    f.advance(NOW + 199_500);
    await f.capture('worker', 'prompt', { promptId: uuid(124), text: 'A later turn', origin: 'user' });
    await publishFixture(f.e, NOW + 199_500);
    const spans = Array.from({ length: TELEMETRY_INVOCATIONS_PER_PAGE + 1 }, (_, index) =>
      telemetrySpan(index + 1, { conversation: 'worker', operation: 'invoke_agent', at: NOW + index * 1000 }),
    );
    expect(await (await f.send(telemetryBatch(spans))).json()).toEqual({});
    await reconcileTelemetry(f.e.db, NOW);
    const path = '/api/projects/proj_1/sessions/worker/invocations';
    const first = (await (await f.owner(path)).json()) as { rows: { spanId: string }[]; nextCursor: string };
    const last = (await (await f.owner(`${path}?cursor=${encodeURIComponent(first.nextCursor)}`)).json()) as {
      rows: { spanId: string }[];
      nextCursor: null;
    };
    expect([...first.rows, ...last.rows].map((row) => row.spanId)).toEqual(spans.map((span) => span.spanId));
    expect(last.nextCursor).toBeNull();
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
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'later'))?.edges).toEqual([
      { parentId: 'captured-parent', childId: 'later', kind: 'launched', reason: null },
    ]);
    await pruneTelemetry(f.e.db, NOW + TELEMETRY_RETENTION_MS + 1, 500);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'later')).rows).toEqual([]);
    f.e.sqlite.close();
  });

  it('never resolves an unnamed invocation to a nearby session on its repository and ref', async () => {
    const f = await fixture();
    await f.start('lead');
    await recordProjectRemote(f.e.db, 'proj_1', 'example.test/team/repo', NOW);
    await f.send(telemetryBatch([
      telemetrySpan(1, { conversation: 'lead' }),
      telemetrySpan(3, { parent: 1, operation: 'invoke_agent', attributes: [
        telemetryAttribute('vcs.repository.url.full', 'https://example.test/team/repo'),
        telemetryAttribute('vcs.ref.head.name', 'feature'),
      ] }),
    ]));
    await reconcileTelemetry(f.e.db, NOW);
    f.advance(NOW + 1_000);
    await f.capture('nearby', 'session.start', { agent: 'codex', startedAt: NOW + 1_000, branch: 'feature' });
    const promptId = uuid(220);
    await f.capture('nearby', 'prompt', { promptId, text: 'A person starts a session', origin: 'user' });
    await publishFixture(f.e, NOW + 1_000);
    await reconcileTelemetry(f.e.db, NOW + 1_000);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'nearby')).rows).toEqual([]);
    const base = '/api/projects/proj_1/sessions/nearby';
    const family = await (await f.owner(base + '/lineage')).json() as { edges: unknown[] };
    const session = await (await f.owner(base)).json() as { personTurns: number };
    const turns = await (await f.owner(base + '/turns')).json() as { rows: { origin: string }[] };
    const detail = await (await f.owner(base + '/turns/' + promptId)).json() as { prompt: { origin: string } };
    expect(family.edges).toEqual([]);
    expect(session.personTurns).toBe(1);
    expect(turns.rows).toMatchObject([{ origin: 'user' }]);
    expect(detail.prompt.origin).toBe('user');
    f.e.sqlite.close();
  });
  it('upgrades stored inferred facts away while retaining exact reports', async () => {
    const sqlite = schemaSqlite({ through: LAST_TELEMETRY });
    seedCredential(sqlite, { id: 'mt_upgrade_owner', expiresAt: NOW + TELEMETRY_RETENTION_MS });
    sqlite.query("UPDATE members SET github_id=? WHERE id=?").run('583231', 'mem_machine_1');
    sqlite.query("INSERT INTO projects(project_id,name,created_at) VALUES(?,?,?)").run('proj_1', 'Upgrade', NOW);
    const f = await fixture(sqlite);
    await f.start('lead');
    await f.start('exact-child');
    await f.start('inferred-child');
    await f.send(telemetryBatch([
      telemetrySpan(1, { conversation: 'lead' }),
      telemetrySpan(3, { parent: 1, conversation: 'exact-child', operation: 'invoke_agent' }),
      telemetrySpan(4, { parent: 1, conversation: 'inferred-child', operation: 'invoke_agent' }),
      telemetrySpan(5, { parent: 1, conversation: 'later', operation: 'invoke_agent' }),
    ]));
    await reconcileTelemetry(f.e.db, NOW);
    f.e.sqlite.query("UPDATE telemetry_resolutions SET matched_by='inferred' WHERE session_id=?").run('inferred-child');
    await f.start('later');
    const retained = () => [f.e.sqlite.query("SELECT * FROM telemetry_resolutions WHERE matched_by='exact' ORDER BY span_id").all(),
      f.e.sqlite.query("SELECT * FROM telemetry_lineage_reports WHERE matched_by='exact' ORDER BY session_id").all(),
      f.e.sqlite.query("SELECT * FROM telemetry_session_changes WHERE scope='session' ORDER BY session_id").all()];
    const exact = retained();
    expect(exact.every(rows => rows.length > 0)).toBe(true);
    f.e.sqlite.query("INSERT INTO telemetry_session_changes(project_id,session_id,scope,revision) VALUES(?,'','project',1)").run('proj_1');
    await applySchemaSteps(sqliteD1(f.e.sqlite), TELEMETRY_EXACT_STEPS);
    expect(retained()).toEqual(exact);
    const projectChanges = f.e.sqlite.query("SELECT * FROM telemetry_session_changes WHERE scope='project'").all();
    expect(projectChanges).toEqual([]);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'exact-child')).rows).toMatchObject([{ matchedBy: 'exact' }]);
    expect((await invocationsForSession(f.e.db, 'proj_1', 'inferred-child')).rows).toEqual([]);
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'inferred-child'))?.edges).toEqual([]);
    expect((await lineage_sessionLineage(f.e.db, { projectId: 'proj_1' }, 'exact-child'))?.edges).toContainEqual(expect.objectContaining({ parentId: 'lead' }));
    f.e.sqlite.close();
  });

  it('drops a named session that never arrives after the bounded match wait', async () => {
    const f = await fixture();
    await f.start('lead');
    await f.send(telemetryTrace('lead', 'never-arrives'));
    await reconcileTelemetry(f.e.db, NOW + TELEMETRY_MATCH_WAIT_MS + 1);
    expect(
      f.e.sqlite
        .query('SELECT conversation_id FROM telemetry_spans WHERE conversation_id=?')
        .all('never-arrives'),
    ).toEqual([]);
    f.e.sqlite.close();
  });

  it('revisits exact identities after a duplicate is tombstoned', async () => {
    const f = await fixture();
    const settle = async () => {
      while ((await runTelemetryWork(f.e.db, NOW)).more) {}
    };
    await f.start('lead');
    await f.start('duplicate');
    await f.start('duplicate', 'proj_2');
    const exact = telemetryTrace('lead', 'duplicate');
    for (const span of exact.resourceSpans[0]!.scopeSpans[0]!.spans) span.traceId = telemetryId(99, 32);
    await f.send(exact);
    await settle();
    expect((await invocationsForSession(f.e.db, 'proj_1', 'duplicate')).rows).toEqual([]);
    await tombstoneSession(f.env, { projectId: 'proj_2' }, 'duplicate', 'mem_fixture', NOW, 'test deletion');
    await settle();
    expect((await invocationsForSession(f.e.db, 'proj_1', 'duplicate')).rows).toHaveLength(1);
    f.e.sqlite.close();
  });
});
