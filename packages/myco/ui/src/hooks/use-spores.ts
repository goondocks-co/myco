import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';
import { POLL_INTERVALS } from '../lib/constants';
import { useProjectScopedQueryKey } from './use-project-selection';
import { usePowerQuery } from './use-power-query';

/* ---------- Constants ---------- */

/** Cache TTL for spore list (15 seconds). */
const SPORES_STALE_TIME = 15_000;

/** Cache TTL for spore detail (30 seconds). */
const SPORE_DETAIL_STALE_TIME = 30_000;

/** Cache TTL for entity list (30 seconds). */
const ENTITIES_STALE_TIME = 30_000;

/** Cache TTL for graph data (30 seconds). */
const GRAPH_STALE_TIME = 30_000;

/** Cache TTL for digest extracts (60 seconds). */
const DIGEST_STALE_TIME = 60_000;

/* ---------- Types ---------- */

export interface SporeReleaseState {
  state: string;
  confidence?: string | null;
  basis_kind?: string | null;
  basis_ref?: string | null;
  checked_at?: number;
  reason?: string | null;
}

export interface SporeSummary {
  id: string;
  observation_type: string;
  status: string;
  importance: number | null;
  content: string;
  session_id: string | null;
  agent_id: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
  release_state?: SporeReleaseState;
}

export interface SporeDetail extends SporeSummary {
  context: string | null;
  successor_id: string | null;
  predecessor_id: string | null;
}

export interface SporesResponse {
  spores: SporeSummary[];
  total: number;
  offset: number;
  limit: number;
}

export interface EntitySummary {
  id: string;
  name: string;
  type: string;
  mentions: number;
  first_seen: number;
  last_seen: number;
}

export interface EntitiesResponse {
  entities: EntitySummary[];
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  label: string;
  weight: number;
}

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  depth?: number;
  // Extended fields for Inspector
  status?: string;
  created_at?: number;
  content?: string;
  properties?: string;
  mention_count?: number;
  observation_type?: string;
}

export interface GraphResponse {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphSeedResponse {
  seeds: GraphNode[];
  recommended_id: string | null;
}

export interface DigestTier {
  tier: number;
  content: string;
  generated_at: number;
  agent_id: string | null;
}

export interface DigestResponse {
  tiers: DigestTier[];
}

/* ---------- Hooks ---------- */

export function useSpores(filters?: {
  type?: string;
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
  session_id?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.type) params.set('type', filters.type);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
  if (filters?.session_id) params.set('session_id', filters.session_id);
  const qs = params.toString();
  const path = qs ? `/spores?${qs}` : '/spores';

  return usePowerQuery<SporesResponse>({
    queryKey: ['spores', filters],
    queryFn: ({ signal }) => fetchJson<SporesResponse>(path, { signal }),
    staleTime: SPORES_STALE_TIME,
    pollCategory: 'standard',
    refetchInterval: POLL_INTERVALS.SPORES,
  });
}

export function useSpore(id: string | undefined) {
  const queryKey = useProjectScopedQueryKey(['spore', id]);
  return useQuery<SporeDetail>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<SporeDetail>(`/spores/${id}`, { signal }),
    enabled: id !== undefined,
    staleTime: SPORE_DETAIL_STALE_TIME,
  });
}

export function useEntities(options?: { mentioned_in?: string; note_type?: string }) {
  const params = new URLSearchParams();
  if (options?.mentioned_in) params.set('mentioned_in', options.mentioned_in);
  if (options?.note_type) params.set('note_type', options.note_type);
  const qs = params.toString();
  const path = qs ? `/entities?${qs}` : '/entities';
  const queryKey = useProjectScopedQueryKey(['entities', options]);

  return useQuery<EntitiesResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<EntitiesResponse>(path, { signal }),
    staleTime: ENTITIES_STALE_TIME,
  });
}

export function useGraph(entityId: string | undefined, depth: number = 1, enabled: boolean = true) {
  const queryKey = useProjectScopedQueryKey(['graph', entityId, depth]);
  return useQuery<GraphResponse>({
    queryKey,
    queryFn: ({ signal }) =>
      fetchJson<GraphResponse>(`/graph/${entityId}?depth=${depth}`, { signal }),
    enabled: enabled && entityId !== undefined,
    staleTime: GRAPH_STALE_TIME,
  });
}

export interface FullGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function useFullGraph(enabled: boolean = true) {
  const queryKey = useProjectScopedQueryKey(['full-graph']);
  return useQuery<FullGraphResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<FullGraphResponse>('/graph', { signal }),
    enabled,
    staleTime: GRAPH_STALE_TIME,
  });
}

export function useGraphSeeds() {
  const queryKey = useProjectScopedQueryKey(['graph-seeds']);
  return useQuery<GraphSeedResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<GraphSeedResponse>('/graph/seeds', { signal }),
    staleTime: GRAPH_STALE_TIME,
  });
}

export function useDigest(agentId?: string) {
  const path = agentId
    ? `/digest?agent_id=${encodeURIComponent(agentId)}`
    : '/digest';
  const queryKey = useProjectScopedQueryKey(['digest', agentId]);

  return useQuery<DigestResponse>({
    queryKey,
    queryFn: ({ signal }) => fetchJson<DigestResponse>(path, { signal }),
    staleTime: DIGEST_STALE_TIME,
  });
}
