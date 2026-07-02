/**
 * Tests for GET /api/agent/runs/:id/events — the polling endpoint the
 * daemon UI uses to read harness hook events incrementally (via ?since=).
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';

mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

// Capture the original module so the mock below can delegate to real
// behavior while also recording the options `listRunEvents` was called
// with — the seam needed to assert the endpoint passes a cap without
// inserting thousands of rows (too slow / not meaningful for a unit test).
import * as __orig_agent_run_events from '@myco/db/queries/agent-run-events.js';
const __real_agent_run_events = { ...__orig_agent_run_events };
const listRunEventsCalls: Array<{ runId: string; options: Record<string, unknown> }> = [];

mock.module('@myco/db/queries/agent-run-events.js', () => ({
  ...__real_agent_run_events,
  listRunEvents: (runId: string, options: Record<string, unknown>) => {
    listRunEventsCalls.push({ runId, options });
    return __real_agent_run_events.listRunEvents(runId, options as any);
  },
}));

import { setupTestDb, teardownTestDb } from '../../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertRunEvent } from '@myco/db/queries/agent-run-events.js';
import { createAgentRunHandlers, AGENT_RUN_EVENTS_LIMIT } from '@myco/daemon/api/agent-runs.js';
import type { DaemonLogger } from '@myco/daemon/logger.js';
import { TEST_REQUEST_CONTEXT, makeTestRequestContext } from '../../helpers/request-context';

const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, `agent-${id}`, epochNow());
}

const noopLogger: DaemonLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as unknown as DaemonLogger;

describe('GET /api/agent/runs/:id/events', () => {
  beforeEach(() => {
    listRunEventsCalls.length = 0;
    setupTestDb();
    createAgent('agent-1');
    insertRun({ id: 'run-1', agent_id: 'agent-1', status: 'running', started_at: epochNow() });
  });

  afterEach(() => {
    teardownTestDb();
  });

  it('returns 404 for an unknown run id', async () => {
    const handlers = createAgentRunHandlers({
      vaultDir: '/tmp/nonexistent',
      resolveEmbeddingManager: () => ({} as any),
      logger: noopLogger,
    });
    const response = await handlers.handleGetRunEvents({
      params: { id: 'no-such-run' }, query: {}, body: undefined, pathname: '', headers: {},
      requestContext: TEST_REQUEST_CONTEXT,
    } as any);
    expect(response.status).toBe(404);
  });

  it('returns all events for a run when no since param is given', async () => {
    insertRunEvent({ runId: 'run-1', eventType: 'phase_start', phaseName: 'gather' });
    insertRunEvent({ runId: 'run-1', eventType: 'phase_end', phaseName: 'gather', outcome: 'success' });

    const handlers = createAgentRunHandlers({
      vaultDir: '/tmp/nonexistent',
      resolveEmbeddingManager: () => ({} as any),
      logger: noopLogger,
    });
    const response = await handlers.handleGetRunEvents({
      params: { id: 'run-1' }, query: {}, body: undefined, pathname: '', headers: {},
      requestContext: TEST_REQUEST_CONTEXT,
    } as any);

    expect(response.status).toBeUndefined(); // default 200
    const body = response.body as { events: unknown[]; count: number };
    expect(body.count).toBe(2);
    expect(body.events).toHaveLength(2);
  });

  it('returns only events after ?since=<id>', async () => {
    const firstId = insertRunEvent({ runId: 'run-1', eventType: 'phase_start', phaseName: 'gather' });
    insertRunEvent({ runId: 'run-1', eventType: 'phase_end', phaseName: 'gather', outcome: 'success' });

    const handlers = createAgentRunHandlers({
      vaultDir: '/tmp/nonexistent',
      resolveEmbeddingManager: () => ({} as any),
      logger: noopLogger,
    });
    const response = await handlers.handleGetRunEvents({
      params: { id: 'run-1' }, query: { since: String(firstId) }, body: undefined, pathname: '', headers: {},
      requestContext: TEST_REQUEST_CONTEXT,
    } as any);

    const body = response.body as { events: Array<{ event_type: string }>; count: number };
    expect(body.count).toBe(1);
    expect(body.events[0].event_type).toBe('phase_end');
  });

  it('passes the AGENT_RUN_EVENTS_LIMIT cap to listRunEvents without truncating a small result set', async () => {
    // Inserting AGENT_RUN_EVENTS_LIMIT + 1 rows to prove truncation would be
    // slow and not meaningfully more informative than asserting the handler
    // passes the cap through — the cap constant is exported specifically so
    // this seam is testable without a slow fixture. Assert both: (1) the
    // real listRunEvents call received the cap, and (2) a small, realistic
    // result set (well under the cap) is returned unaffected.
    insertRunEvent({ runId: 'run-1', eventType: 'phase_start', phaseName: 'gather' });
    insertRunEvent({ runId: 'run-1', eventType: 'pre_tool_use', phaseName: 'gather', toolName: 'vault_report' });
    insertRunEvent({ runId: 'run-1', eventType: 'post_tool_use', phaseName: 'gather', toolName: 'vault_report', outcome: 'success' });

    const handlers = createAgentRunHandlers({
      vaultDir: '/tmp/nonexistent',
      resolveEmbeddingManager: () => ({} as any),
      logger: noopLogger,
    });
    const response = await handlers.handleGetRunEvents({
      params: { id: 'run-1' }, query: {}, body: undefined, pathname: '', headers: {},
      requestContext: TEST_REQUEST_CONTEXT,
    } as any);

    expect(listRunEventsCalls).toHaveLength(1);
    expect(listRunEventsCalls[0].options.limit).toBe(AGENT_RUN_EVENTS_LIMIT);

    const body = response.body as { events: unknown[]; count: number };
    expect(body.count).toBe(3);
    expect(body.events).toHaveLength(3);
  });

  it('returns 404 for a run belonging to a different project scope', async () => {
    // Run belongs to proj_b, but request context is proj_a
    const db = getDatabase();
    db.prepare(`UPDATE agent_runs SET project_id = ? WHERE id = ?`).run('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'run-1');

    const handlers = createAgentRunHandlers({
      vaultDir: '/tmp/nonexistent',
      resolveEmbeddingManager: () => ({} as any),
      logger: noopLogger,
    });
    // Caller asserts they're from proj_a with Grove binding
    const projAContext = makeTestRequestContext({
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      groveId: 'grove-test',
      tenancySource: 'caller',
    });
    const response = await handlers.handleGetRunEvents({
      params: { id: 'run-1' }, query: {}, body: undefined, pathname: '', headers: {},
      requestContext: projAContext,
    } as any);
    expect(response.status).toBe(404);
  });
});
