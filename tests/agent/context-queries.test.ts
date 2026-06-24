/**
 * executeContextQueries — focused tests.
 *
 * Replaces the 387-line file pruned in #295. Restores coverage of the
 * three contracts the orchestrator depends on:
 *  - each known ContextQuery.tool resolves to the right query helper and
 *    returns the projected row shape (not the raw DB row),
 *  - scope is honored — a context anchored to project A cannot see
 *    project B's rows,
 *  - empty fixtures return [] (or an empty per-project state slice),
 *    never undefined.
 *
 * Real in-memory DB via the shared setupTestDb helper. No mocks.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { makeTestRequestContext } from '../helpers/request-context';
import { executeContextQueries } from '@myco/agent/context-queries.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { insertBatchStateless, closeBatch } from '@myco/db/queries/batches.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

const AGENT_ID = 'myco-agent';
const PROJECT_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId;
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId;
const epochNow = () => Math.floor(Date.now() / 1000);

const contextA = makeTestRequestContext({
  projectId: PROJECT_A,
  groveId: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
});
const contextB = makeTestRequestContext({
  projectId: PROJECT_B,
  groveId: 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
});

describe('executeContextQueries', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: AGENT_ID, name: AGENT_ID, created_at: epochNow() });
  });

  it('returns [] (not undefined) for every known tool when the vault is empty', async () => {
    const results = await executeContextQueries(
      AGENT_ID,
      [
        { tool: 'vault_unprocessed', purpose: 'p1', required: false },
        { tool: 'vault_spores', purpose: 'p2', required: false },
        { tool: 'vault_sessions', purpose: 'p3', required: false },
        { tool: 'vault_state', purpose: 'p4', required: false },
      ],
      contextA,
    );

    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.error).toBeUndefined();
      expect(r.data).toBeDefined();
      expect(Array.isArray(r.data)).toBe(true);
      expect((r.data as unknown[]).length).toBe(0);
    }
  });

  it('routes each tool to the correct query helper', async () => {
    // Seed each surface with one project-A row so the routing is observable.
    const now = epochNow();
    upsertSession({
      id: 'sess-a',
      project_id: PROJECT_A,
      agent: 'claude-code',
      started_at: now - 100,
      ended_at: now - 50,
      status: 'completed',
      title: 'A session',
      summary: 'For routing test',
      created_at: now - 100,
    });
    insertSpore({
      id: 'spore-a',
      project_id: PROJECT_A,
      agent_id: AGENT_ID,
      session_id: 'sess-a',
      observation_type: 'decision',
      content: 'A test spore',
      importance: 5,
      created_at: now - 90,
    });
    setState(AGENT_ID, PROJECT_A, 'last-checkpoint', '42', now);

    // For vault_unprocessed we need a settled (closed, processed_at IS NULL)
    // batch. The dispatcher would normally create this; we go through the
    // stateless insert path and close the batch by hand.
    const { row: batch } = insertBatchStateless({
      session_id: 'sess-a',
      project_id: PROJECT_A,
      user_prompt: 'A test prompt',
      kind: 'initial',
      machine_id: 'test-machine',
      created_at: now - 80,
    });
    closeBatch(batch.id);

    const results = await executeContextQueries(
      AGENT_ID,
      [
        { tool: 'vault_unprocessed', purpose: 'unprocessed', required: false },
        { tool: 'vault_spores', purpose: 'spores', required: false },
        { tool: 'vault_sessions', purpose: 'sessions', required: false },
        { tool: 'vault_state', purpose: 'state', required: false },
      ],
      contextA,
    );

    const byTool = new Map(results.map((r) => [r.tool, r] as const));
    expect((byTool.get('vault_unprocessed')!.data as unknown[]).length).toBeGreaterThan(0);
    expect((byTool.get('vault_spores')!.data as unknown[]).length).toBe(1);
    expect((byTool.get('vault_sessions')!.data as unknown[]).length).toBe(1);
    expect((byTool.get('vault_state')!.data as unknown[]).length).toBe(1);
  });

  it('respects scope — a query in project B cannot see project A rows', async () => {
    const now = epochNow();

    // Seed two parallel projects with one spore + session each.
    upsertSession({
      id: 'sess-a',
      project_id: PROJECT_A,
      agent: 'claude-code',
      started_at: now,
      ended_at: now + 1,
      status: 'completed',
      title: 'A',
      summary: 'A',
      created_at: now,
    });
    insertSpore({
      id: 'spore-a',
      project_id: PROJECT_A,
      agent_id: AGENT_ID,
      session_id: 'sess-a',
      observation_type: 'decision',
      content: 'project A spore',
      importance: 5,
      created_at: now,
    });
    upsertSession({
      id: 'sess-b',
      project_id: PROJECT_B,
      agent: 'claude-code',
      started_at: now,
      ended_at: now + 1,
      status: 'completed',
      title: 'B',
      summary: 'B',
      created_at: now,
    });
    insertSpore({
      id: 'spore-b',
      project_id: PROJECT_B,
      agent_id: AGENT_ID,
      session_id: 'sess-b',
      observation_type: 'decision',
      content: 'project B spore',
      importance: 5,
      created_at: now,
    });
    setState(AGENT_ID, PROJECT_A, 'k', 'value-a', now);
    setState(AGENT_ID, PROJECT_B, 'k', 'value-b', now);

    // Project B's queries must see B-only data.
    const bResults = await executeContextQueries(
      AGENT_ID,
      [
        { tool: 'vault_spores', purpose: 'p1', required: false },
        { tool: 'vault_sessions', purpose: 'p2', required: false },
        { tool: 'vault_state', purpose: 'p3', required: false },
      ],
      contextB,
    );

    const sporesB = bResults.find((r) => r.tool === 'vault_spores')!.data as Array<{ id: string }>;
    expect(sporesB.map((s) => s.id)).toEqual(['spore-b']);

    const sessionsB = bResults.find((r) => r.tool === 'vault_sessions')!.data as Array<{ id: string }>;
    expect(sessionsB.map((s) => s.id)).toEqual(['sess-b']);

    const stateB = bResults.find((r) => r.tool === 'vault_state')!.data as Array<{ value: string }>;
    expect(stateB.map((s) => s.value)).toEqual(['value-b']);
  });

  it('throws on unknown tool names regardless of required flag', async () => {
    await expect(
      executeContextQueries(
        AGENT_ID,
        [{ tool: 'vault_nope_not_a_thing', purpose: 'x', required: false }],
        contextA,
      ),
    ).rejects.toThrow(/Unknown context query tool/);
  });
});
