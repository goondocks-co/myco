import { useQuery } from '@tanstack/react-query';
import { fetchJson } from '../lib/api';

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

export interface SporeSummary {
  id: string;
  observation_type: string;
  status: string;
  importance: number | null;
  content: string;
  session_id: string | null;
  curator_id: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
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
  depth: number;
}

export interface GraphResponse {
  center: GraphNode;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface DigestTier {
  tier: number;
  content: string;
  generated_at: number;
  curator_id: string | null;
}

export interface DigestResponse {
  tiers: DigestTier[];
}

/* ---------- Hooks ---------- */

export function useSpores(filters?: {
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.type) params.set('type', filters.type);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters?.offset !== undefined) params.set('offset', String(filters.offset));
  const qs = params.toString();
  const path = qs ? `/spores?${qs}` : '/spores';

  return useQuery<SporesResponse>({
    queryKey: ['spores', filters],
    queryFn: ({ signal }) => fetchJson<SporesResponse>(path, { signal }),
    staleTime: SPORES_STALE_TIME,
  });
}

export function useSpore(id: string | undefined) {
  return useQuery<SporeDetail>({
    queryKey: ['spore', id],
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

  return useQuery<EntitiesResponse>({
    queryKey: ['entities', options],
    queryFn: ({ signal }) => fetchJson<EntitiesResponse>(path, { signal }),
    staleTime: ENTITIES_STALE_TIME,
  });
}

export function useGraph(entityId: string | undefined, depth: number = 1) {
  return useQuery<GraphResponse>({
    queryKey: ['graph', entityId, depth],
    queryFn: ({ signal }) =>
      fetchJson<GraphResponse>(`/graph/${entityId}?depth=${depth}`, { signal }),
    enabled: entityId !== undefined,
    staleTime: GRAPH_STALE_TIME,
  });
}

export function useDigest(curatorId?: string) {
  const path = curatorId
    ? `/digest?curator_id=${encodeURIComponent(curatorId)}`
    : '/digest';

  return useQuery<DigestResponse>({
    queryKey: ['digest', curatorId],
    queryFn: ({ signal }) => fetchJson<DigestResponse>(path, { signal }),
    staleTime: DIGEST_STALE_TIME,
  });
}
