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

  it('recommends the most-connected node over a freshly-completed orphan session', async () => {
    // Fresh session with no spores extracted yet — the kind of empty-canvas
    // default the old "newest completed session" heuristic landed on.
    upsertSession({
      id: 'sess-fresh-orphan',
      agent: 'claude-code',
      created_at: NOW - 1,
      started_at: NOW - 1,
      ended_at: NOW,
      status: 'completed',
      title: 'Just finished, nothing extracted',
    });

    // Older session with three spores linked via FROM_SESSION — a well-connected
    // hub the new heuristic should prefer.
    upsertSession({
      id: 'sess-rich-hub',
      agent: 'claude-code',
      created_at: NOW - 1000,
      started_at: NOW - 1000,
      ended_at: NOW - 900,
      status: 'completed',
      title: 'Old but well-connected',
    });
    for (const sporeId of ['spore-a', 'spore-b', 'spore-c']) {
      insertSpore({
        id: sporeId,
        agent_id: DEFAULT_AGENT_ID,
        observation_type: 'decision',
        content: `decision ${sporeId}`,
        session_id: 'sess-rich-hub',
        created_at: NOW - 500,
        status: 'active',
      });
      insertGraphEdge({
        agent_id: DEFAULT_AGENT_ID,
        source_id: sporeId,
        source_type: 'spore',
        target_id: 'sess-rich-hub',
        target_type: 'session',
        type: 'FROM_SESSION',
        created_at: NOW - 500,
      });
    }

    const result = await handleGetGraphSeeds(makeReq('/graph/seeds'));
    const body = result.body as { recommended_id: string | null };

    expect(body.recommended_id).toBe('sess-rich-hub');
  });

  it('falls back to seed order when no edges exist', async () => {
    upsertSession({
      id: 'sess-empty',
      agent: 'claude-code',
      created_at: NOW - 10,
      started_at: NOW - 10,
      ended_at: NOW - 5,
      status: 'completed',
      title: 'No edges yet',
    });

    const result = await handleGetGraphSeeds(makeReq('/graph/seeds'));
    const body = result.body as { recommended_id: string | null };

    expect(body.recommended_id).toBe('sess-empty');
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
