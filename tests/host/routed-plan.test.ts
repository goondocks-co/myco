/**
 * Tests for the host RECEIVE side of the routed plan-content companion push
 * (plan C7 — `host/routed-plan.ts`).
 *
 * Two layers:
 *  - the wire contract (validation, projectId-from-tenancy, error mapping),
 *    exercised with an injected sink so no DB is needed; and
 *  - the DEFAULT sink against a real in-memory Grove DB, which proves the
 *    load-bearing property: a re-push of the same plan does NOT duplicate — the
 *    row upserts by logical key `(session, normalized plan_path)` (idempotency).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createRoutedPlanHandler, type RoutedPlanSink } from '@myco/host/routed-plan';
import type { RouteRequest } from '@myco/daemon/router';
import type { MycoRequestContext } from '@myco/grove/request-context';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { listPlansBySession } from '@myco/db/queries/plans.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const req = (body: unknown, requestContext?: MycoRequestContext): RouteRequest => ({
  body,
  query: {},
  params: {},
  pathname: '/routed-capture/plan',
  requestContext,
});

/** A minimal routed request context (member tenancy claims → host Grove bind). */
const ctx = (groveId: string | undefined, projectId: string): MycoRequestContext =>
  ({ groveId, projectId } as unknown as MycoRequestContext);

// ---------------------------------------------------------------------------
// Wire contract — injected sink, no DB
// ---------------------------------------------------------------------------

describe('POST /routed-capture/plan handler (C7 wire contract)', () => {
  test('accepts a valid body, calls the sink with the tenancy-resolved projectId, returns 200 { ok, plan_id }', async () => {
    const calls: Array<{ sessionId: string; planPath: string; content: string; projectId: string | null }> = [];
    const sink: RoutedPlanSink = (input) => { calls.push(input); return { id: 'plan_abc123' }; };
    const handler = createRoutedPlanHandler({ sink });

    const res = await handler(req({
      machine_id: 'alice_a1b2c3d4',
      session_id: 'sess-1',
      plan_path: '/home/alice/.claude/plans/sprint.md',
      content: '# Sprint\n\nDo the thing.',
      agent: 'claude-code',
    }, ctx('grove_0123456789abcdef0123456789abcdef', 'proj_0123456789abcdef0123456789abcdef')));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, plan_id: 'plan_abc123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      sessionId: 'sess-1',
      planPath: '/home/alice/.claude/plans/sprint.md',
      content: '# Sprint\n\nDo the thing.',
      projectId: 'proj_0123456789abcdef0123456789abcdef',
    });
  });

  test('a request with no grove tenancy resolves projectId to null (ambient scope)', async () => {
    let seen: string | null | undefined;
    const sink: RoutedPlanSink = (input) => { seen = input.projectId; return { id: 'p' }; };
    const handler = createRoutedPlanHandler({ sink });
    await handler(req({ machine_id: 'm', session_id: 's', plan_path: '/p.md', content: 'x' }));
    expect(seen).toBeNull();
  });

  test('a malformed body → 400 invalid_body (missing field, empty plan_path, non-string content)', async () => {
    const handler = createRoutedPlanHandler({ sink: () => ({ id: 'p' }) });
    for (const bad of [
      { session_id: 's', plan_path: '/p.md', content: 'x' }, // missing machine_id
      { machine_id: 'm', session_id: 's', plan_path: '', content: 'x' }, // empty plan_path
      { machine_id: 'm', session_id: 's', plan_path: '/p.md', content: 123 }, // non-string content
    ]) {
      const res = await handler(req(bad));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error: 'invalid_body' });
    }
  });

  test('a sink failure → 500 capture_failed (never throws into the router)', async () => {
    const handler = createRoutedPlanHandler({ sink: () => { throw new Error('db down'); } });
    const res = await handler(req({ machine_id: 'm', session_id: 's', plan_path: '/p.md', content: 'x' }));
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: 'capture_failed', message: 'db down' });
  });
});

// ---------------------------------------------------------------------------
// Default sink + real Grove DB — a routed plan lands host-side, idempotently
// ---------------------------------------------------------------------------

describe('POST /routed-capture/plan default sink (host capturePlan, idempotent)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  const now = () => Math.floor(Date.now() / 1000);

  test('a routed session plan push persists a plan row on the host Grove DB', async () => {
    const sessionId = 'routed-plan-lands';
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now(), created_at: now() });
    const handler = createRoutedPlanHandler();

    const res = await handler(req({
      machine_id: 'alice_a1b2c3d4',
      session_id: sessionId,
      plan_path: '/home/alice/.claude/plans/lands.md',
      content: '# Lands\n\nProof it persists.',
    }));

    expect(res.status).toBe(200);
    const plans = listPlansBySession(sessionId, ALL_PROJECTS_SCOPE);
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Lands');
    expect(plans[0].content).toBe('# Lands\n\nProof it persists.');
    expect(plans[0].source_path).toBe('/home/alice/.claude/plans/lands.md');
  });

  test('a re-push of the SAME plan is a no-op — one row, not a duplicate (idempotent by logical key)', async () => {
    const sessionId = 'routed-plan-idem';
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now(), created_at: now() });
    const handler = createRoutedPlanHandler();
    const body = {
      machine_id: 'alice_a1b2c3d4',
      session_id: sessionId,
      plan_path: '/home/alice/.claude/plans/idem.md',
      content: '# Idem\n\nv1',
    };

    const r1 = await handler(req(body));
    const r2 = await handler(req(body)); // replay (lost-ack retry)
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect((r1.body as { plan_id: string }).plan_id).toBe((r2.body as { plan_id: string }).plan_id);
    expect(listPlansBySession(sessionId, ALL_PROJECTS_SCOPE)).toHaveLength(1);
  });

  test('a re-push of CHANGED content upserts the SAME row (last-write-wins, still one plan)', async () => {
    const sessionId = 'routed-plan-update';
    upsertSession({ id: sessionId, agent: 'claude-code', started_at: now(), created_at: now() });
    const handler = createRoutedPlanHandler();
    const base = {
      machine_id: 'alice_a1b2c3d4',
      session_id: sessionId,
      plan_path: '/home/alice/.claude/plans/update.md',
    };

    await handler(req({ ...base, content: '# Plan\n\nv1' }));
    await handler(req({ ...base, content: '# Plan\n\nv2 (edited)' }));

    const plans = listPlansBySession(sessionId, ALL_PROJECTS_SCOPE);
    expect(plans).toHaveLength(1);
    expect(plans[0].content).toBe('# Plan\n\nv2 (edited)');
  });
});
