import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerAgent } from '@myco/db/queries/agents';
import { insertGraphEdge } from '@myco/db/queries/graph-edges';
import { upsertSession } from '@myco/db/queries/sessions';
import { insertSpore } from '@myco/db/queries/spores';
import { DEFAULT_AGENT_ID } from '@myco/constants';
import { handleGetGraph, handleGetGraphSeeds } from '@myco/daemon/api/mycelium';
import type { RouteRequest } from '@myco/daemon/router';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';

const NOW = Math.floor(Date.now() / 1000);

function makeReq(pathname: string, params: Record<string, string> = {}, query: Record<string, string> = {}): RouteRequest {
  return { pathname, params, query, body: undefined };
}

describe('mycelium API handlers', () => {
  beforeAll(() => {
    setupTestDb();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: NOW });
  });

  afterAll(() => {
    teardownTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: NOW });
  });

  it('returns lightweight graph seeds with a recommended node', async () => {
    upsertSession({
      id: 'sess-1',
      agent: 'claude-code',
      created_at: NOW - 20,
      started_at: NOW - 20,
      ended_at: NOW - 5,
      status: 'completed',
      title: 'Graph redesign',
      summary: 'Worked on the focused explorer flow.',
    });
    insertSpore({
      id: 'spore-1',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'discovery',
      content: 'Focused graph startup should not require loading the full graph first.',
      created_at: NOW - 1,
      status: 'active',
    });

    const result = await handleGetGraphSeeds(makeReq('/graph/seeds'));
    const body = result.body as { seeds: Array<{ id: string; type: string }>; recommended_id: string | null };

    expect(body.seeds.length).toBeGreaterThan(0);
    expect(body.recommended_id).toBe(body.seeds[0]?.id ?? null);
    expect(body.seeds.map((seed) => seed.type)).toEqual(expect.arrayContaining(['spore', 'session']));
  });

  it('returns a centered session neighborhood with lineage edges', async () => {
    upsertSession({
      id: 'sess-graph',
      agent: 'claude-code',
      created_at: NOW - 30,
      started_at: NOW - 30,
      ended_at: NOW - 10,
      status: 'completed',
      title: 'Session center',
      summary: 'Centered graph test.',
    });
    insertSpore({
      id: 'spore-lineage',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'decision',
      content: 'Chose lineage-only visualization over agent-built semantic edges.',
      session_id: 'sess-graph',
      created_at: NOW - 5,
      status: 'active',
    });
    insertGraphEdge({
      agent_id: DEFAULT_AGENT_ID,
      source_id: 'spore-lineage',
      source_type: 'spore',
      target_id: 'sess-graph',
      target_type: 'session',
      type: 'FROM_SESSION',
      created_at: NOW - 5,
    });

    const result = await handleGetGraph(makeReq('/graph/sess-graph', { id: 'sess-graph' }, { depth: '1' }));
    const body = result.body as {
      center: { id: string; type: string; name: string };
      nodes: Array<{ id: string; type: string }>;
      edges: Array<{ source_id: string; target_id: string; label: string }>;
    };

    expect(body.center).toMatchObject({ id: 'sess-graph', type: 'session', name: 'Session center' });
    expect(body.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'spore-lineage', type: 'spore' })]));
    expect(body.edges).toEqual(expect.arrayContaining([expect.objectContaining({ source_id: 'spore-lineage', target_id: 'sess-graph', label: 'FROM_SESSION' })]));
  });
});
