/**
 * myco_graph — traverse connections between vault notes via entities and edges.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GraphInput {
  note_id: string;
  direction?: 'incoming' | 'outgoing' | 'both';
  depth?: number;
}

interface GraphEdge {
  source_id: string;
  target_id: string;
  type: string;
  confidence: number;
}

interface GraphResult {
  note_id: string;
  edges: GraphEdge[];
  entities: Array<{ id: string; type: string; name: string }>;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoGraph(
  input: GraphInput,
  client: DaemonClient,
): Promise<GraphResult> {
  const params = new URLSearchParams();
  if (input.direction) params.set('direction', input.direction);
  if (input.depth !== undefined) params.set('depth', String(input.depth));

  const qs = params.toString();
  const base = `/api/graph/${encodeURIComponent(input.note_id)}`;
  const endpoint = qs ? `${base}?${qs}` : base;
  const result = await client.get(endpoint);

  if (!result.ok || !result.data) {
    return { note_id: input.note_id, edges: [], entities: [] };
  }

  // The daemon graph endpoint returns { center, nodes, edges, depth }
  // Map to the MCP tool's expected shape
  const data = result.data;
  return {
    note_id: input.note_id,
    edges: (data.edges ?? []) as GraphEdge[],
    entities: (data.nodes ?? []) as Array<{ id: string; type: string; name: string }>,
  };
}
